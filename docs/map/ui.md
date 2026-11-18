# `ui/`: the UI core

**Purpose.** What every graphical front end shares: the shapes of what a view shows, the messages between the controller and the views, and the logic that is not drawing. The first front end is a VS Code extension (`extensions/vscode/`, not yet written). Reasons: ADR 35.

**Depends on:** `src/` (schemas), `@preact/signals-core` (state models), and `harness/` as types only. `ui/model/` imports no Node or DOM API and is typechecked without Node types, so it can run in a webview as well as in the extension host.

## Layers

```
views            Preact + signals models: draw view-models, send intents     (extensions/vscode, a browser page)
  │  events ▲ │ intents
controller       owns the conversations, maps harness state to messages       ui/controller/  (not yet written)
  │
harness/         conversations, turns, tools
```

State that matters is in the controller. A view that opens sends `ready` and gets a snapshot; it then follows events. Intents say what the person did (`thread.rewind`, `chat.send`); the controller carries them out.

## Files

| File | Role |
|---|---|
| `model/graph.ts` | `GraphData`: threads (kind, status, tip, fork point) and commits placed on them. Status is `idle`, `running`, `awaiting`, `error` or `elsewhere` (held by another process). |
| `model/transcript.ts` | `Block`: what the chat draws of a transcript (user, assistant, reasoning, tool, notice, turn end). A tool call and its result are one block. A committed block carries its commit hash, the anchor for rewind and fork. |
| `model/chat.ts` | `ChatState`: one open thread: header, blocks, status bar, composer, pending approval, banner, model choice and its settings form. |
| `model/form.ts` | `FormSpec`: a JSON Schema, a value and the issues found. One shape for the model settings sheet and the `harness.yml` editor; the view builds fields from the schema and the controller validates. |
| `model/protocol.ts` | `UiEvent` (controller to view) and `UiIntent` (view to controller) as TypeBox schemas, with `parseEvent` and `parseIntent`. Both are validated where received. |
| `model/graph-layout.ts` | `layoutGraph`: rows newest first, lanes packed (a merged thread gives its lane up), edges (a fork bends at its parent, a merge at its child), and runs of tool calls and results folded into one row unless expanded. A commit another thread points at is never hidden inside a fold. |
| `model/graph-actions.ts` | `deletionImpact` and `deleteDialog` (what deleting a thread takes out of reach, and the words of the confirmation, including how to recover it from the reflog), `canDragThread` and `canDropOn` (whether a thread can be picked up and dropped on another to merge it, with the reason when not); `canSwitch` (whether the workspace can move to a thread: both it and the thread being left must be idle); `actionsFor`: which of open, fork, rewind, merge and switch a commit offers, and why one is unavailable (a thread that is working, waiting or held by another window is not rewound or merged). |
| `model/graph-model.ts` | `GraphModel`, a signal model: data, expanded folds, selection, context menu, the repositories of the workspace and the picker's state (`selectRepo` refuses one that holds no conversation; `newThread` and the archived switch (`withoutArchived` leaves archived threads, and the commits only they own, out of the layout: `shown` is what is drawn; `archive`/`unarchive` are menu actions, refused for the trunk, the checked-out thread and one that is working); `initRepo` starts one in a folder whose `RepoEntry.init` says it can be, at once for `new` and after the `initDialog` question for `adopt`, a folder already inside a git repository), the thread waiting for a delete confirmation, `switching` (the uncommitted files a workspace switch is waiting on: `confirmSwitch(remember)` or `cancelSwitch`), the thread being dragged and the thread it is over (`startDrag`, `dragOver`, `drop`, which sends `thread.merge`), the commit under the pointer and `lit` (that commit, or the one a menu is open on, and its thread: a thread is what a click selects, a commit is what the menu and the jump into the chat apply to) and the layout derived from them; `apply` takes events, actions send intents. |
| `model/chat-model.ts` | `ChatModel`, a signal model: the open thread, blocks, status, composer, approval, `banner` (why the thread cannot take a message: `no_provider`, or `untrusted` because its `harness.yml` is not the one approved, which `trust()` answers with `thread.trust`; `canSend` is false meanwhile), models and the settings form; derived `busy`, `canSend`, `contextFraction`; `reveal` (the block to scroll to and ping, set by `chat.reveal`, which the controller sends when a commit is picked in the graph, naming the nearest commit that has a block); actions send, stop, attach, approve, choose model, rewind, fork; `openFile` (a plain click follows the `fileClick` setting, `current` or `after`; a block with no commit yet can only open the current file) and the right-click `fileMenu`. Whether a block is open follows a default (reasoning while streaming, a failed or waiting tool) that the person's toggle inverts. |
| `model/form-model.ts` | `FormModel` and `formFields`: turns a `FormSpec` schema into a field tree (string, number, boolean, choice, list, group, map, raw; a map is `additionalProperties` or the one `patternProperties` entry a record is written with), applies edits locally (`set`, `remove`, `replace` for an edit that changes several places) and sends `form.edit`, `form.save` (with a commit message when the form is committed), `form.revert`; `issues` by path. |
| `model/config-sheet.ts` | What the `harness.yml` editor knows beyond the schema, as plain functions: the pages and which page a path is on (`pageOf`, `issueCounts`), the provider adapters (labels, hints, a new provider, changing the adapter), the approvals table (every `tools.<name>.allow` and `mcp.<server>.allow` grant as a row with its expiry state at a given time; add, rename, change date, remove) and how an MCP server is reached. |
| `model/settings.ts` | What the settings sheet shows that is not in `harness.yml`: `ProviderStatus` (checking, ok, error), the models a provider lists (`ModelInfo`, or why it cannot), and the thread's instruction files with the well-known ones found in the workspace. |
| `model/config-model.ts` | `ConfigModel`: whether the settings sheet is open (it replaces the transcript), the page, the commit message; makes the file's `FormModel` when the controller first sends it, counts problems per page, refuses to save while there are any. Asks for each provider's check when the Providers page opens and for its models when the Subagents page does (once; the buttons ask again); a check is stale once the provider's settings differ from when it was made. Instruction files are not saved with the file: each change is an intent and applies to the thread at once. |
| `model/file-ref.ts` | `parseFileRef`: a Markdown link target that is a workspace-relative path, with `#L42` or `#L42-L58`, is a file reference; a scheme, a bare fragment, an absolute path or `..` is not. `refLabel` for the text. The system prompt tells the model to write references this way; the view turns each into a button that sends `file.open`. |
| `model/tool-view.ts` | `toolView`: the shape a tool call is drawn in. `edit`, `write`, `read`, `run` and `script` are worked out from their arguments and from the text of their results (the edit result's removed, unchanged and added lines become diff hunks; before the result, the hunk comes from the arguments); every other tool, MCP tools included, is `generic` (arguments and result as text). |
| `fixtures/mock-controller.ts` | `MockController`: answers every intent (`repo.init` makes a trunk with only its header, a harness.yml with no providers and opens the sheet on the Providers page with `settings.open`) with scripted behaviour (a fake turn with streaming, an approval and a failing tool; stop, queue, fork, rewind, merge, model change, settings validation). Its events are checked against the protocol schemas by `mock-validate.ts`. |
| `host/web-host.ts` | `startWebHost`: a controller behind a loopback HTTP server: events and intents as JSON on one WebSocket (same origin only; intents are checked with `parseIntent`), one directory of built files served; `log` records what passed. For a browser tab and the end-to-end tests (`test/e2e/`). Node only. |
| `fixtures/` | Deterministic mock data (a graph with every thread state, a chat session, the config form) for the mock extension and the tests. `harness-schema.ts` is the harness's own JSON Schema, generated by `tools/gen-ui-schema.ts` (a test fails when it is stale); `mock-validate.ts` checks a value against it the way the mock needs (ranges, patterns, `oneOf` by `$tag`, `required`). `mock-settings.ts` is what the mock "finds" on the machine: which providers answer, their model lists and the workspace's instruction files. |

## Invariants

- Everything in `ui/model/` is plain JSON data, so it crosses a webview boundary unchanged.
- An unknown figure (price, context limit) is absent, never zero.
- A view never decides what a rewind, fork or merge does; it names the anchor.

## To change X

- *Show something new in the chat:* add a block type (or a field) in `model/transcript.ts`, then the mapping in the controller and the view.
- *Add an action:* add an intent to `model/protocol.ts` and an example to `test/ui/model.test.ts` (the test fails until every message has one).
- *Add a field to a form:* nothing in `ui/`; the schema comes from the harness. For `harness.yml`, regenerate `fixtures/harness-schema.ts` (`node --no-warnings tools/gen-ui-schema.ts`, then `pnpm format`); a setting that no page shows lands in the problem banner, so give it a page in `model/config-sheet.ts` (`pageOf`) and a control in `webview/config/pages.tsx`.
