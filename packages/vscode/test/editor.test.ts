import { beforeEach, expect, it, vi } from "vitest"
import type { Controller } from "@ai-pair/core"

const mock = vi.hoisted(() => ({
  folders: [] as { uri: { fsPath: string } }[],
  documents: [] as unknown[],
  visible: [] as unknown[],
  active: undefined as unknown,
  changed: undefined as ((event: unknown) => void) | undefined,
}))
vi.mock("vscode", () => {
  const subscribe = () => ({ dispose() {} })
  return {
    ThemeColor: class { constructor(public id: string) {} },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    workspace: {
      get workspaceFolders() { return mock.folders },
      get textDocuments() { return mock.documents },
      onDidOpenTextDocument: subscribe,
      onDidCloseTextDocument: subscribe,
      onDidChangeTextDocument: (callback: (event: unknown) => void) => { mock.changed = callback; return subscribe() },
    },
    window: {
      get visibleTextEditors() { return mock.visible },
      get activeTextEditor() { return mock.active },
      createTextEditorDecorationType: subscribe,
      onDidCloseTerminal: subscribe,
      onDidChangeActiveTextEditor: subscribe,
      onDidChangeTextEditorVisibleRanges: subscribe,
      onDidChangeVisibleTextEditors: subscribe,
      onDidChangeTextEditorSelection: subscribe,
    },
  }
})
import { VsCodeEditor } from "../src/editor"

beforeEach(() => {
  mock.folders = [{ uri: { fsPath: "/work/A" } }, { uri: { fsPath: "/work/B" } }]
  mock.documents = []
  mock.visible = []
  mock.active = undefined
  mock.changed = undefined
})

it.each(["/work/A/x.txt", "/work/B/x.txt", "/outside/x.txt"])(
  "reports programmer edits in tracked file %s", (file) => {
    let text = "hello"
    const doc = { uri: { scheme: "file", fsPath: file }, isDirty: true, getText: () => text }
    mock.documents = [doc]
    const editor = new VsCodeEditor("/work/A", "Agent")
    const userEdit = vi.fn()
    editor.controller = { userEdit } as unknown as Controller
    text = "// mine\nhello"
    mock.changed!({ document: doc, contentChanges: [{ rangeOffset: 0, rangeLength: 0, text: "// mine\n" }] })
    expect(userEdit).toHaveBeenCalledWith(file, "hello", text, [{ offset: 0, deleteLength: 0, text: "// mine\n" }])
    editor.dispose()
  },
)

it("shares selections from every current workspace root, including folders added later", () => {
  mock.folders = [{ uri: { fsPath: "/work/A" } }]
  const document = { uri: { scheme: "file", fsPath: "/work/B/x.txt" }, getText: () => "hello" }
  const selected = { document, setDecorations() {}, selection: { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }
  mock.active = selected
  mock.visible = [selected]
  const editor = new VsCodeEditor("/work/A", "Agent")
  expect(editor.programmerSelection()).toBeUndefined()
  mock.folders.push({ uri: { fsPath: "/work/B" } })
  expect(editor.programmerSelection()?.file).toBe("/work/B/x.txt")
  mock.folders.pop()
  expect(editor.programmerSelection()).toBeUndefined()
  editor.dispose()
})
