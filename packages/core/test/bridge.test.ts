import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import WebSocket from "ws"
import { PROTOCOL_VERSION } from "@ai-pair/protocol"
import { Bridge } from "../src/bridge"
import { Controller } from "../src/controller"
import { FakeEditor, FakePanel, testConfig } from "./fake"

let dir: string
let bridge: Bridge
let port: number
let token: string
const sockets: WebSocket[] = []
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pair-bridge-"))
  const controller = new Controller(new FakeEditor(), new FakePanel(), testConfig)
  bridge = new Bridge(controller, { dir, workspaceFolders: () => ["/project"] })
  await bridge.start()
  ;({ port, token } = JSON.parse(fs.readFileSync(bridge.file, "utf8")))
})
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject) })
  return ws
}
function message(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))))
}
async function authenticate(ws: WebSocket): Promise<void> {
  const reply = message(ws)
  ws.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION }))
  await expect(reply).resolves.toEqual({ type: "welcome" })
}

it.each(["null", "[]", "42", '"hello"', "{", '{"type":"hello"}']) (
  "rejects malformed unauthenticated input %s without disrupting the server", async (input) => {
    const ws = await connect()
    const reply = message(ws)
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))
    ws.send(input)
    await expect(reply).resolves.toEqual({ type: "rejected", reason: "Invalid pairing message." })
    await closed
    await authenticate(await connect())
  },
)

it.each([
  { type: "call", id: 0, tool: "start", args: {} },
  { type: "call", id: 1, tool: "start", args: [] },
  { type: "cancel", id: "1" },
  { type: "return", report: null },
  { type: "return", report: { turn: "agent", batches: [null], events: [] } },
  { type: "return", report: { turn: "agent", batches: [], events: [null] } },
  { type: "return", report: { turn: "agent", batches: [{ id: 1, status: "completed", code: { file: "x", lines: [null] } }], events: [] } },
])("rejects malformed authenticated envelopes %#", async (input) => {
  const ws = await connect()
  await authenticate(ws)
  const reply = message(ws)
  ws.send(JSON.stringify(input))
  await expect(reply).resolves.toEqual({ type: "rejected", reason: "Invalid pairing message." })
})
