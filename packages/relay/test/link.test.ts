import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { PROTOCOL_VERSION } from "@ai-pair/protocol"
import { EditorLink } from "../src/link"

let dir: string
const servers: WebSocketServer[] = []
const links: EditorLink[] = []
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-link-")) })
afterEach(async () => {
  for (const link of links.splice(0)) link.close()
  for (const server of servers.splice(0)) {
    for (const ws of server.clients) ws.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

async function window(name: string, focused: number, connected: (ws: WebSocket) => void): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  server.on("connection", connected)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server port")
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    pid: process.pid, workspaceFolders: ["/project"], port: address.port,
    token: "test", protocolVersion: PROTOCOL_VERSION, lastFocused: focused,
  }))
  return server
}

function link(): EditorLink {
  const value = new EditorLink("/project", dir)
  links.push(value)
  return value
}

it("does not connect or send a pre-cancelled call", async () => {
  let connections = 0
  await window("editor", 1, () => { connections++ })
  const abort = new AbortController()
  abort.abort()
  await expect(link().call("start", {}, abort.signal)).rejects.toMatchObject({ code: "cancelled" })
  expect(connections).toBe(0)
})

it("cancels while awaiting welcome without sending the call or cancelling another waiter", async () => {
  let welcome!: () => void
  let receivedHello!: () => void
  const hello = new Promise<void>((resolve) => { receivedHello = resolve })
  const calls: unknown[] = []
  await window("editor", 1, (ws) => {
    welcome = () => ws.send(JSON.stringify({ type: "welcome" }))
    ws.on("message", (data) => {
      const message = JSON.parse(String(data))
      if (message.type === "hello") receivedHello()
      if (message.type === "call") {
        calls.push(message.args)
        ws.send(JSON.stringify({ type: "result", id: message.id, result: "accepted" }))
      }
    })
  })
  const editor = link()
  const abort = new AbortController()
  const cancelled = editor.call("start", { task: "cancelled" }, abort.signal)
  const rejection = expect(cancelled).rejects.toMatchObject({ code: "cancelled" })
  const other = editor.call("start", { task: "other" })
  await hello
  abort.abort()
  await rejection
  welcome()
  await expect(other).resolves.toBe("accepted")
  expect(calls).toEqual([{ task: "other" }])
})

it.each(["silent", "rejected"])("closes a %s endpoint and falls back to a working editor", async (response) => {
  let silentHello = 0
  let disconnected!: () => void
  const closed = new Promise<void>((resolve) => { disconnected = resolve })
  const silent = await window("stale", 2, (ws) => {
    ws.on("message", () => {
      silentHello++
      if (response === "rejected") ws.send(JSON.stringify({ type: "rejected", reason: "Test rejection" }))
    })
    ws.once("close", disconnected)
  })
  let goodConnections = 0
  await window("good", 1, (ws) => {
    goodConnections++
    ws.on("message", (data) => {
      const message = JSON.parse(String(data))
      if (message.type === "hello") ws.send(JSON.stringify({ type: "welcome" }))
      if (message.type === "call") ws.send(JSON.stringify({ type: "result", id: message.id, result: "fallback" }))
    })
  })
  await expect(link().call("start", {})).resolves.toBe("fallback")
  expect(silentHello).toBe(1)
  expect(goodConnections).toBe(1)
  // The failed candidate is terminated, rather than retained alongside the working socket.
  await closed
  expect(silent.clients.size).toBe(0)
}, 8000)

it.each([false, true])("closes an in-progress handshake cleanly with reconnect=%s", async (reconnect) => {
  let receivedHello!: () => void
  const hello = new Promise<void>((resolve) => { receivedHello = resolve })
  let disconnected!: () => void
  const closed = new Promise<void>((resolve) => { disconnected = resolve })
  const silent = await window("stale", 2, (ws) => {
    ws.on("message", () => receivedHello())
    ws.once("close", disconnected)
  })
  let fallbackConnections = 0
  await window("fallback", 1, (ws) => {
    fallbackConnections++
    ws.on("message", (data) => {
      const message = JSON.parse(String(data))
      if (message.type === "hello") ws.send(JSON.stringify({ type: "welcome" }))
      if (message.type === "call") ws.send(JSON.stringify({ type: "result", id: message.id, result: "reconnected" }))
    })
  })
  const editor = link()
  const pending = editor.call("start", {})
  const rejection = expect(pending).rejects.toMatchObject({ code: "no_editor" })
  await hello
  editor.close()
  fs.unlinkSync(path.join(dir, "stale.json"))
  const restarted = reconnect ? editor.call("start", {}) : undefined
  const recovery = restarted && expect(restarted).resolves.toBe("reconnected")
  await rejection
  await recovery
  await closed
  expect(silent.clients.size).toBe(0)
  expect(fallbackConnections).toBe(reconnect ? 1 : 0)
})

it("tells pending calls why the editor rejected the connection after welcoming it", async () => {
  await window("editor", 1, (ws) => {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data))
      if (message.type === "hello") ws.send(JSON.stringify({ type: "welcome" }))
      if (message.type === "call") {
        ws.send(JSON.stringify({ type: "rejected", reason: "A call with this ID is already pending." }))
        ws.close()
      }
    })
  })
  await expect(link().call("listen", {})).rejects.toMatchObject({
    code: "no_editor",
    message: "The editor ended the connection: A call with this ID is already pending.",
  })
})
