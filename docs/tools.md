# Tool loop and starter tools

Status: **agreed plan** (reviewed with comments; build not started). Build status goes in section 11 as the steps land.

## 1. Goals and non-goals

The goal is a coding-agent loop you can use from the CLI: the model asks for tools, the host runs them, the results go back, and the whole exchange lands in the Git history like any other entry. The loop stays small. Resume, audit, cost and branching already come from the transcript being canonical.

Goals

- A host-side tool loop that works for any adapter that reports `stop_reason: tool_use`, with no provider-specific code in the loop.
- Five leaf tools: `read`, `write`, `edit`, `run`, `script`. Enough to inspect and change a project and run its tests.
- Three meta tools that operate on chattree itself: `fork`, `subagent`, `merge`. They reuse `fork`, `spawnSubagent`/`finishSubagent` and `mergeFork`.
- Every call and result is recorded as entries, so a crash, an abort or `/undo` at any point leaves a history that verifies and can be resumed.
- A canonical tool format that all three provider flavours translate, with a live check to validate each.
- Safe by default: file tools stay inside the workspace, commands ask before they run, and the request, time and money limits apply to the whole loop.

Non-goals for this step

- OS-level sandboxing of commands. Approvals and a workspace boundary come first.
- MCP servers and user-defined tools. The registry is shaped so they can plug in later.
- Parallel execution of foreground calls. Results are recorded in call order. (Background jobs, section 3.5, are the concurrency story.)
- Search and web tools (`grep`, `fetch`). `run` covers search and the rest can wait.
- A TUI for approvals. The plain prompt the CLI has is enough.

## 2. What the library already provides, and the gaps

Most of the machinery exists. `requestStream` leaves exactly one thing to the host: running the tools and asking again.

Already there

- **Recording.** An `assistant` entry carries `tool_call` blocks (`call_id`, `name`, `args`, `args_raw` when the model sent invalid JSON). A `tool_result` entry carries `call_id`, `is_error`, `content` (text or a blob reference) and `truncated`.
- **Pairing.** The context builder matches results to calls. A call with no result is answered with a synthesized "tool did not run" error, a result with no call is dropped, consecutive results are grouped into one provider turn, and a half-received call from an interrupted response is replayed as a text note, never as a live call. A crash or `/abort` mid-loop cannot produce an invalid request.
- **Definitions** are pinned by hash in the agent setup (`pinDefinition`, `loadDefinitions`, `assertDefinitions`).
- **Mid-loop guard.** `inToolLoop` lets the setup-change logic refuse or ask about changes a provider forbids inside a loop.
- **Limits.** `max_requests_per_turn` and the money limits use the ledger, whose "turn" starts at a user entry, so every request in a loop counts toward one turn. `max_turn_seconds` is a deadline passed to each request.
- **Meta tools.** `fork`, `spawnSubagent`/`finishSubagent`, `mergeFork`. `subagent_result` is already treated as the result of the call that started the subagent, with a user-message fallback when no call is open; `fork_merge` is shown as a user message.
- **Crash and abort.** The journal, `recoverRequest` and `requestAbort`.

Gaps this plan fills

1. A tool registry in the host: name, schema, flags, an asynchronous `execute`, and the pinned definition.
2. The loop, with per-call approval and results recorded as each call finishes.
3. Result shaping: size cap, truncation, and keeping the full output recoverable without duplicating what the repository holds.
4. Results that arrive late or never: a tool running when the user aborts or the process dies, and background jobs that finish between turns.
5. A portable canonical tool schema, checked at pin time, and adapter behaviour for tool calls verified per flavour (section 3.6).
6. CLI rendering, approval prompts and notifications.

## 3. The loop

A turn begins with a user entry and ends when the model answers without asking for a tool.

```
append user ─▶ request ─▶ tool_use? ──no──▶ end of turn
                 ▲            │yes
                 │            ▼
        append tool_result ◀─ approve, then run each call in order
          (one per call)
```

Before every request the requests-per-turn, deadline and money limits are checked. After an abort or crash, calls without a result are answered with a did-not-run error.

### 3.1 Per-turn flow

1. Append the `user` entry (as `sendMessage` does today).
2. Run one request with `requestStream`. It commits an `assistant` entry, or an `interrupted` entry if cut off.
3. If `stop_reason` is not `tool_use` the turn is over; other reasons (`max_tokens`, `refusal`, `pause`) are reported as now.
4. Otherwise take the `tool_call` blocks in order. For each: look up the tool, validate `args` against its schema, ask for approval if needed, execute, and append one `tool_result` entry straight away. A malformed call (unknown tool, `args_raw` set, schema failure) gets an `is_error` result explaining the problem.
5. When every call has a result, go to step 2 with the same deadline.

**Results are written one at a time**, each its own commit. A crash after the second of three calls leaves two results and one unanswered call, which the context builder already answers with a did-not-run error.

**Order.** Foreground calls run in the order given, one at a time; results are written in the same order.

**Limits.** The loop adds none. The request and money limits stop it before a request is sent; `max_turn_seconds` is a deadline shared by all requests and tool runs in the turn. When a limit stops the loop with calls unanswered, they are answered with a did-not-run error and the CLI says which limit it hit.

