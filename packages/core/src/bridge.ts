// The editor side of the relay connection: a WebSocket server on localhost that forwards tool
// calls to the controller, and the discovery file that lets relays find it.

import { randomBytes, timingSafeEqual } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import {
  BATCH_STATUSES,
  PROTOCOL_VERSION,
  ToolError,
  type Action,
  type Discovery,
  type EditorMessage,
  type RelayMessage,
  type ToolName,
} from "@ai-pair/protocol"
import type { Controller } from "./controller"

export type BridgeOptions = {
  /** Where discovery files live; see `discoveryDir()`. */
  dir: string
  workspaceFolders: () => string[]
  /** The largest message a relay may send, in bytes. Defaults to `DEFAULT_MAX_PAYLOAD`. */
  maxPayload?: number
}

/** Generous for any report or batch of typing, yet bounded: frames arrive before authentication. */
export const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024

export class Bridge {
  private server?: WebSocketServer
  private readonly token = randomBytes(24).toString("hex")
  private port = 0
  private lastFocused = Date.now()
  /** The relay connection whose agent started the current (or last) session. */
  private owner: WebSocket | null = null

  constructor(
    private readonly controller: Controller,
    private readonly options: BridgeOptions,
  ) {}

  get file(): string {
    return path.join(this.options.dir, `${process.pid}.json`)
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    const address = server.address()
    this.port = typeof address === "object" && address ? address.port : 0
    server.on("connection", (ws) => this.accept(ws))
    this.writeDiscovery()
  }

  /**
   * Changes the largest message a relay may send. ws reads it at each upgrade, so it applies to
   * connections made from now on, without restarting the server or dropping a session; a relay
   * already connected keeps the limit it connected with.
   */
  setMaxPayload(bytes: number): void {
    if (this.server) this.server.options.maxPayload = bytes
  }

  /** Call when the window gains focus, so relays prefer it among windows with the same folder. */
  focused(): void {
    this.lastFocused = Date.now()
    this.writeDiscovery()
  }

