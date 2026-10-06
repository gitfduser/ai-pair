# AI Pair extension audit and repair plan

Date: 2026-10-05
Status: Implemented and validated
Reviewed commit: `0defe983f1b5c554425d0bb0d21cd3e66adb8376`

## Scope and method

Reviewed the full current extension, shared controller/player, MCP relay, protocol,
agent configuration writers, build/release scripts, packaging allowlist and locked
dependencies. Independent correctness, security and performance reviewers produced
candidates, followed by adversarial verification. No production source was changed.

No malicious behavior or explicit external upload path was found in the reviewed
source. This is not a guarantee about every dependency or an installed Marketplace
binary: no existing VSIX was supplied for comparison. The extension's intentional
capabilities include absolute file reads/edits and shell execution through VS Code.
Disabling command confirmation allows execution without the agent harness's usual
approval; the default is confirmation on and the setting is application-scoped.
Interrupt stops playback/waiting, not a running shell process, as documented.

## Findings

### 1. P1 — Edits in another workspace folder do not interrupt playback

Category: Correctness
Location: `packages/vscode/src/editor.ts:356`, `:582`; `packages/vscode/src/extension.ts:15`

The editor captures the first workspace folder as its root. Discovery and path
resolution support all folders, but document change reporting and selection sharing
use only that first root. In sibling roots A and B, a session in B is accepted,
yet a programmer edit in B is discarded before reaching `Controller.userEdit`.
The mirror updates, but player cursor offsets and rehearsed state do not. An
insertion before the agent cursor between keystrokes can make subsequent agent
keystrokes land in the newly inserted text.

Evidence: a focused reproduction calling the actual bundled editor's `onChange`
for `/work/A/x.txt` and `/work/B/x.txt` emitted a controller notification only for
A while the B mirror changed. Independent verification traced session discovery,
player offsets and VS Code edit application; active-editor and selection handlers
do not protect an edit in the same target B document.

Fix design: use the current full set of workspace roots with a proper path containment
helper for workspace membership. Ensure tracked files actively used by a session
also report edits if absolute paths outside those roots remain supported. Account
for folders added/removed during activation. Preserve first-root behavior only as
the fallback for resolving relative paths. Share selections from every supported root.

Validation: a VS Code integration case with unrelated roots A/B, pairing in B and
inserting before the agent cursor during an inter-keystroke delay; assert playback
interrupts, cursor transforms correctly and the edit is reported. Cover selection B.

### 2. P2 — Cancellation during connection is lost

Category: Correctness
Location: `packages/relay/src/link.ts:118`

`call()` awaits `connect()` before installing its abort listener and never checks
`signal.aborted`. Aborting during the handshake (or arriving with a pre-aborted
signal) still transmits the tool call after welcome. No cancel frame follows, and
`pending.cancelled` remains false. A cancelled call can execute and consume a report
that the harness no longer receives. Roots lookup before calling the link introduces
another window for an already-aborted signal.

Evidence: an independent focused reproduction of the exact call method with a
deferred connection and real AbortController showed an aborted signal, a transmitted
step frame, no cancel frame and `pending.cancelled: false`.

Fix design: reject an already-aborted signal before connection and check again
after connection and before sending. Make waiting for a shared connection abortable
per caller without cancelling other callers' shared connection. Register and remove
listeners with a well-defined lifetime, preserving the existing report-return
behavior for a cancellation after a call was sent.

Validation: deferred welcome with abort before welcome; pre-aborted input; abort
during roots lookup; and the existing post-send cancellation/report recovery case.

### 3. P2 — Missing welcome timeout can permanently block the relay

Category: Correctness / availability
Location: `packages/relay/src/link.ts:164`

The configured `ws.handshakeTimeout` bounds HTTP upgrade, not the application-level
hello/welcome exchange. A stale discovery file can point to a live WebSocket service
that upgrades but ignores hello. `openWindow()` then never settles, `open()` never
tries the next valid editor, and retries reuse the unresolved `connecting` promise.
A harness timeout does not release the connection attempt; `close()` only closes a
socket assigned after welcome.

Evidence: an actual WebSocket reproduction remained unsettled after 5.5 seconds,
with one hello received by the silent endpoint, zero connections to the healthy
fallback, and the stale socket still open after abort and `link.close()`. The SDK's
default 60-second client timeout bounds the harness wait but does not release the
cached relay connection attempt.

Fix design: start an application handshake timer for each candidate, settle exactly
once on welcome/rejection/error/close/timeout, clear the timer on settlement and
terminate failed candidate sockets. Track in-progress sockets so disposal closes
them. Proceed to the next matching discovery entry after a candidate timeout.