**Abort.** `/abort` or Ctrl-C works as today during a request. During a tool run it aborts the tool through an `AbortSignal` (`run` kills its process group), records an error result saying it was stopped, answers the remaining calls with did-not-run, and ends the turn without another request.

**Crash recovery.** After a crash the transcript ends with an `assistant` entry whose calls may be partly answered. `/retry` and the next message both answer the unanswered calls with did-not-run and continue. A call that may have half-finished is never re-run automatically; only the model can decide to, with the error in front of it.

**Where it lives.** `harness/loop.ts`, so other hosts can use it. It takes the conversation, the registry, an approval callback and the request options, and yields events: the request events as now, plus `tool.start`, `tool.approval`, `tool.result`. `runTurn` in the CLI becomes a renderer of those events.

### 3.2 Result shape

Output over a size cap (starting point: 30 KB) is cut to head and tail with a marker and `truncated: true`. What the full output points to depends on its origin:

- **Already in the repository** (a `read` of a large file): the idea agreed in review was a reference (path, offset, length at the entry's commit) in place of a copy. **Deferred**: a `read` result is formatted (headers, line numbers, several files), so it is not a byte range of one file, and a reference would need the result re-rendered at read time from the file at that commit. Until then the result is stored as text, and the write pipeline's own size threshold turns a large one into a blob (identical re-reads share one blob). See the parking lot.
- **Not in the repository** (command output, job logs): a blob.

Offsets are bytes; line numbers are applied when rendering. The marker tells the model how to ask for more. Text only for now; image results are a follow-up.

### 3.3 Cost and limits of nested work

A child's spend is recorded on its branch and summarised on the merge entry; the plan is that it counts toward the parent's turn limit (see section 10).

### 3.4 Snapshots

No separate snapshot step: appending an entry already commits the workspace changes with it, so each `tool_result` entry's commit holds the files as that call left them. `/undo` and forks see the files as they were at that point.

### 3.5 Background jobs

A tool that declares itself background-capable can be started with `background: true`. Its executor is asynchronous: it returns a job handle at once and the call's `tool_result` says so (`started job j1`). The job keeps running in the host while the loop carries on. When it finishes the harness commits a `job_event` entry on the branch (a new entry type, shown to the model as a user message, like `fork_merge`) with the status, a summary and the output as a reference.

- Mid-loop: the event is delivered with the next request in that loop.
- Idle: the entry is committed either way. With `background.resume: true` in `harness.yml` the harness also sends a request so the model can react; without it (the default) the CLI tells the user at the next prompt (`background job j1 has finished; your next message will report the result`).

Three small tools manage jobs: `jobs`, `job_output` (read the log from an offset) and `job_stop`. Jobs live as long as the CLI process. After a crash, recovery commits a `job_event` marking each job lost.

### 3.6 Provider adapters and the canonical tool format

The loop is provider-neutral because every adapter translates the same canonical format. The plan makes that explicit instead of assuming it.

**Canonical definition.** `ToolDefinition { name, description, input_schema, flags? }` where `input_schema` is a **portable JSON Schema subset**: objects with `properties`, `required` and `additionalProperties: false`; arrays (including arrays of objects); `string`, `number`, `integer`, `boolean`, `enum`; `description` on any node. Not allowed: `oneOf`/`anyOf`/`allOf`, `$ref`/`$defs`, `format`, `pattern` and friends, because servers differ on them and local servers compile schemas to grammars. A small validator for this subset (`harness/tool-schema.ts`, no new dependency) runs at registration and pin time, so a tool outside the subset cannot be registered, and the same validator checks call arguments in the loop.

**What each adapter must do**, with a conformance test in `test/providers` for each:

- Translate the definitions unchanged (Anthropic `input_schema`; Chat Completions `function.parameters`; Responses `parameters`, currently `strict: false`, which stays because strict mode forbids optional fields).
- Return several calls in one response as several `tool_call` blocks, in order, with unique ids (Chat Completions servers may omit ids; the adapter makes them up).
- Turn invalid or empty argument strings into `args_raw` or `{}` as now.
- Convey several results for one assistant turn in the form the API needs (Anthropic: one user message; Chat Completions: one `tool` message each; Responses: `function_call_output` items), and `is_error` where the API has a flag.
- Replay reasoning blocks that must accompany tool calls, per provider, unchanged.

**The live check** (`tools/live-check.ts`) grows in two stages. The existing `tool-call` scenario covers one made-up tool; these use the real definitions.

Stage A, at the first checkpoint (after the loop and leaf tools exist, section 9 step 4):

- `tools-schema`: send all starter definitions; the server must accept them, and a prompt that needs `read` must produce a call that passes the schema.
- `tools-parallel`: ask for two independent reads; if the model emits several calls they must have unique ids and round-trip.
- `tools-reliability`: a few prompts for `run` command lines (pipes, globs, redirects); report how many calls were valid.
- `tools-edit`: five edit tasks in fresh temporary workspaces through the real loop (one line, two places, delete a block, insert and append, an edit after an edit), scored by whether the file ended up right, so a call that is valid but changes the wrong lines counts as wrong.
- `agent-loop`: end to end through the real `harness/loop.ts` in a temporary git workspace, with approvals auto-granted by the test: read a file, edit it, run a command, and assert the file and the history (it verifies).

Stage B, after the meta tools: `agent-subagent`, `agent-fork`, and a background `run`.

Each scenario skips, not fails, when the model does not support tools. `--record` saves the events so fixtures for offline conformance tests can be made from real runs. The paid runs are yours to start; they join the deferred live verification in the parking lot.

### 3.7 Tool calling conventions

How much of a tool's schema a model is actually shown depends on the model and on the server it is reached through. Ollama, for gpt-oss, prints a list as `any[]` and an object as `Record<string, any>` and drops what is inside, so the model guesses nested fields (step 4f). Each model therefore has a **tool convention**, in its catalog entry (`ModelInfo.tool_convention`) or under `providers.<name>.models.<model>.tool_convention` in `harness.yml`:

- `full` (the default): any schema in the portable subset.
- `flat`: only a tool's top-level properties are reliably shown, so a tool must have scalar properties (or lists of scalars) and nothing nested.

A flat schema is just a JSON Schema in that subset, not a second notation, so it keeps its per-property descriptions, goes through the same validation and coercion, and works on `full` models unchanged. The rule is therefore one-directional: every flat tool can be given to every model; a tool with nested arguments can only be given to `full` models. `flatProblems(schema)` (`harness/tool-schema.ts`) says why a schema is not flat, and `runLoop` refuses with `ToolsNotSupported`, naming each tool and the reason, when the agent's model is `flat` and the registry holds a tool that is not. The starter tools are all flat (a test keeps them so). The convention is looked up at request time, so a model change needs no setup change. `tools-nesting` in the live check sends a tool with a list of objects, scores whether the model fills it exactly right without repair, and prints the value to set. Not built, parked: a second, hand-written schema per tool for the convention, and the conventions `text` and `raw` (see the parking lot).

## 4. Starter tools

Each tool is a definition plus an asynchronous `execute` in the host, pinned in the agent setup. Paths are relative to the thread's worktree, which is the workspace.

| Tool | Input | Approval default | Background |
|---|---|---|---|
| `read` | `path`, `offset?`, `limit?` | allow | no |
| `write` | `path`, `content` | allow | no |
| `edit` | `path`, `version`, then `start` and `end` or `after`, and `content?` | allow | no |
| `run` | `command`, `timeout_seconds?`, `background?` | ask (allowlist skips) | yes |
| `script` | `script`, `timeout_seconds?`, `background?` | ask, always | yes |
| `fork` | `name`, `message`, `auto_run?` | allow | with `auto_run` |
| `subagent` | `brief`, `name?`, `background?` | allow | yes |
| `merge` | `branch`, `summary` | ask | no |

`jobs`, `job_output` and `job_stop` are always allowed.

### 4.1 Leaf tools

**Flat arguments.** `read`, `write` and `edit` each take one file and flat, top-level arguments, no nested lists. Reason: Ollama renders every array-of-objects in a tool schema as `any[]` in the prompt of models that use the Harmony format (gpt-oss), so the model never sees the inner fields and guesses them (step 4f). Flat arguments are shown to every model with their descriptions. Several files means several calls in one turn. A model that sends the old nested shape with one file or one change is repaired (`harness/starter/args.ts`), as are other names for the same thing (`file`, `contents`, `start_line`); more than one is refused with the list of known arguments.

**`read`.** Returns numbered lines under a header that gives the file's version. Default window 2000 lines, plus the result cap; the result says how to ask for the rest with `offset`. A failed read is an error result. Directories return a listing.

**`write` and `edit`.** `write` creates or replaces a whole file (creating directories); its result gives the file's version, and a file that ended with a newline still does (whole-file writes often lose it; the result says when it was added). `edit` changes lines of an existing file by number. `read` numbers every line and shows the file's version (the word `version` and 8 hex digits of the content hash) in its header, and `edit` requires that version: a file that changed since is refused with "read it again", so line numbers can only be used on the file they came from. A call makes one change: `start`/`end` (inclusive) with `content` replacing those lines (empty or missing content deletes them), or `after` with `content` inserted after that line (0 is the top, the last line appends). The result echoes what was removed and added with the new line numbers, one unchanged line either side (so a doubled brace or a lost blank line shows), and the new version, so a following edit needs no re-read; working from the bottom of the file upwards keeps earlier numbers valid. A change is applied entirely or not at all. Line endings (CRLF) and a missing final newline are kept. Only whole lines can be replaced, which is fine for an edit tool. (`applyChanges` still applies several changes numbered as read, for callers that want it.) Both are `allow` by default because `/undo` rewinds files. (This replaced an anchor design after the first live run: see Step 4a.)

**`run` and `script`.** Two tools because they have different guarantees.

`run` takes one command line in a cross-platform, bash-like syntax with common shell utilities, plus whatever programs the host has. We parse the line ourselves (`harness/starter/command.ts`) and start the parsed programs directly, so no shell is involved and the approval prompt and the allowlist see programs and arguments, not a string. (This replaced an argv-list design after the live runs: models are fluent in shell syntax and kept getting nested lists wrong.) Supported: words with `'...'` and `"..."` quotes and backslash escapes (a backslash before an ordinary character stays literal, so Windows paths survive); `|` pipes; `<`, `>` and `>>` with workspace files (the same boundary and protected-file checks as `write`; `/dev/null` discards); unquoted `*`, `?`, `[...]`, `{a,b}` and `**` globs, expanded as a shell would against the workspace, confined to it, sorted, with no match an error (quoted wildcards are literal); `$NAME` and `${NAME}`, replaced from the host environment only for names listed under `tools.env` in `harness.yml` (a list, or `*`, which the CLI warns about; any other name is an error naming it; not inside single quotes); and `2>&1` and `2>/dev/null`, accepted because stderr is always shown with stdout. Refused, each with a message pointing to `script`: `;`, `&&`, `||`, `&`, backticks, `$(...)`, subshells, heredocs, process substitution, `VAR=x cmd`, a leading `~`, redirecting stderr to a file, and more than one line. The glob is a small one of our own over `Host.fs`, not a library: it has to work on whatever host the tools run on. **Windows.** The everyday utilities (`cat`, `ls`, `grep`, `sed`, `awk`, `head`, `tail`, `wc`, `sort`, `find`, `cp`, `mv`, `rm`, `mkdir`, `echo`, ... see `harness/starter/portable.ts`) do not exist there, or are different programs (`find`, `sort`), so on a Windows host the stage is started as `busybox.exe <applet> ...`; programs not on the list (`git`, `node`, `npm`) start as they are, nothing is added to PATH, and a path such as `./cat` is left alone. `busybox.exe` is GPL-2.0 and is not in the repository: `node tools/fetch-busybox.ts` downloads the xPack windows-build-tools release (or takes `--from` a zip or `--exe` a binary), checks it with `--list` and keeps it in `vendor/busybox/` (git-ignored); `findBusybox` also honours `CHATTREE_BUSYBOX`. Without it the model is told the utility is not available and what to use instead, instead of seeing "command not found".

`script` runs a string with `sh -c`, and the language is **POSIX sh on every platform**: `sh` on POSIX hosts, `busybox.exe sh` (ash) on Windows, and a clear "needs a POSIX shell" error if Windows has no busybox. Bash, python, PowerShell and the like are just programs the host may have, started with `run`. It always asks, no allowlist applies, and the CLI reports it as "running a script", not "calling a program".

Both run in the workspace root with stdin closed (unless redirected), a default timeout of 120 seconds (maximum 600) and their own process group, so a timeout or `/abort` kills everything they started. The result is the exit code, then stdout and stderr interleaved in arrival order, then a note if it timed out. The child inherits the user's environment minus anything the harness knows to be a secret, and secret redaction applies to results. These are the only tools that can reach outside the workspace.

### 4.2 Meta tools

**`subagent`** delegates a self-contained task. It calls `spawnSubagent` (fresh context: the child sees only the `brief`) and runs a loop to completion in the child's own worktree. What happens on finish is a `harness.yml` setting (`subagent.merge`), not the model's choice:

- `auto` (default): `finishSubagent` merges with the trunk-wins policy and writes the `subagent_result` entry that answers the call. The model sees the child's final message, the files that landed and any dropped on conflict.
- `review`: nothing is merged. The call returns the final message and the changed files; the parent decides whether to call `merge`, which asks the user, who can inspect the branch first. Needs `mergeFork` to accept a subagent branch.

The child gets the leaf tools but not the meta tools: no recursion, depth one. With `background: true` the call returns a job handle at once and the child runs meanwhile. In `auto` mode the eventual `subagent_result` has no open call to answer and the context builder already shows such an entry as a user message, so it is the notification; in `review` mode a `job_event` is written.

**`fork`** is for work to be picked up with everything the model already knows ("list the features, then fork a planning thread for each"). It creates a branch from the current point with the full history and returns at once with the branch name. `auto_run: false` (default): `message` is not sent but becomes the fork's prompt draft, waiting for the user to edit when they `/switch` there (drafts live in the CLI session today, so a fork's draft needs a persisted per-thread slot in the session store, not in history). `auto_run: true`: `message` is appended as the first user turn and the loop starts in the fork as a background job; when it finishes a `job_event` tells the parent. The user can `/switch` into a running fork to watch and `/abort` it; typing is blocked until it finishes because the branch is locked while a request runs. `fork` never merges.