  /** Call when the workspace folders change. */
  writeDiscovery(): void {
    if (!this.server) return
    const discovery: Discovery = {
      pid: process.pid,
      workspaceFolders: this.options.workspaceFolders(),
      port: this.port,
      token: this.token,
      protocolVersion: PROTOCOL_VERSION,
      lastFocused: this.lastFocused,
    }
    fs.mkdirSync(this.options.dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(this.file, JSON.stringify(discovery), { mode: 0o600 })
  }

  dispose(): void {
    try {
      fs.unlinkSync(this.file)
    } catch {
      // Already gone.
    }
    for (const client of this.server?.clients ?? []) client.terminate()
    this.server?.close()
    this.server = undefined
  }

  private accept(ws: WebSocket): void {
    let authenticated = false
    const calls = new Map<number, AbortController>()
    const send = (m: EditorMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }
    const reject = (reason: string) => {
      send({ type: "rejected", reason })
      ws.close()
    }
    const helloTimer = setTimeout(() => ws.terminate(), 5000)
    // Invalid frames and oversized payloads are emitted as socket errors by ws.
    ws.on("error", () => ws.terminate())

    ws.on("message", (data) => {
      let value: unknown
      try {
        value = JSON.parse(String(data))
      } catch {
        value = undefined
      }
      if (!authenticated) {
        // Only a cheap check before the token is: deeper validation would let any local process make us work.
        if (!hello(value)) {
          reject("Invalid pairing message.")
        } else if (!this.tokenMatches(value.token)) {
          reject("Authentication failed.")
        } else if (value.protocolVersion !== PROTOCOL_VERSION) {
          reject(
            `Protocol version mismatch (editor ${PROTOCOL_VERSION}, relay ${value.protocolVersion}). The extension was updated: reload the VS Code window and restart the agent.`,
          )
        } else {
          authenticated = true
          clearTimeout(helloTimer)
          send({ type: "welcome" })
        }
        return
      }
      // An authenticated relay's malformed message ends neither its session nor its other calls:
      // a call gets an error, anything else is dropped.
      if (!relayMessage(value)) {
        if (object(value) && value.type === "call" && callId(value.id) && !calls.has(value.id)) {
          send({ type: "error", id: value.id, code: "invalid_arguments", message: "Invalid call." })
        }
        return
      }
      const m = value
      if (m.type === "cancel") {
        calls.get(m.id)?.abort()
      } else if (m.type === "return") {
        if (this.owner === ws) this.controller.restore(m.report)
      } else if (m.type === "call") {
        if (calls.has(m.id)) {
          reject("A call with this ID is already pending.")
          return
        }
        const abort = new AbortController()
        calls.set(m.id, abort)
        this.dispatch(ws, m.tool, m.args ?? {}, abort.signal)
          .then(
            (result) => send({ type: "result", id: m.id, result }),
            (e: unknown) =>
              send({
                type: "error",
                id: m.id,
                code: e instanceof ToolError ? e.code : "internal",
                message: e instanceof Error ? e.message : String(e),
              }),
          )
          .finally(() => calls.delete(m.id))
      }
    })

    ws.on("close", () => {
      clearTimeout(helloTimer)
      for (const abort of calls.values()) abort.abort()
      if (this.owner === ws) {
        this.owner = null
        this.controller.disconnect()
      }
    })
  }

  private async dispatch(ws: WebSocket, tool: ToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const c = this.controller
    if (tool === "start") {
      if (c.isActive && this.owner !== ws) {
        throw new ToolError("session_active", "Another agent is already pairing in this editor window.")
      }
      const report = await c.start(optionalString(args.task), optionalString(args.cwd))
      this.owner = ws
      return report
    }
    if (this.owner !== ws) {
      throw new ToolError("no_session", "No pairing session is active. Call `start` to begin one.")
    }
    switch (tool) {
      case "step":
        if (!Array.isArray(args.actions)) throw new ToolError("invalid_arguments", "`actions` must be an array.")
        return c.step(args.actions as Action[], signal)
      case "listen":
        return c.listen(signal)
      case "end":
        return c.end(optionalString(args.summary), signal)
      case "read":
        if (typeof args.file !== "string") throw new ToolError("invalid_arguments", "`file` must be a string.")
        return c.read(args.file, optionalNumber(args.from_line), optionalNumber(args.to_line))
      default:
        throw new ToolError("invalid_arguments", `Unknown tool: ${String(tool)}`)
    }
  }

  private tokenMatches(token: unknown): boolean {
    if (typeof token !== "string") return false
    const a = Buffer.from(token)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

function hello(value: unknown): value is Extract<RelayMessage, { type: "hello" }> {
  return object(value) && value.type === "hello" && typeof value.token === "string" && typeof value.protocolVersion === "number"
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function callId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

/** An authenticated relay's message. A call's tool isn't checked here: `dispatch` answers unknown ones. */
function relayMessage(value: unknown): value is RelayMessage {
  if (!object(value)) return false
  switch (value.type) {
    case "cancel":
      return callId(value.id)
    case "call":
      return callId(value.id) && typeof value.tool === "string" && (value.args === undefined || object(value.args))
    case "return":
      return returnedReport(value.report)
    default:
      return false
  }
}

/** Returned reports are inserted into controller state, so validate their consumed fields too. */
function returnedReport(value: unknown): boolean {
  if (!object(value) || (value.turn !== "agent" && value.turn !== "user")) return false
  return Array.isArray(value.batches) && value.batches.every((batch: unknown) => {
    if (!object(batch) || !callId(batch.id) || !(BATCH_STATUSES as readonly unknown[]).includes(batch.status)) return false
    if (batch.code !== undefined && !code(batch.code)) return false
    return true
  }) && Array.isArray(value.events) && value.events.every((event: unknown) => {
    if (!object(event)) return false
    switch (event.kind) {
      case "message": return typeof event.text === "string"
      case "edit": return typeof event.file === "string" && typeof event.diff === "string" && (event.by === "programmer" || event.by === "other")
      case "turn": return (event.to === "agent" || event.to === "user") && (event.message === undefined || typeof event.message === "string")
      case "interrupt":
      case "end": return true
      default: return false
    }
  })
}

function code(value: unknown): boolean {
  return object(value) && typeof value.file === "string" && Array.isArray(value.lines) &&
    value.lines.every((line: unknown) => object(line) && callId(line.number) && typeof line.text === "string")
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function optionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
