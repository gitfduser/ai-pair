// Finding the right editor window and talking to it. See "Discovery and connection" in ARCHITECTURE.md.

import * as fs from "node:fs"
import * as path from "node:path"
import WebSocket from "ws"
import { PROTOCOL_VERSION, type Discovery, type EditorMessage, type ToolName } from "@ai-pair/protocol"

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

function contains(folder: string, file: string): boolean {
  const rel = path.relative(folder, file)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The first of `folders` inside a live window's workspace folder, and the windows it's in, best
 * first: the most closely containing workspace folder, then the most recently focused window.
 */
export function findWindows(folders: string[], dir: string): { folder: string; windows: Discovery[] } {
  const windows: Discovery[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    // No windows have registered yet.
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Discovery
      if (alive(d.pid)) windows.push(d)
    } catch {
      // Being written, or garbage.
    }
  }

  for (const folder of folders) {
    const here = realpath(folder)
    const matches: { window: Discovery; length: number }[] = []
    for (const window of windows) {
      const lengths = window.workspaceFolders.map(realpath).filter((f) => contains(f, here)).map((f) => f.length)
      if (lengths.length > 0) matches.push({ window, length: Math.max(...lengths) })
    }
    if (matches.length === 0) continue
    matches.sort((a, b) => b.length - a.length || b.window.lastFocused - a.window.lastFocused)
    return { folder, windows: matches.map((m) => m.window) }
  }
  throw new RelayError(
    "no_editor",
    windows.length === 0
      ? `No VS Code window with the AI Pair extension is running. Ask the programmer to open ${folders[0]} in VS Code.`
      : `No VS Code window has ${folders[0]} open. Ask the programmer to open it in VS Code (with the AI Pair extension).`,
  )
}

type Pending = {
  ws: WebSocket
  tool: ToolName
  cancelled: boolean
  cleanup: () => void
  resolve: (result: unknown) => void
  reject: (error: RelayError) => void
}

/** A port a stale window file points at may now belong to something that never answers. */
const HANDSHAKE_MS = 5000

/** Tools whose results are reports, which must be delivered exactly once. */
const REPORTING: ReadonlySet<ToolName> = new Set(["step", "listen", "end"])

/** A lazily (re)connected link to the editor window for the agent's folder, `cwd` until `locate` says otherwise. */
export class EditorLink {
  private ws: WebSocket | null = null
  private connecting: Promise<WebSocket> | null = null
  private readonly sockets = new Set<WebSocket>()
  private generation = 0
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private folder: string

  constructor(
    cwd: string,
    private readonly dir: string,
  ) {
    this.folder = cwd
  }

  /** Links to the window for the first of `folders` that one has open, and returns that folder. */
  locate(folders: string[]): string {
    const { folder } = findWindows(folders, this.dir)
    if (folder !== this.folder) {
      this.close()
      this.folder = folder
    }
    return folder
  }

  async call(tool: ToolName, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new RelayError("cancelled", "The call was cancelled.")
    const ws = await waitForConnection(this.connect(), signal)
    if (signal?.aborted) throw new RelayError("cancelled", "The call was cancelled.")
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.cancelled = true
        if (this.pending.has(id) && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cancel", id }))
      }
      const pending: Pending = {
        ws, tool, cancelled: false, resolve, reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      }
      this.pending.set(id, pending)
      signal?.addEventListener("abort", abort, { once: true })
      try {
        ws.send(JSON.stringify({ type: "call", id, tool, args }))
      } catch (e) {
        this.pending.delete(id)
        pending.cleanup()
        reject(e)
      }
    })
  }

  close(): void {
    this.generation++
    this.ws = null
    this.connecting = null
    for (const ws of this.sockets) ws.terminate()
  }

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws)
    if (!this.connecting) {
      const connecting = this.open(this.generation).finally(() => {
        if (this.connecting === connecting) this.connecting = null
      })
      this.connecting = connecting
    }
    return this.connecting
  }

  /**
   * Tries the matching windows best first. A window's file can outlive it when VS Code didn't shut
   * down cleanly, and its pid can then belong to another process, so an unreachable one is skipped.
   */
  private async open(generation: number): Promise<WebSocket> {
    let first: unknown
    for (const window of findWindows([this.folder], this.dir).windows) {
      if (generation !== this.generation) throw new RelayError("no_editor", "The connection was closed.")
      try {
        return await this.openWindow(window, generation)
      } catch (e) {
        first ??= e
      }
    }
    throw first
  }

  private openWindow(window: Discovery, generation: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${window.port}`, { handshakeTimeout: HANDSHAKE_MS })
      this.sockets.add(ws)
      let welcomed = false
      let failed = false
      const fail = (message: string) => {
        if (welcomed || failed) return
        failed = true
        clearTimeout(timer)
        reject(new RelayError("no_editor", message))
        ws.terminate()
      }
      // ws.handshakeTimeout ends at HTTP upgrade. Also bound hello/welcome.
      const timer = setTimeout(() => fail("The editor did not complete the pairing handshake."), HANDSHAKE_MS)
      const settle = (id: number) => {
        const p = this.pending.get(id)
        if (p?.ws !== ws) return undefined
        this.pending.delete(id)
        p.cleanup()
        return p
      }
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "hello", token: window.token, protocolVersion: PROTOCOL_VERSION }))
      })
      ws.on("message", (data) => {
        if (failed) return
        let m: EditorMessage
        try {
          const value: unknown = JSON.parse(String(data))
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid message")
          m = value as EditorMessage
        } catch {
          fail("The editor sent an invalid message.")
          return
        }
        if (m.type === "welcome") {
          if (welcomed) return
          if (generation !== this.generation) return fail("The connection was closed.")
          welcomed = true
          clearTimeout(timer)
          this.ws = ws
          resolve(ws)
        } else if (m.type === "rejected") {
          fail(m.reason)
        } else if (welcomed && m.type === "result") {
          const p = settle(m.id)
          // The call returned before our cancellation reached the editor, so the agent will never
          // see this report. Hand it back to be delivered with the next one.
          if (p?.cancelled && REPORTING.has(p.tool)) ws.send(JSON.stringify({ type: "return", report: m.result }))
          p?.resolve(m.result)
        } else if (welcomed && m.type === "error") {
          settle(m.id)?.reject(new RelayError(m.code, m.message))
        }
      })
      ws.on("error", (e) => {
        if (!welcomed) fail(`Couldn't connect to the editor: ${e.message}`)
      })
      ws.on("close", () => {
        clearTimeout(timer)
        this.sockets.delete(ws)
        if (this.ws === ws) this.ws = null
        if (!welcomed) fail("The editor closed the connection.")
        for (const [id, p] of this.pending) {
          if (p.ws !== ws) continue
          this.pending.delete(id)
          p.cleanup()
          p.reject(new RelayError("no_editor", "The editor disconnected. If its window was reloaded, start a new session."))
        }
      })
    })
  }
}

/** A caller's cancellation must not abort other callers' shared connection attempt. */
function waitForConnection(connection: Promise<WebSocket>, signal?: AbortSignal): Promise<WebSocket> {
  if (!signal) return connection
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RelayError("cancelled", "The call was cancelled."))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    void connection.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