**`merge`** brings a fork back with `mergeFork`: non-conflicting changes land, conflicting files keep this branch's version, a `fork_merge` entry records `summary`. Each merge reports only what is new since the last. It changes the parent's files, so it asks first.

Nested loops use the same code as the top-level loop with the child's conversation and its own tool context, so a child's tools can never write into the parent's worktree.

## 5. Safety

Three layers, in order of how much they can guarantee.

1. **Workspace boundary** (for `read`, `write`, `edit` and the `stdin`/`stdout` files of `run`). Paths are resolved against the worktree after following symlinks; anything outside is refused. Writing also refuses `chat.yml`, `harness.yml` and anything under `.git/` or `.chattree/`: a model that can rewrite `chat.yml` can rewrite history. `read` may read `chat.yml` but not the rest of `.git/`.
2. **Approvals.** Each tool has a policy in `harness.yml`: `allow`, `ask` or `deny`. Defaults as in the table. The prompt shows exactly what will happen (program and arguments, the whole script, or the branch and its changed files) and offers yes, no and always-for-this-session. A "no" can carry a reason, returned to the model as `the user declined: <reason>`. The prompt is drawn by the host, never from model-written text. `run` allowlist entries are patterns over the parsed programs and arguments (`[git, status]`, `[grep, "*"]`): `*` matches one argument, a final `**` any number. Redirects and pipes are allowed only when the entry says so (`stdout: "*"`, still boundary-checked); a pipeline is allowed only if every stage matches. `script` is never covered. Without a terminal, `ask` means `deny`.
3. **What is not guaranteed.** An approved `run` or `script` runs with the user's permissions and can touch anything the user can; an allowlisted program can still do harm with the right arguments. Approval, not the boundary, is the safeguard there. An OS-level sandbox is the real fix and is the first follow-up; the registry's flags leave room for it.