Validation: a WebSocket endpoint that upgrades and ignores hello, followed by a
healthy editor entry; assert timeout, socket cleanup and successful fallback. Also
test disposal before welcome and rejection without server-initiated close.

### 4. P2 — Unauthenticated malformed JSON values escape the bridge handler

Category: Security / robustness
Location: `packages/core/src/bridge.ts:94`

JSON syntax errors are caught, but parsed values are assumed to be protocol objects.
An unauthenticated local peer can send the valid JSON literal `null`; accessing
`m.type` outside the parsing catch throws synchronously from the message callback.
The exception is verified; actual VS Code extension-host crash impact is not proven.
This is an availability/robustness defect, not an authentication bypass.

Evidence: feeding `null` into the actual bundled Bridge.accept message handler
produced `TypeError: Cannot read properties of null (reading 'type')` before auth.

Fix design: validate a non-null, non-array object envelope before reading fields;
validate each accepted message shape, including call IDs and argument containers.
Reject/close malformed peers without throwing. Handle socket error events and
consider a bounded unauthenticated hello timeout and sensible payload limit.

Validation: null, arrays, primitives, malformed hello/call/cancel/return messages
and normal authenticated traffic; assert no uncaught exception.

### 5. P3 — Retained live narration history has no size bound

Category: Performance
Location: `packages/vscode/src/panelHtml.ts:314`

Every history entry is prepended without pruning. Session transitions archive
messages and add dividers, without clearing old history. `MAX_LOG = 400` in panel.ts
bounds only replay events. Because the webview retains context when hidden, live
rows and their closures grow across long sessions. Growth is proven by source;
no measured slowdown or memory exhaustion is claimed.

Fix design: enforce an explicit bounded number of live history entries, optionally
with a text-size budget. Keep active/pending command UI coherent when pruning and
ensure both replay and live delivery use the same retention policy.

Validation: append many entries and cross session boundaries; assert the cap and
that current narration, command decisions and file links remain functional.

## Verification and limits

- Unit/relay suite: **142 tests passed**, 7 files. Initial sandbox socket restrictions
  were resolved by running the suite with local socket access.
- TypeScript typecheck: passed.
- Extension and relay build: passed.
- npm advisory query of the lockfile: **0 known vulnerabilities**, production and
  development dependencies included. This does not prove dependencies benign.
- Lockfile inspection: registry tarballs use npm registry URLs; local workspace
  links are expected. Install scripts belong to esbuild, fsevents and vsce-sign;
  dependency installation used `--ignore-scripts`.
- Packaging allowlist includes the bundled extension/relay, metadata, README,
  changelog, icon and license (license is copied during production build).
- Webview escaping/CSP, command allowlist, HTTP(S) external link restriction,
  loopback binding, random token and private discovery permissions were reviewed.
- No supplied/installed VSIX binary was compared with source. No source findings
  were classified as malicious intent. The live VS Code integration launcher returned
  exit 0 without the test runner's expected completion output; execution of those
  assertions is therefore unverified and is not counted as a passing check.

## Implementation follow-up

All five findings were fixed in the working tree:

- Every tracked local document reports changes, including other workspace roots
  and absolute paths outside the workspace. Selection sharing uses the current
  workspace folder list rather than the first root captured at activation.
- A call cancelled before/during connection is not sent. Concurrent callers can
  still share a connection, and abort listeners are removed when calls settle.
- The hello/welcome exchange has a five-second deadline; failed candidate sockets
  are terminated before fallback. Closing or relocating a link invalidates its
  in-progress connections without affecting newer calls.
- The bridge validates message envelopes and report fields it consumes, rejects
  malformed peers and duplicate in-flight call IDs, handles socket errors and
  bounds the unauthenticated hello wait.
- Live and replayed narration history retain at most 400 rows. Current narration
  and command confirmation controls remain separate from pruned history.

Validation after implementation: **164 tests passed**; TypeScript typecheck,
build and production packaging passed. Real VS Code integration passed for both
the source development extension and the unpacked production VSIX, including the
new second-folder edit interruption regression and a full MCP relay session.
The local artifact is `ai-pair-0.1.0.vsix`; it has not been published or installed
into the user's normal VS Code profile.

## Checklist

- [x] Fix multi-root/session file change tracking and selection sharing.
- [x] Preserve cancellation before/during connection and roots lookup.
- [x] Bound application handshake and close in-progress candidate sockets.
- [x] Validate bridge message envelopes and handle malformed peers safely.
- [x] Bound retained narration history.
- [x] Run focused regressions, existing tests, typecheck, build and live VS Code
      integration; inspect the production VSIX contents before release.

## Parallel Execution

The editor tracking fix, bridge input validation and narration retention can be
implemented independently. Keep cancellation and handshake changes together because
they share relay connection lifecycle. Integrate before final validation.
