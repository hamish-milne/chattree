# The CLI host (draft plan)

Status: **draft for discussion, not committed.** The CLI is the first consumer of the harness library. It is a host: it owns the terminal, the user's files and the process, and it makes the decisions the library deliberately leaves to hosts (when to confirm a change, how to show a warning, what to do when a provider fails). Nothing in `harness/` should learn that a terminal exists.

## 1. Shape

```
cli/
  main.ts          argv -> verb; the only file that touches process.argv / exit codes
  project.ts       find the project, init it, list threads (worktrees)
  session.ts       the session engine: state, command dispatch, activity; no I/O of its own
  commands/        one file per command group; each registers handlers (see 4)
  render.ts        entries and stream events -> styled text; knows nothing about the tty
  terminal.ts      the tty: line editing, history, completion, spinner, bracketed paste
  session-store.ts cli sessions on disk (see 3)
```

Three layers, so that tests and a later TUI or web host reuse the middle one:

- **Engine** (`session.ts`, `commands/`): `engine.submit(line) -> AsyncIterable<Output>`. Pure of the tty; tests drive it with strings and read `Output` values (`text`, `entry`, `stream_delta`, `activity`, `warning`, `confirm`, ...).
- **Renderer** (`render.ts`): `Output -> string`, with a plain mode (no colour, no spinner) used for pipes, `NO_COLOR` and golden tests.
- **Terminal** (`terminal.ts`): the only code that reads keys. A `Terminal` interface with a fake for tests.

Dependencies: none beyond the repository's (`node:readline`, `node:util` `parseArgs`). Needs Node >= 22.18 as the rest does; the `chattree` command in `package.json` `bin` points at `cli/main.ts` (type stripping, no build).

## 2. Project and thread