File contents and command output are data and can contain instructions aimed at the model. No tool result can grant permission, change a policy or add an allowlist entry: those live in `harness.yml`, which `write` cannot touch, and in the user's terminal.

Child conversations get the leaf tools only, confined to their own worktree, with the same policies; a child's approvals are asked in the user's terminal, labelled with the child's name. A turn can create only a few branches (starting limit: 4 forks and subagents).

## 6. CLI experience

- **Tool activity.** Each call is a start line with a one-line summary (`read src/cli/turn.ts`, `run pnpm test`) and a result line with outcome, size and time plus a short preview. `/expand [n]` shows the full output using the entry refs `/log` understands. Errors and declined calls are styled as errors; the plain renderer prints the same without colour.
- **Nested and background work.** A foreground `subagent` is an indented block under its call, lines prefixed with the child's branch name, with a one-line summary at the end. Anything in the background prints one line when it starts and shows no live output; `/jobs` or switching into the fork shows it.
- **Approvals.** `Io.ask`, with `y`, `n` (then an optional reason) and `a`. New rule: before showing a prompt the terminal discards anything typed ahead. Non-interactive `ask` becomes `deny`.
- **Stopping.** `/abort` and Ctrl-C stay `allowed` while the loop runs and stop the request or tool and end the turn.
- **Background notifications.** A finished job is always committed. By default the CLI shows a line at the prompt; with `background.resume: true` a request is also sent. Opt-in because it spends money unattended, and every limit still applies.
- **Commands.** `/tools` lists tools with their policy and the `run` allowlist, and `/tools <name> allow|ask|deny` edits `harness.yml` through the `/config` confirmation path. `/jobs` and `/jobs stop <id>`. `/undo`, `/log`, `/retry`, `/continue` and `/export` work on tool entries unchanged. A fork with a waiting draft shows in `/threads`.
- The one-shot `ask` command stays tool-free.

