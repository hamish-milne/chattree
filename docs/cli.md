# The CLI host (draft plan)

Status: **agreed plan** (revised after the first review; the few points still open are in section 10). The CLI is the first consumer of the harness library. It is a host: it owns the terminal, the user's files and the process, and it makes the decisions the library deliberately leaves to hosts (when to confirm a change, how to show a warning, what to do when a provider fails). Nothing in `harness/` should learn that a terminal exists.

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

**Thread** = a branch, and each thread lives in its own worktree (the library's model: `chat.yml` is one file per worktree; forks and subagents already get worktrees). The main checkout is simply the worktree of whatever branch it has checked out.

- `chattree chat` with no thread name takes the thread from the worktree of the working directory: the branch checked out there. It **throws** (never defaults to `main`) when there is no project, when HEAD is detached, or when that branch is not a thread (no `chat.yml`), each with the command that fixes it (`init`, `chat <thread>`, `/thread new`).
- `chattree chat <thread>` opens that branch's worktree (creating the worktree if the branch has none, under `.chattree/threads/<branch>/`, which is already ignored) and runs there.
- The CLI never changes HEAD in a worktree something else may be using; switching threads means pointing at another worktree.

**A session points at a thread; a thread does not own sessions.** The session id is stable and `/thread <name>` re-points the same session (draft, staged attachments, history and preferences travel with it). Which sessions are on a thread is derived by looking at the session files (`/threads` shows the count).

## 3. Sessions and persistent state

A **session** is one running CLI process. Everything a user has typed or staged but not sent lives in the session, never in the transcript:

- the half-typed prompt, the prompt history, the attachments staged for the next prompt, and any other "affects the next prompt" state;
- the thread it currently points at, and the display preferences chosen with commands.

**Attachments are staged by path, not by content.** The session records the file's path, size, modification time and the media type and charset decided at `/attach` time (the CLI reads the file then, to detect the type and to refuse early what `attach` would refuse). No blob is written until the prompt is sent: at send time the file is read again, and if its size or modification time changed, or it is gone, the send stops and says which file, and `/attach` stages it again. So nothing staged is unreferenced in the repository, and `gcBlobs` has nothing to protect. Stdin cannot be staged in an interactive session; `chattree say --attach -` takes it for a one-shot.

**Storage and format.** One YAML file per session at `<git-common-dir>/chattree/cli/sessions/<ulid>.yml`, next to the request journal. That directory is shared by all worktrees, is not part of any working tree (nothing for `git status` to show or for a commit to sweep up) and survives deleting a thread's worktree. It is written with the repository's own canonical emitter and read back through the strict parser and a schema (`format: 1`), so a corrupt file is detected, not half read, and drafts holding any text (multi-line, control characters, unicode) round-trip exactly. YAML rather than JSON for consistency; there is no technical reason that favours JSON here. Writes are atomic (`writeAtomic`), with typing debounced to about once a second and flushed on `SIGINT`, `SIGTERM` and `SIGHUP`; a hard crash loses at most the last second of typing.

**Locking.** `<ulid>.lock` using `src/lock.ts` with a heartbeat, like the journal. Starting a session resumes the **earliest unlocked session whose thread is the one asked for** (the inferred or named thread), so a crashed terminal comes back with its draft; with none it creates one. `--session <id>` and `--new-session` override; `/sessions` lists them. A session with empty state is deleted on exit; one with pending state is kept. If a session's thread has lost its worktree, resuming reopens the branch (`openBranch`) or says that the branch is gone.

Several sessions on one thread and sessions on different threads are both supported. The first depends on library work (section 7).

## 4. The prompt

A line starting with `/` is a command: `/name args...`, arguments split shell-style (quotes, backslash escapes), run as soon as the line is entered. Anything else is bare text, sent as `/say <the text>`. To say text that starts with a slash, use `/say /text` (or `//text`). An unknown command is an error and is never sent to the model.

**Two modes.** *Plain* (not a tty, `NO_COLOR`, `--plain`): line-oriented, no spinner, no colour, no completion; bare text is one line per message or the whole of stdin; this is what scripts and golden tests use. *User* (a tty): a line editor with history, tab completion (command names, thread names, file paths for `/attach`, setting keys), a spinner while a request runs, and colour. Ghost-text suggestions are a later refinement (parking lot).

**Ending bare text (user mode).** The intent is that bare text can have paragraphs. How a message ends is an open question (section 10); the likely shape is that Enter adds a line, a blank line sends, and a pasted block is taken whole whatever blank lines it contains (bracketed paste, so a paste never sends itself line by line). `/edit` opens `$VISUAL`/`$EDITOR` on the draft for anything longer. Ctrl-C clears the draft (twice, or Ctrl-D on an empty line, exits); history is per session and persisted with it.

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
| `/draft show\|edit\|clear\|set <text>`, `/edit` | Work on the prompt draft (what you are typing): look at it, edit it in `$EDITOR`, clear it, replace it. | allowed |
| `/runs` | Subagents and forks working in the background: `/runs` lists them (branch, kind, state, how many runs), `/runs stop <branch>` stops what it is doing (it goes idle; the call that started it stays open), `/runs say <branch> <message>` tells an idle one something and lets it carry on, `/runs close <branch>` ends it (the call that started it is told it was stopped). A subagent hands its work back itself, with its `merge` tool. | allowed |
| `/questions` | Ask the questions waiting on any thread, oldest first. Questions of this thread, and of a subagent it waits for, are asked by themselves; the rest are only counted in the status line. | blocked |
| `/more` | The next page of the last command's output, when it was taller than the terminal (the page ends with a dim line saying how many lines are left). | allowed |
| `/paste [name]` | Bring a named draft back to the prompt: its last line is on the prompt line itself, to edit and carry on, and the lines before it are the draft so far. Ctrl-O does the reverse: it puts whatever is being typed (the draft so far and the current line) aside as the next numbered draft and leaves the prompt empty. | allowed |
| `/draft [name]` | Write a message ahead in `$EDITOR` as a **named draft** (no name: the smallest free number, 1, 2, ...). Opening an existing name edits it; saving it empty removes it. `show`, `edit`, `clear` and `set` are reserved. | allowed |
| `/drafts`, `/discard <name\|all>` | List the named drafts (the `show` of the staged-state rule); remove one without sending (its `clear`). | allowed |
| `/send [name]` | Send a named draft with the staged files, and remove it from the list once the message is in the transcript. The name may be left out when there is one draft. The prompt draft is left alone. | blocked |
| `/undo [n]` | Take the thread back `n` commits, or by default to just before the last message of yours, and put that message in the prompt draft (in a named draft if the prompt draft is in use; with `n`, the earliest message undone). Shows what goes and asks first. The workspace files go back with it; uncommitted changes are snapshotted first; the old tip is printed in full and kept under `refs/chattree/undone/<branch>/<id>`, so `git branch <name> <hash>` brings it back and no collection can remove it. Attached files are not carried into the draft (the note names them). Blocked while a request runs. | blocked |

Reading

| Command | Does |
|---|---|
| `/history [n]` | Print the last n entries (default 10). |
| `/show <n\|id>` | One entry in full: reasoning, tool calls, usage, the commit. |
| `/display [thinking on\|brief\|off] [tools full\|brief\|off]` | What is shown of the model's reasoning and of tool calls and results: live, in `/history`, in the recap when a thread opens, and in the text a model summarises. `tools brief` (default) is a `→ read a.txt` line and a `← ok · 73 B` line with a short preview; `full` adds the arguments and the whole result; `off` hides them. `--thinking` and `--tools` set the same at start. |
| `/usage` | The ledger: this turn, this thread, by model; the estimate for the next request. |
| `/status` | Thread, branch, model and settings, price pin, activity, session, staged state, warnings. |
| `/log` | The commit graph (`readCommitGraph`). |
| `/export <file>` | The thread as Markdown (a rendering, for sharing; the transcript stays the record). |

Threads

| Command | Does |
|---|---|
| `/threads [archived\|merged\|running\|idle\|all]` | List threads: last activity, whether a request is running, worktree, how many sessions point at it. By default only threads that are not archived; the arguments widen or filter it (see 5.1). |
| `/thread archive [name]`, `/thread unarchive [name]` | Hide a thread from the default list (an abandoned fork), or bring it back (see 5.1). |
| `/thread [name]` | Show the current thread, or re-point this session at another (opens or creates the worktree). |
| `/thread new <name> [--from <entry>]` | A new thread, optionally from an earlier point. |
| `/fork [<entry>] [name]` | Fork this thread (a side conversation). |
| `/exec [command line]` | Run a command in this thread's worktree as yourself: no approval, nothing added to the transcript, the terminal handed over (so `/exec sh`, an editor or a watcher work; Ctrl-C goes to the program). The line goes to POSIX `sh -c`, which on Windows is busybox's (fetched on first use, see `tools.run.busybox`), so pipes, `&&` and redirects mean the same everywhere. No command starts a shell; a non-zero exit is reported. |
| `/merge [summary]` | Merge this fork into the thread it came from and move there (`fork_merge`, with the summary the user or the model writes). |
| `/merge <thread> [summary]` | Merge that fork into this thread. |
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

- `chattree init [dir] [--provider anthropic|openai|compatible --base-url U] [--model M] [-y] [--adopt | --force]`: creates the repository, writes `harness.yml` (providers detected from `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, with `api_key_env`, never the key), adds the ignore entries, commits the header, sets the first `agent_setup` (model and settings), and pins the current prices so costs work from the first message. It never stores a secret. Without flags it asks a few questions; with `-y` it takes defaults and fails if it cannot.
  - Inside an existing git repository, plain `init` **throws** and says why: the conversation would share a branch with the user's own work, and every append commits the workspace's pending changes along with the entry (that is how snapshots work). `--adopt` accepts that and initialises on the **current branch** at the repository's top level (it says so if the working directory was a subdirectory); it requires a clean working tree, and `harness.yml`, `chat.yml` and the ignore entries are its first commit. `--force` always runs `git init` in the given directory, even inside another repository (a nested repository).
- `chattree chat [thread]`: opens the session (2, 3). On start it prints the last few entries (everything since the last user message, at most ten, long text truncated with the way to see the rest), then the thread, model and spend, then the prompt.
- `chattree run [thread] [--once]`: the pump with no screen (tools.md 5.4): runs every thread that can go on without a person and leaves questions for any session to answer. Keeps watching until stopped; `--once` exits 0 (nothing waiting), 3 (questions waiting) or 1 (a thread was held after a failure).
- `chattree <verb> -C <dir>`: the project switch for everything.

### 5.1 Archiving threads

`/threads` can grow long, so a thread can be archived: a **zero-diff commit** on its branch with the trailer `Chattree-Archived: true` (and the `Chattree-Offset`, as the snapshot and gc commits carry, so the entry index skips it the way it skips them). Reading the state is the tip's trailer, which one `git for-each-ref --format=...%(contents:trailers)` gives for all branches at once. The archive commit is made with `commit-tree` and `update-ref` under the branch lock, so it needs no worktree and does not touch a checked-out one (same tree, so `git status` stays clean). Any later commit on the branch (an entry, a snapshot) makes the tip non-archived, which is the implicit un-archive; `/thread unarchive` writes the same kind of commit with `Chattree-Archived: false` for when nothing else is to be said. `/threads` hides archived threads unless asked for `archived` or `all`; the other filters are `merged` (the thread has entries of its own and its tip is contained in another thread), `running` (a live journal), and `idle`. `readCommitGraph` shows the commit as an archive marker.

## 6. Activity

The transcript and the request journal say what is going on, so a session needs no private channel to know:

- A live request journal for this thread (heartbeat younger than the stale limit) means "a request is in flight". The spinner shows the model, elapsed time, and who owns it ("this session" or "another session, pid N"). Typing stays possible; commands marked `blocked` answer with the reason ("a request is running in session 2").
- A stale journal is a crashed request: the session offers `/recover`-equivalent behaviour by reopening (the library already recovers it).
- Tool calls will appear the same way once the tool loop exists; the activity model carries a `tool` kind from the start but nothing produces it yet.
- Streaming in the session that owns the request is rendered live. A second session shows only the spinner at first and prints the finished entries when they land; tailing the journal to stream another session's reply is a later refinement.

**`/abort`.** In the owning session it fires that request's `AbortController`. From another session (or a script) it writes an abort marker file next to the journal, which the turn runner checks on its existing 250 ms flush timer; for a stale journal (owner gone) it recovers instead. The journal's start record gains `pid`, host and session id, so a session can say who owns a request, and so `/abort` can tell a dead owner from a live one. Signals are not used for the abort: they are not portable to Windows (where `process.kill` terminates the process), a pid can be reused (the marker is checked against the journal's nonce instead), and the 250 ms latency of the marker is already as fast as the turn runner's other timers.

**A daemon was considered** (one process per project owning the writes, with a named-pipe protocol). It would remove the multi-writer problem outright, give instant abort, live streaming of one session's reply to another, and a natural home for background tool processes. It would also be a second source of truth beside git and files, with its own lifecycle (starting, stopping, stale sockets, versioning, security, Windows pipes), in a design whose point is that the repository and a few lock files are the whole state. Decision: not now. The library gets the coordination operations (`sync`, `watch`, `activity`, `requestAbort`) behind a small interface so that a daemon could implement them later; revisit when the tool loop brings long-running background work.

## 7. Library changes for the CLI (done)

Checked against the code, then built before the CLI (each with tests in `test/harness/sharing.test.ts`, `threads.test.ts`):

1. **A handle that survives other writers.** An append (or `sync()`) under the branch lock adopts what another process sharing the worktree appended: the transcript must end on an entry, HEAD must descend from what the handle knew, and the newest commit's `Chattree-Offset` must equal the file's size. Anything else (bytes that were appended but never committed) still refuses with "reopen", and `open` repairs it. The adopted entries are announced to `onEvent` with `foreign: true`.
2. **Seeing other sessions' entries.** `convo.sync()` returns them once; `convo.watch({ signal, pollMs })` polls the transcript's size and yields them as they appear.
3. **Activity and abort.** `convo.activity()` reads the journal (`idle`, or a request with `live`, `since`, provider, model, owner and nonce); the journal's start record carries the `owner` the turn options give (`pid`, host, session). `convo.requestAbort()` leaves a marker naming the request's nonce (`requested`, `none`, or `stale` for an owner that went quiet); the turn runner polls for it (`abortPollMs`, default 250 ms) and records the request as `interrupted` by the user. `convo.recoverRequest()` records a request that died.
4. **Adopting an existing repository.** `Conversation.adopt(host, dir, options)`: the top level of a repository, on a branch, clean tree, no conversation yet. It adds `/.chattree/` to `.gitignore` and attribute lines for only `chat.yml` and `blobs/` to `.gitattributes` (never replacing the files), writes `harness.yml` if given, and commits the header on the current branch. `verifyHistory` starts at the header commit, so the history before it is not judged.
5. **Archiving.** `convo.archive(name?)` / `unarchive(name?)` (the zero-diff commit with `Chattree-Archived`, made under the branch's lock without a worktree); `listBranches` now reports `archived`, `lastActivity` and `running`; `mergedBranches()` finds forks and subagents whose tip was merged into another thread (reachable from it other than along its own first-parent line). The commit graph labels the marker `archive`.
6. **New threads.** `convo.newThread(name, { worktree?, inheritSetup? })`: a branch from the commit that holds the header (an empty conversation sharing `harness.yml`; not this thread's messages or workspace edits, for which `fork` exists), checked out in its own worktree, with this thread's agent setup copied in unless `inheritSetup: false`.
7. **The tool loop** stays parked: the CLI's first version is chat without tools, and the tool loop is a fast follow. The engine, activity model and renderer leave room for it.

(Staged attachments needed nothing from `gcBlobs`: they are paths until sent.)

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

## 10. Decisions after review, and probe results

Decided in review: tool loop after the CLI; daemon not now; abort by marker file; attachments staged by path; session file in YAML; sessions point at threads; plain `chat` outside a thread throws; archive by zero-diff commit; `init` inside a repository throws unless `--adopt` or `--force`.

- **Ending bare text (user mode): Enter adds a line, a blank line sends.** A paragraph break is therefore typed with a trailing `\` continuation, `/edit`, or comes from a paste (a pasted block is taken whole, blank lines included). Slash commands run on Enter. Making this configurable is a later refinement.
- **`init --adopt`** is the convenience for a repository the user already made (copying files into it): it initialises on the current branch at the top level, requires a clean tree, and the docs spell out the implication. The library is unchanged: every append commits whatever changed in the workspace with the entry, because snapshot and rollback depend on it, with or without `--adopt`.
- **Probe: bracketed paste in `node:readline` (Node 22.23, tested through a pty).** With `\x1b[?2004h` written to the terminal, `readline` emits `keypress` events named `paste-start` and `paste-end`, but it still emits one `line` event per newline inside the paste, and a tab inside a paste is inserted literally (the completer is not called; checked with a completer installed). So `readline` is enough: the terminal layer listens for the paste events, and while a paste is open it appends each `line` to the draft instead of treating it as Enter. The unfinished last line of a paste stays in the editor. No custom line editor is needed.
- Second session streaming the first's reply: print when finished in v1 (tailing is in the parking lot). Display preferences: session only in v1.

## 11. Build order

1. Probes (done: above).
2. Library changes of section 7, with tests; then a checkpoint.
3. `cli/` skeleton: project detection, `init`, the engine and command registry with the plain renderer, `say`/`show`/`status` verbs (the non-interactive path, which exercises everything but the tty).
4. Sessions: the session store, locking, resume, staged attachments by path.
5. `chat`: the terminal layer (readline, paste handling, completion, spinner), live streaming, activity, `/abort`.
6. The remaining commands: threads (including archive), setup, history, housekeeping.

## 12. Build status

Steps 1 to 5 are done; tests are in `test/cli/`. Step 4: `Lock.refresh()`, `cli/session.ts`, `/sessions`. Step 5: `chattree chat`.

- `cli/prompt.ts` holds the prompt rules with no terminal in them (blank line sends, trailing `\\` continues, `//` is a literal slash, pasted lines are taken whole, a recalled multi-line message sends again).
- `cli/terminal.ts` is the `readline` layer: bracketed paste, tab completion (command names, and per-command `complete` hooks: `/attach` paths and options, `/detach`, `/display`, `/threads`), a spinner while a blocking command runs, Ctrl-C (stops a running request; otherwise clears the draft; twice in 3 s leaves), Ctrl-D, live display of entries other sessions add (`convo.watch`), colour. Readline draws on a gated stream: while a request streams its echo is dropped and output goes straight through, so keys typed meanwhile are kept (not echoed); commands marked `allowed` still run at once. Bare text typed while the model is working is not held back: `/say` is `allowed`, and while a request runs (here, or in another session on the thread) it appends the message as a *queued* `user` entry at once and says "queued". See "Queued messages" in tools.md, 5.5.
- **Questions and the status line.** The screen never interrupts what the user is doing for a question. Questions that belong to the thread shown (its own, or those of a subagent it is waiting for, found by the parent link in the child's first entry) are asked as soon as the command or turn in progress ends, or, when the prompt is idle and empty, as they arrive; with a half-typed line they wait until it is sent. Questions on other threads show in the status line (`2 asking (sub/a 7h, sub/b 5m; /questions)`) and `/questions` asks them. The line also counts `running`, `blocked` and `held` threads; idle ones are left out.
- `cli/chat.ts` opens or resumes the session (`--session <id>`, `--new-session`), prints the exchange since the last message and a status line, and runs the terminal or, for `--plain` or no terminal, a line-oriented mode (each line a command or message, `\\` continues, exit status 1 if anything failed).
- Deviation from section 4: `NO_COLOR` (and `TERM=dumb`) turns colour off but keeps the editor; only `--plain` or a missing terminal selects plain mode.
- Checked on a real pty (a python `pty` driver against a fake server) as well as in-process with streams.

Step 6 is done: every command in the section 4 tables exists.

- **Threads** (`cli/commands/threads.ts`): `/thread` (show, switch, `new [--from]`, `archive`, `unarchive`), `/fork [<entry>] [name]` (moves the session to the fork; unnamed forks are `fork/1`, `fork/2`), `/merge [summary]` (this fork into its parent, moving there) and `/merge <thread> [summary]` (that fork into this thread; the merge is checked with `assertMergeable` before anything is asked of the model; without a summary the model writes one through `cli/oneshot.ts`, it is shown and confirmed; it is not in the ledger, and the usage is shown instead). Entries are named as in `/show`: a number counting back from the last entry, or the start of an id (`cli/refs.ts`).
- **Setup** (`cli/commands/setup.ts`): `/model` (settings stay within a provider, only `max_output_tokens` is carried across providers, and prices are re-pinned for the new provider), `/set` (values are JSON or text, checked by the adapter's own settings schema; `unset`), `/instructions` (show, set, edit; replaceable but not removable), `/providers`, `/pricing [pin]`, `/accept`, `/config [edit]` (validates; after an edit it reloads the thread only if the file is valid). Changes the library refuses until agreed (`ChangeNotAllowed`) go through `cli/changes.ts`: shown, asked, repeated with exactly those kinds allowed.
- **The rest** (`cli/commands/misc.ts`): `/compact <from> <to> [summary]`, `/export [file] [--thinking] [--force]` (Markdown, `cli/export.ts`), `/log [n]` (commits, newest first; it is no longer an alias of `/history`), `/clear`, `/edit` and `/draft edit`.
- **Questions with fixed answers** (`Engine.ask(question, fallback, choices)`): a terminal shows them as a list (up/down or k/j move, a key that names a choice jumps to it, Enter chooses, Escape or Ctrl-C gives the default, which starts highlighted); elsewhere the choices become a line of text and the answer is typed. Approvals and yes/no questions use it. Output is coloured and wrapped to the terminal width when it is a terminal (`formatEntry` takes `style` and `width`).
- **Editor hand-over:** `Io.edit(path)` runs `$VISUAL`/`$EDITOR`/`vi`; the terminal layer switches off raw mode and paste mode for the duration (`Engine.suspend`).

Left for later (parking lot): ghost-text suggestions, tailing another session's streaming reply, the tool loop, `chattree doctor`, `--json` output for the verbs, `/threads` showing how many sessions point at each thread (`/thread` shows it for the current one).

### 12.1 Drafts and undo

Added after the first complete version, at the user's request. Library: `Conversation.rewind(commit)` (snapshot, keep the old tip under a ref, `reset --hard`; refused while a request runs, for a commit that is not an earlier one of the thread or lies before its header; other processes holding the thread must reopen it). Session: `drafts` (a list of `{name, text}`) joins the session file, which keeps a session with named drafts. `/say text` no longer clears the prompt draft (only a send of the draft itself does).