**Project** = a git working tree that contains `harness.yml`. Detection starts at `-C <dir>` (or the working directory) and walks up. The nearest ancestor that is a git top level decides: if it has `harness.yml` that is the project; if it does not, stop with "not initialised, run `chattree init`". It never climbs across a repository boundary (a nested repo must not silently adopt its parent's conversation).

**Thread** = a branch, and each thread lives in its own worktree (the library's model: `chat.yml` is one file per worktree, forks and subagents already get worktrees). The thread a command acts on is the branch checked out in the worktree where it was started, i.e. "inferred from git HEAD". Consequences:

- A detached HEAD is an error that says how to fix it; the CLI never guesses a thread.
- Threads are never switched by changing HEAD in a worktree that something else may be using. `chattree chat <thread>` opens that branch's worktree (creating it if needed, under `.chattree/threads/<branch>/`, which is already ignored) and runs there.
- `/thread <name>` inside a session rebinds the session to that worktree.

`init` (see 5) creates the repository's first thread. Decision needed: in an *existing* repository with history, `init` should put the conversation on a new branch (`chat/main`, from HEAD), not on the user's working branch, because the conversation commits and snapshots would otherwise be interleaved with their own commits.

## 3. Sessions and persistent state

A **session** is one running CLI process attached to one thread. Everything a user has typed or staged but not sent lives in the session, never in the transcript:

- the half-typed prompt, the prompt history for the session, attachments staged for the next prompt, and any other "affects the next prompt" state;
- the thread it is bound to, and the display preferences chosen with commands.

Storage: one JSON file per session at `<git-common-dir>/chattree/cli/sessions/<ulid>.json`, next to the request journal. That directory is shared by all worktrees of the repository, is not part of the working tree (nothing for `git status` to show or for a commit to sweep up), and survives deleting a thread's worktree. It is rewritten atomically (`writeAtomic`) when the state changes, with typing debounced to about once a second and flushed on `SIGINT`, `SIGTERM` and `SIGHUP`; a hard crash loses at most the last second of typing. A snapshot file is simpler than the journal-style `jsonl` the idea suggested, because the state is small and has no history worth replaying.

Locking: `<ulid>.lock` using `src/lock.ts` with a heartbeat, like the journal. Starting a session resumes the **earliest unlocked session bound to this thread** (so a crashed or closed terminal comes back with its draft); with none, it creates one. `--session <id>` and `--new-session` override; `/sessions` lists them. A session whose state is empty is deleted on exit; one with pending state is kept. A session is never resumed for another thread than the one inferred from the working directory, so a draft does not appear somewhere surprising.

Several sessions on one thread, and sessions on different threads, are both supported. That depends on library work (section 7).

## 4. The prompt

A line starting with `/` is a command: `/name args...`, arguments split shell-style (quotes, backslash escapes). Anything else is sent as `/say <the line>`. To say text that starts with a slash, use `/say /text` (or `//text`). An unknown command is an error and is never sent to the model.

Multi-line input: bracketed paste is taken as one input (a pasted block must never send itself line by line); a trailing `\` continues the line; `/edit` opens `$VISUAL`/`$EDITOR` on the draft. Ctrl-C clears the line (twice, or Ctrl-D on an empty line, exits); history is per session and persisted with it. Tab completes command names, thread names, file paths for `/attach`, and setting keys.

A command is declared with: its name and aliases, a one-line summary, an argument parser, `busy: "allowed" | "blocked"` (whether it may run while a request is in flight; `blocked` commands say why), and optionally the **state** it owns.

**The rule for state:** any command that stages something for the next prompt must register the state it owns with a `show` and a `clear`, and the registry refuses a command that does not. So `/attach` comes with `/attachments` (show) and `/detach` (remove one or all); the draft comes with `/draft show|edit|clear`. `/status` prints all staged state at once.

### Command list (first cut)

Chat

| Command | Does | While a request is running |
|---|---|---|
| `/say <text>` | Send the draft (plus staged attachments); stream the reply. Bare text is this. | blocked |
| `/retry` | Re-run the request when the last entry is a user message with no answer (a provider failure before any content leaves exactly that). | blocked |
| `/continue [text]` | After an `interrupted` reply: `continueInterrupted`, then run the request. | blocked |
| `/abort` | Cancel the in-flight request (see 6). | allowed |
| `/attach <path\|-> [--mime T] [--charset C] [--name N]` | Stage a file. The CLI wrapper detects the media type (extension table, then content sniffing for the common image/PDF magic numbers, then UTF-8 validity) and the harness requires it; `--mime` overrides. | allowed |
| `/attachments` | List staged attachments (name, type, size). | allowed |
| `/detach <n\|all>` | Unstage. | allowed |
| `/draft [show\|edit\|clear]`, `/edit` | Look at, edit in `$EDITOR`, or clear the draft. | allowed |

Reading

| Command | Does |
|---|---|
| `/history [n]` | Print the last n entries (default 10). |
| `/show <n\|id>` | One entry in full: reasoning, tool calls, usage, the commit. |
| `/thinking on\|off\|brief` | Whether reasoning is shown while streaming and in history. |
| `/usage` | The ledger: this turn, this thread, by model; the estimate for the next request. |
| `/status` | Thread, branch, model and settings, price pin, activity, session, staged state, warnings. |
| `/log` | The commit graph (`readCommitGraph`). |
| `/export <file>` | The thread as Markdown (a rendering, for sharing; the transcript stays the record). |

Threads

| Command | Does |
|---|---|
| `/threads` | List branches: last activity, whether a request is running, worktree, which sessions are attached. |
| `/thread [name]` | Show or switch (opens or creates the worktree). |
| `/thread new <name> [--from <entry>]` | A new thread, optionally from an earlier point. |
| `/fork [<entry>] [name]` | Fork this thread (a side conversation). |
| `/merge <thread>` | Merge a fork back (`fork_merge`, with the summary the user or the model writes). |
| `/compact <from> <to>` | Replace a range with a summary (the CLI asks the model for the summary, shows it, asks to accept). |

Agent setup and configuration

| Command | Does |
|---|---|
| `/model [provider/id]` | Show or change the model; changes that the library classifies (`cache_break`, `cost_increase`, `capability_loss`...) are shown and need a `y`. |
| `/set <key> [value]` | Model settings, validated by the adapter's schema (`/set max_output_tokens 4000`); no value shows it. |
| `/instructions` | Show or edit the agent's instructions. |
| `/providers` | Providers from `harness.yml` and whether their key variables are set. |
| `/pricing [pin]` | Show the price table in force, or pin the current one. |
| `/accept` | Accept a provider-observed change (`setup_changed` with `reason: provider`). |
| `/config` | Validate `harness.yml` and show issues; `chattree config edit` opens it. |

Housekeeping and session

| Command | Does |
|---|---|
| `/verify` | `verifyHistory`. |
| `/maintain` | Repack now. |
| `/sessions` | Sessions on this project: thread, age, draft preview, whether locked. |
| `/help [cmd]`, `/clear`, `/quit` (`/exit`, Ctrl-D) | As expected. |

Non-interactive verbs use the same engine: `chattree say "text" [--attach f]... [--thread t] [--json]`, `chattree show`, `chattree status`, `chattree threads`, `chattree verify`, `chattree doctor` (git and Node versions, providers and keys, a request to each provider with `--online`). `say` reads stdin for `-`, prints the reply to stdout and everything else to stderr, and exits non-zero on a failed request: it is what scripts and tests use.

## 5. Verbs

- `chattree init [dir] [--provider anthropic|openai|compatible --base-url U] [--model M] [-y]`: creates the repository if needed, writes `harness.yml` (providers detected from `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, with `api_key_env`, never the key), adds the ignore entries, commits the header, sets the first `agent_setup` (model and settings), and pins the current prices so costs work from the first message. It never stores a secret. Without flags it asks a few questions; with `-y` it takes defaults and fails if it cannot.
- `chattree chat [thread]`: opens the session. On start it prints the last few entries (everything since the last user message, at most ten, long text truncated with the way to see the rest), the thread, model and spend, then the prompt.
- `chattree <verb> -C <dir>`: the project switch for everything.

## 6. Activity

The transcript and the request journal say what is going on, so a session needs no private channel to know:

- A live request journal for this thread (heartbeat younger than the stale limit) means "a request is in flight". The spinner shows the model, elapsed time, and who owns it ("this session" or "another session, pid N"). Typing stays possible; commands marked `blocked` answer with the reason ("a request is running in session 2").
- A stale journal is a crashed request: the session offers `/recover`-equivalent behaviour by reopening (the library already recovers it).
- Tool calls will appear the same way once the tool loop exists; the activity model carries a `tool` kind from the start but nothing produces it yet.
- Streaming in the session that owns the request is rendered live. A second session shows only the spinner at first and prints the finished entries when they land; tailing the journal to stream another session's reply is a later refinement.

`/abort` in the owning session fires its `AbortController`. From another session (or after the owner is gone) it writes an abort marker next to the journal, which the turn runner checks on its flush timer; for a stale journal it recovers instead.

## 7. What the library must gain first

Checked against the current code; these are small, but the CLI cannot work without them.

1. **A handle that survives other writers.** `Conversation` asserts that `chat.yml` is exactly the size it expects and says "reopen" otherwise. Two sessions on one thread share the worktree and the file, so the second append fails. Needed: under the branch lock, an append first adopts what other writers appended (the file ends cleanly and HEAD is a descendant of what the handle knew) instead of failing, plus `convo.sync()`.
2. **Seeing other sessions' entries.** `onEvent` only reports this handle's own changes. Needed: `convo.watch()` (poll the file size and HEAD) that yields foreign entries, so a session re-renders when another session answers.
3. **Activity as a query.** `convo.activity()` -> `idle | request{since, model, owner, live}`, from the journal, and `convo.requestAbort()` for the marker.
4. **Blobs staged but not committed must survive `gcBlobs`.** `attach` writes a blob immediately; a staged attachment is referenced only by the session file. `gcBlobs` needs a grace period or a way to treat blobs listed by the host as live.
5. **Creating a thread from nothing and in a chosen worktree path** (today only `fork`/`openBranch` create branches and worktrees).
6. **The tool loop.** It is still parked. The CLI's first version is chat without tools; the engine, activity model and renderer leave room for it, but "ongoing tool call" has nothing to show until it is built. Whether the tool loop comes before or after the CLI is a scheduling decision for the project owner.

## 8. Host decisions the CLI makes

- A `ChangeNotAllowed` is shown with each change's message and asked `y/N`; `y` repeats the call with the matching `allow`. `LimitExceeded` is shown with the figures and the line to edit in `harness.yml`. `CostWarning`s print once before the request is sent (and `near_limit`/`token_count_failed` again in `/status`).
- `pricing_changed` after `init`: the CLI shows what changed in the table and asks before pinning.
- A provider failure before any content is shown as the error, leaves no entry, and the session offers `/retry`. A failure after content is an `interrupted` entry and the session offers `/continue`.
- Secrets: only environment variables, as in `harness.yml`. The CLI never prints or stores a key.

## 9. Testing

- Engine and commands: table tests over `submit(line)` with a fake terminal, a fake provider (the existing toy/replay adapters) and a temp repository; the staged-state rule is a registry test.
- Renderer: golden outputs in plain mode.
- Sessions: two engines in one process on one thread (the multi-writer path), and a kill-and-resume test using the session store.
- Terminal: a small real-pty smoke test is optional (it needs a pty library); the tty layer is kept thin so that most of it is covered through the fake.

## 10. Open questions

1. Branch placement for `init` in an existing repo (section 2): new `chat/main` branch, or the current branch?
2. Is the tool loop built before the CLI, with it, or after (section 7.6)?
3. Do display preferences (`/thinking`, colour, editor) belong in a per-user file (`~/.config/chattree/cli.yml`) or only in the session? Proposal: session only for v1, user file later.
4. Should a second session on a thread stream the first one's reply by tailing the journal in v1, or print it when finished?
5. Bracketed-paste handling in `node:readline`: believed to be supported through its keypress parser, but undocumented; to be checked before committing to readline over a small purpose-built line editor.
