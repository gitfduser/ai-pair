// The panel's page is a template literal holding a script: an escape lost in the template (a `\b`
// in a regex, say) only shows as a panel that stays blank. Parse the script as the webview would.

import { expect, it } from "vitest"
import { panelHtml, SPEEDS } from "../src/panelHtml"

it("has a page script that parses", () => {
  const html = panelHtml("vscode-resource:")
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  expect(scripts).toHaveLength(1)
  expect(() => new Function(scripts[0]!)).not.toThrow()
})

it("offers the speeds with one decimal, so they line up", () => {
  const html = panelHtml("vscode-resource:")
  for (const s of SPEEDS) expect(html).toContain(`data-speed="${s}">${s.toFixed(1)}×</button>`)
})

it("gives controls the panel's own tooltips, since native ones show unreliably in a webview", () => {
  const html = panelHtml("vscode-resource:")
  expect(html).not.toMatch(/\stitle=|\.title = /)
  expect(html).toContain('data-tip="Interrupt"')
})

it("bounds live and replayed history while keeping current narration and command decisions", () => {
  class Element {
    children: Element[] = []
    parent?: Element
    innerHTML = ""
    textContent = ""
    dataset: Record<string, string> = {}
    style = { setProperty() {} }
    classList = { add() {}, remove() {}, toggle() {} }
    onclick?: () => void
    get childElementCount() { return this.children.length }
    get lastElementChild() { return this.children.at(-1)! }
    prepend(el: Element) { el.parent = this; this.children.unshift(el) }
    append(...elements: Element[]) { for (const el of elements) { el.parent = this; this.children.push(el) } }
    replaceChildren(...elements: Element[]) { this.children = []; this.append(...elements) }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) }
    querySelectorAll() { return [] }
    addEventListener() {}
    setAttribute() {}
  }
  const elements = new Map<string, Element>()
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  let receive!: (message: { data: unknown }) => void
  const posted: unknown[] = []
  const document = {
    getElementById: get, createElement: () => new Element(),
    body: new Element(), documentElement: new Element(), addEventListener() {},
  }
  const window = { addEventListener: (type: string, callback: typeof receive) => { if (type === "message") receive = callback } }
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panelHtml("vscode-resource:"))![1]!
  new Function("document", "window", "acquireVsCodeApi", script)(document, window, () => ({ postMessage: (event: unknown) => posted.push(event) }))
  const send = (data: unknown) => receive({ data })
  send({ type: "replay", events: Array.from({ length: 600 }, (_, i) => ({ type: "user", text: `replay ${i}` })) })
  expect(get("history").children).toHaveLength(400)
  send({ type: "session", active: true })
  send({ type: "say", text: "current narration" })
  send({ type: "run", id: 7, command: "echo hello", phase: "confirm" })
  for (let i = 0; i < 1000; i++) send({ type: "user", text: `live ${i}` })
  expect(get("history").children).toHaveLength(400)
  expect(get("history").children[0]!.innerHTML).toBe("live 999")
  expect(get("history").lastElementChild.innerHTML).toBe("live 600")
  expect(get("now-text").innerHTML).toBe("current narration")
  get("run-go").onclick!()
  expect(posted.at(-1)).toEqual({ type: "runDecision", id: 7, run: true, remember: false })
  send({ type: "session", active: false, reason: "user" })
  send({ type: "session", active: true })
  expect(get("history").children).toHaveLength(400)
})