## 7. Settled in review

- `fork` returns immediately; `auto_run` chooses draft or background run.
- `subagent` has `auto` and `review` modes, set in `harness.yml`.
- `write` and `edit` are allow by default; `run`, `script` and `merge` ask; `run` skips the prompt for allowlisted argv patterns.
- `run` takes a bash-like command line that we parse (no shell), with busybox standing in for the everyday utilities on Windows; `$VAR` only for names in `tools.env`; globs expand as in a shell; `script` (POSIX sh) is the escape hatch.
- `read`, `write` and `edit` take lists; `edit` replaces or inserts by line number, guarded by the version `read` shows.
- Large output: a reference when the repository holds it, a blob otherwise.
- Background tools via an asynchronous executor, `job_event`, and the job tools; idle resume opt-in.
- A child's cost counts toward the parent's turn limit.

## 8. Dependencies

No new runtime dependency. Globbing is a small built-in over `Host.fs` (see 4.1). A validation library for tool schemas is in the parking lot.

## 9. Build order and tests

Eight steps, each committed with its tests. All offline tests use the existing fake provider server with scripted `tool_use` responses.

1. **Registry and shaping.** `harness/tools.ts`: tool type with an asynchronous executor, schema validation against the portable subset (`harness/tool-schema.ts`), pinning, truncation and blob results. Tests: schema failures become error results, subset violations are rejected at registration, oversized output is cut and recoverable.
2. **Leaf tools.** `read`, `write`, `edit`, `run`, `script`. Tests: symlink and `..` escapes, refusal to write `chat.yml`, `harness.yml` and `.git`, edit anchors (none, several, insert), batch stop-at-first-failure, `$VAR` allowlist, glob confinement, pipes and redirects, timeout and abort kill the process group, secrets redacted.
3. **The loop.** `harness/loop.ts`. Tests: several calls in one response, a result committed per call, a crash between calls leaving a valid history that resumes, abort during a request and during a tool, each limit stopping the loop with calls answered, a malformed call, a setup change refused mid-loop.
4. **Provider adapters and the live check** (checkpoint: the first minimal working setup, with approvals auto-granted by the caller). The portable schema in each adapter's conformance tests (parallel calls, ids, empty and invalid arguments, several results, `is_error`), the real starter definitions through each flavour's request mapping, and live-check Stage A (section 3.6). You run it against the providers; recorded runs become fixtures.
5. **Approvals.** Policy, argv allowlist and `tools.env` schema in `harness.yml`, the matcher, fail-closed without a terminal. Tests: pattern matching with pipes and redirects, `script` never allowlisted, a decline with a reason reaches the model, `always` lasts one session.
6. **Background jobs.** Job registry, `job_event`, the job tools, delivery mid-loop, idle notification and `background.resume`, lost-job recovery. Tests: a job finishing mid-loop and while idle with resume on and off, abort of a job, crash recovery.
7. **CLI.** `runTurn` on the loop's events, rendering, the approval prompt with typed-ahead discarded, `/tools`, `/jobs`, `/expand`, notifications. Tests through the in-process `main()` harness.
8. **Meta tools.** `subagent` first (`auto`, `review`, background), then `fork` (persisted draft, `auto_run`) and `merge`; live-check Stage B. Tests: child tools cannot reach the parent worktree, trunk wins on conflict, the branch-count limit, a child's approvals reach the user labelled, a child's cost counts toward the parent's limit, undo of a turn containing a subagent.

