# `cli/`: the command-line host

**Purpose.** The `chattree` command: a host over the harness library. It finds the project, builds the tool set, drives a session through an engine, and renders output for a terminal or a pipe. The library knows nothing of terminals; everything about them is here. Reasons: ADR 30.

**Depends on:** `harness/`, `providers/`, `localmodels/`, `src/`. Entry: `cli/chattree.ts` (wires real process I/O into `main`).

## Layers

- **Entry and I/O.** `chattree.ts` calls `main.ts`, which parses argv. Verbs that need no thread (`init`, `settings`, `models`, `run`, `chat`) are handled in `main.ts`; every other verb becomes a slash-command line sent through the same `Engine` a session uses, so a verb and its in-session command cannot differ. `io.ts` is the only place that touches the real process, so everything else runs in-process under fake I/O in tests.
- **Engine** (`engine.ts`): holds what a session keeps (draft, history, staged files, preferences), the current thread, its tool set and the pump for other threads. Commands and hosts drive it through `submit` and a stream of `Output` values (`output.ts`).
- **Commands** (`commands/`): one file per group, each registering handlers in the table (`registry.ts`). A command declares its name, summary, argument parser, whether it may run while a request is in flight, and any staged state it owns. A command that stages something must register a `show` and a `clear`; the registry refuses one that does not.
- **Terminal** (`terminal.ts`, `prompt.ts`): the only code that reads keys; `prompt.ts` holds the prompt rules with no tty in them.

## Files

| File | Role |
|---|---|
| `main.ts`, `chattree.ts`, `io.ts` | Entry, argv, process boundary. |
| `chat.ts`, `terminal.ts`, `prompt.ts` | `chat` setup, the readline terminal layer (paste, completion, spinner, Ctrl keys, questions), and the prompt rules. |
| `engine.ts`, `output.ts`, `turn.ts` | The session engine, what it says, and one streamed request shared by `/say`, `/retry`, `/continue`. Library refusals (`ChangeNotAllowed`, limits) become questions here. |
| `session.ts` | Session files (draft, named drafts, staged attachments, thread pointer) under the git dir, written with the canonical emitter, with a heartbeat lock. |
| `toolset.ts`, `skills.ts`, `changes.ts` | Build the tools a session offers (built-ins, thread and job tools, accepted MCP servers); keeping skills in step with disk; running a setup change that needs the user's yes. How calls look is `app/tool-lines.ts`. |
| `models.ts` | `chattree models`. (The settings file, the provider registry and `init` are in [`app/`](app.md).) |
| `run.ts`, `recent.ts`, `refs.ts`, `export.ts`, `environment.ts`, `mime.ts`, `age.ts`, `oneshot.ts`, `registry.ts` | `chattree run` (the headless pump), the recap on open, naming entries, Markdown export, the machine description given to the model, attachment type detection, display helpers, a re-export of the one-shot call, the command table and tokenizer. |
| `commands/` | `chat`, `drafts`, `exec`, `mcp`, `meta`, `misc`, `read`, `search`, `sessions`, `settings`, `setup`, `skills`, `threads`, `tools`, `trust`, `undo`; `index.ts` lists them in `/help` order. |

## Invariants

- Everything a person typed or staged but not sent lives in the session, never in the transcript.
- A session points at a thread; a thread does not own sessions. A crashed terminal resumes the earliest unlocked session on that thread.
- `/exec` runs outside the conversation: no model, no approval, no entry.
- Secrets are only environment variable names; the CLI never prints or stores a key.

## To change X

- *Add a command:* a handler in the group file it belongs to in `commands/`, added to the table in `commands/index.ts`; register `show` and `clear` if it stages state; add a table test over `submit(line)` (`test/cli/`). Document it in `docs/guide/commands.md`.
- *Add a built-in tool:* `toolset.ts` (see [Extending: tools](../extending/tools.md)).
- *Change what the terminal does with keys:* `terminal.ts`; keep the rules that need no tty in `prompt.ts`.
- *Change how a library refusal is shown:* `turn.ts` and `changes.ts`.
