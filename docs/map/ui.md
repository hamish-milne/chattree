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
| `model/chat.ts` | `ChatState`: one open thread: header, blocks, status bar, composer, pending approval, model choice and its settings form. |
| `model/form.ts` | `FormSpec`: a JSON Schema, a value and the issues found. One shape for the model settings sheet and the `harness.yml` editor; the view builds fields from the schema and the controller validates. |
| `model/protocol.ts` | `UiEvent` (controller to view) and `UiIntent` (view to controller) as TypeBox schemas, with `parseEvent` and `parseIntent`. Both are validated where received. |
| `model/graph-layout.ts` | `layoutGraph`: rows newest first, lanes packed (a merged thread gives its lane up), edges (a fork bends at its parent, a merge at its child), and runs of tool calls and results folded into one row unless expanded. A commit another thread points at is never hidden inside a fold. |
| `model/graph-actions.ts` | `actionsFor`: which of open, fork, rewind and merge a commit offers, and why one is unavailable (a thread that is working, waiting or held by another window is not rewound or merged). |
| `model/graph-model.ts` | `GraphModel`, a signal model: data, expanded folds, selection, context menu and the layout derived from them; `apply` takes events, actions send intents. |
| `model/chat-model.ts` | `ChatModel`, a signal model: the open thread, blocks, status, composer, approval, models and the settings form; derived `busy`, `canSend`, `contextFraction`; actions send, stop, attach, approve, choose model, rewind, fork. Whether a block is open follows a default (reasoning while streaming, a failed or waiting tool) that the person's toggle inverts. |
| `model/form-model.ts` | `FormModel` and `formFields`: turns a `FormSpec` schema into a field tree (string, number, boolean, choice, list, group, map, raw), applies edits locally and sends `form.edit`, `form.save`, `form.revert`. |
| `fixtures/mock-controller.ts` | `MockController`: answers every intent with scripted behaviour (a fake turn with streaming, an approval and a failing tool; stop, queue, fork, rewind, merge, model change, settings validation). Its events are checked against the protocol schemas by `mock-validate.ts`. |
| `fixtures/` | Deterministic mock data (a graph with every thread state, a chat session, the config form) for the mock extension and the tests. |

## Invariants

- Everything in `ui/model/` is plain JSON data, so it crosses a webview boundary unchanged.
- An unknown figure (price, context limit) is absent, never zero.
- A view never decides what a rewind, fork or merge does; it names the anchor.

## To change X

- *Show something new in the chat:* add a block type (or a field) in `model/transcript.ts`, then the mapping in the controller and the view.
- *Add an action:* add an intent to `model/protocol.ts` and an example to `test/ui/model.test.ts` (the test fails until every message has one).
- *Add a field to a form:* nothing in `ui/`; the schema comes from the harness.