## 10. Left to settle while building

- Whether `mergeFork` accepts a subagent branch (needed for `review` mode).
- How a child's spend is charged to the parent's turn limit, and how that stops a runaway background subagent.
- How reliably models produce `run` command lines (a live-check and sampler result, section 3.6).
- Whether Responses `strict: true` is worth using for a subset of the definitions.

## 11. Build status

- **Step 1 (done).** `harness/tool-schema.ts` (the portable subset: `checkSchema`, `validateArgs`) and `harness/tools.ts` (`Tool`, `ToolRegistry` with name and schema checks, sorted definitions, pinning, `check` for a model's call; `shapeResult` with head and tail truncation on character boundaries and a `keep` hook for the full output).
- **Step 2 (done).** The host gained `Host.run` (a command or pipeline in its own process group, stdout and stderr collected in the order they arrive, timeout, abort, output cap, environment scrubbing), `Fs.realpath`, `PathOps.resolve/relative/isAbsolute` and `writeAtomic(..., { keepMode })`. `harness/starter/` has the boundary (`workspace.ts`), a small glob over `Host.fs` (`glob.ts`) and the five tools (`read`, `write`, `edit`, `run`, `script`; `leafTools(options)` returns them). Differences from the plan: the file-reference result form is deferred (see 3.2); globbing is our own and not `tinyglobby`; stdout and stderr are interleaved by arrival, which is exact only when the program's writes are not simultaneous (the OS pipes are separate); `background` is not in the schemas yet (step 6 adds it, as a changed pinned definition).
- **Step 3 (done).** `harness/loop.ts`: `runLoop(convo, {registry, approve?, resultLimit?, ...TurnOptions})` yields `request.start`, `stream`, `request.end`, `tool.start`, `tool.approval`, `tool.result` and returns `{status, requests, last}` (`completed`, `interrupted`, `cancelled`, `stopped`, `deadline`). `toolDrift` and `syncTools` compare the registry with the agent's pinned tools (the loop throws `ToolsOutOfSync` rather than changing the agent silently). Calls an earlier loop left unanswered are answered "did not run" before the first request and never re-run. Truncated results keep the whole output as a blob named by the new `tool_result.full` field (**format 1.3**; the parking lot's earlier reservation of 1.3 for merge-policy hunks moves to 1.4). Background jobs get an error result until step 6.
- **Step 4 (done; the checkpoint).** `test/providers/tools.test.ts` runs the real starter definitions through all three request mappings (unchanged), scripted responses with two calls (distinct non-empty ids even when the server sends none, broken arguments kept as `args_raw`, stop reason `tool_use`), and several results per turn (Anthropic: one user message with `is_error`; Responses: `function_call_output` items, which have no error flag, so the text carries the failure; Chat Completions: one `tool` message each). `tools/live-check.ts` has Stage A: `tools-schema`, `tools-parallel`, `tools-reliability` (reports valid `edit` and `run` calls out of 3 each, which is how we learn whether argv is easy for the model) and `agent-loop` (the real `runLoop` in a temporary workspace: read, edit, run, then checks the file and `verifyHistory`). Each skips when the model makes no tool call. Offline tests drive them against a pretend Chat Completions server. The paid runs are yours: `node tools/live-check.ts --flavor <anthropic|openai-responses|openai-compatible> --base-url <url> --model <id> --api-key-env <NAME> --only tools-schema --only tools-parallel --only tools-reliability --only agent-loop [--record dir]`.
- **Step 4a (after the first live run, gemma4:12b through all three flavours).** Findings and changes: (1) the record files were overwritten by every request of a scenario, so sizes depended on whichever request came last; each request is now its own numbered file with a summary of what was asked, and `agent-loop` records its requests plus a `loop` file (tool calls, results, the file at the end). (2) `tools-parallel` asked for two reads, which `read` rightly batches into one call; it now asks for a read and a `run`, which cannot be batched, and gives each call its own result. (3) `tools-reliability` counted "called read first" as an invalid edit; it is now reported separately as choosing another tool. (4) `agent-loop` failed because the model passed the text to replace as a lone `before`/`after` anchor; edit now refuses replace mode without both anchors and says how to use them, instead of guessing. Open question for the user: add a `replace` field (the exact old text, the form models reach for) with `after`/`before` as optional context.
- **Step 4b (edit redesigned: line numbers).** Decision after step 4a: instead of the `replace` field proposed there, `edit` was redesigned from first principles around the numbers `read` already prints (see 4.1): `read` and `write` report a file version, `edit` takes `files: [{path, version, changes}]` with `start`/`end`/`content` or `after`/`content`, one numbering per file per call, all-or-nothing per file, a stale version refused, and a result that echoes removed and added lines with their new numbers. New live scenario `tools-edit`, scored by outcome; `tools-reliability` is now `run` only.
- **Step 4c (second live run, gemma4:12b).** What the logs showed: the line-number design works (every edit whose version was accepted came out right: two places, block delete, insert and append, edit after edit), and almost every failure was the version token: the header said `v 1f08cd1f`, models copied the `v `, and the check compared the whole string, so some samples looped for ten calls. Fixes: the header, `write` and `edit` results say `version 1f08cd1f`; `edit` accepts any text containing the 8 hex digits; the stale message says "has changed since you read it (you gave X, it is at Y now)". New: `coerceArgs` in `harness/tool-schema.ts` repairs slips with one possible meaning before validation (a lone object or string where a list belongs, JSON text for a list or object, `"5"` for 5, `"true"` for true, a number for text) and the registry hands the tool the repaired arguments. The run also showed `run` failing on `cat` because the machine was Windows (no coreutils on PATH; `script` found bash), and nested `pipe_to` arrays being sent flat. The tasks now use only `node` and `git`. `tools/live-sample.ts` runs each task in `tools/tasks.ts` many times in fresh workspaces through the real loop and reports correct, first-try, requests, tool errors, wrong outcomes and the most common tool errors (blurred), with `--repeat`, `--group`, `--task`, `--out`, `--record`; `tools/agent-task.ts` is the shared runner and the live-check's `tools-edit` and `agent-loop` use it.
- **Step 4d (`run` redesigned).** Decision after the second live run: `run` is now `{command, timeout_seconds?}` (see 4.1): a bash-like command line parsed by `harness/starter/command.ts` into the same stages `Host.run` already took, so nothing else changed underneath. `Host.platform` (`windows` or `posix`; the node host sets it) lets `harness/starter/portable.ts` start everyday utilities as `busybox.exe <applet>` on Windows; `leafTools({ busybox })` takes the path, `findBusybox()` (in `hosts/node.ts`) and `tools/fetch-busybox.ts` locate and install it, and the live-check and sampler take `--busybox`. The sampler tasks that need utilities (`utility pipe`, `utility glob`) run where there are utilities (POSIX, or Windows with busybox). Not done, on purpose: describing the host environment to the agent (parking lot).
- **Step 4e (third live run, gemma4:12b and gpt-oss:20b; old code).** Findings: gpt-oss fills optional fields with empties (`stdin: ""`, `timeout: null`), sends bare strings for object items (`files: ["a.txt"]`) and flattens the `edit` shape; gemma puts `version` inside the changes; `script` on Windows ran WSL bash (`$i` expanded early, `node` not found), which explains the script-loop 0/10. Changes: `coerceArgs` drops optional null/"" values and turns a bare string into the single required text property of an object (`"a.txt"` or `["a.txt"]` → `[{path}]`); `Tool.normalize` runs first, and `edit` uses it (`normalizeEdit`) to accept the changes written on the file, the version or path inside a change, and a single file without `files`; `script` is now POSIX sh everywhere (busybox `sh` on Windows; `sh` and `ash` are in the applet list). Models emit arguments as JSON (the API's object, or a JSON string); string escaping is a small but real source of slips for small models, so keep command strings short and prefer single quotes
- **Step 4f (fourth live run, gemma4:12b and gpt-oss:20b, commit 9a6dca2).** Benchmark set by the user: 8/10 first-try and 9/10 after corrections for every task and model (gemma4:12b, gpt-oss:20b, qwen3.5:9b). Findings: (1) gpt-oss was 0/60 first-try on edit and guessed argument names for read and write (`files: ["a.txt"]`, `contents`, `ops`, `operations`, `edit`): the model never saw the inner fields. Ollama's `ToolProperty.ToTypeScriptType` renders an array as `any[]` and an object as `Record<string, any>` and does not read `items` or `properties`, so nested schemas reach gpt-oss as `files: any[]`; the keys in its calls also come back alphabetically sorted, which is a Go map. This is the translation layer, not the model; gemma's template prints the full JSON schema, so it was unaffected. (2) A real harness bug: gemma's long thinking text was stored as a blob but `reasoning.visible` (and `tool_call.args_raw`, and long strings inside `tool_call.args`) only accepted inline strings, so the loop ended with "assistant entry no longer valid after transforms". Those fields are now blob-or-text like the others and `inlineBlobs` restores them when the context is built or shown. (3) `write` dropped the file's final newline (gemma's delete-a-block 2/10); it now keeps it. (4) The edit result now shows a line either side of the change. (5) Task wording: `replace a function body` said "the sum of its arguments" and three samples wrote `...args.reduce`; `insert and append` did not say whether a blank line may precede `main()`; the code word PELICAN was written back as PELIPCAN in 3 of 10 gpt-oss answers while the tool result had it right (a model slip, changed to WALRUS). Noise that is not the tools and cannot be fixed there: one gemma answer of "10" after the tool said 5, one gpt-oss script that began with `#:` and so did nothing. Fixes 1 to 5 and the schema change are in this step..
- **Step 4g (tool conventions).** `ModelInfo.tool_convention` (`full` or `flat`), `flatProblems`, `ToolsNotSupported` from `runLoop`, the `models.<id>.tool_convention` config key, and the `tools-nesting` live check; see 3.7.
- **Step 4h (fifth live run, commit 9d0cbb3).** gpt-oss went from 0/60 to 52/60 first-try on edit with the flat schemas; every error had gone. gemma4 got worse on edit (24/60 first-try) with one cause: it leaves out `end` for a single-line change (56 of its errors). `end` now defaults to `start` when `start` is given alone (`end` without `start` is still an error). The remaining gpt-oss misses were its own: forgetting that line numbers move after an insert (a second `after: 4` that should have been 5), replacing a blank line instead of inserting, dropping the indentation of a replaced line, replacing lines 1-3 and repeating the closing brace, and `{1..3}` in a `script` (not POSIX; the description now says so). Edit results now say when the lines after a change moved and by how much. Task changes: `replace a function body` compares lines without indentation (indentation is the model's choice); `utility glob` asks for the number on the `total` line, because gemma summed all three numbers in `wc` output (2 of 10).
- **Step 4i (copy probe).** `tools/copy-probe.ts` measures how faithfully a model copies a short string (caps and lowercase words, identifiers, the 8-hex versions `edit` uses, seeded random capitals) from a file into its answer, in three arms: `tool` (the real loop and the read tool), `plain` (our adapter, no tools) and `native` (Ollama's `/api/chat`, no harness, the control). Prompted by gpt-oss writing PELIPCAN for PELICAN (3 of 10, tool result correct, once through `run` and not `read`). Every sample keeps the model's reasoning, and a wrong copy is placed as already wrong in the reasoning, right there but wrong in the answer, or neither. Settings not given are not sent, so server defaults apply; `--temperature` and `--reasoning-effort` vary them. First finding (from the user's 100 runs of `read two files` through the old code, full entries saved): the answers that looked right but failed a plain comparison held U+200B (zero-width space) inside the word and U+00A0 (no-break space) in place of a space, bytes `50 45 4C E2 80 8B 49 43 E2 80 8B 41 4E 20 ...`; others were real typos (PELIPICAN, PELIPCAN). 4 of 100 failed. The tool results and every reasoning block were correct, so the characters appear when the model writes its answer. Nothing in our code inserts such characters. The probe's first version could not see this (it split words at non-letters), so it now reports non-ASCII characters per arm and a `hidden` verdict, and asks for a word and a number together by default (`--shape pair`), as the failing task did. Conclusion (the user's further runs, native Ollama calls included): not the harness. The word PELICAN is garbled by Ollama's gpt-oss in about 5% of runs, in its reasoning and its output, with misspellings or inserted Unicode, even without tools or our code. Noted in the parking lot for test design.
- **Step 4j (sixth live run: gemma4:12b, gpt-oss:20b, qwen3.5:9b).** Every task at or above the benchmark except `insert and append` (1/10, 8/10 and 6/10) and qwen's `script loop` first-try (6/10: it tried `run` with a `for` loop four times and was told to use `script`). The failing files were all `import os\nimport sys\ndef main()...`: the models replaced the blank line 2 with `import sys` (gemma 9 of 10 with `start: 2`), a judgement about replace versus insert, not a tool fault. Changes: the `edit` description says `start`/`end` replace the lines they name, blank lines included, and `after` adds without removing; the task says the blank line stays; `run`'s description lists loops and conditions among the unsupported syntax. qwen3.5's `script loop` first-try stays at 6/10: four samples called `run` with a `for` loop although the task said to use `script`, were refused and then succeeded (10/10 correct). A canary string in a tool description and in a parameter description came back word for word through both Ollama's `/api/chat` and its Anthropic-compatible `/v1/messages` (qwen3.5 is rendered by a built-in Go renderer, so `ollama show --template` prints only `{{ .Prompt }}`), so the descriptions are visible: this is the 9B model not following an explicit instruction, not the tools. Its Modelfile ships `presence_penalty 1.5`, `temperature 1`, `top_k 20`, `top_p 0.95`; a presence penalty works against exact copying, so remember it if a qwen copy error turns up.
