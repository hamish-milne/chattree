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

- **Already in the repository** (a `read` of a large file): the entry stores a reference (path, offset, length). The result entry's own commit pins the file contents, so no hash is needed, provided the workspace is snapshotted before the entry is appended. A reference can stand in for any value in the transcript, like a blob reference.
- **Not in the repository** (command output, job logs): a blob.

Offsets are bytes; line numbers are applied when rendering. The marker tells the model how to ask for more. Text only for now; image results are a follow-up. The reference form needs a format version bump and verifier support.

### 3.3 Cost and limits of nested work

A child's spend is recorded on its branch and summarised on the merge entry; the plan is that it counts toward the parent's turn limit (see section 10).

### 3.4 Snapshots

After each mutating tool call (`write`, `edit`, `run`, `script`) the loop takes a workspace snapshot so the file state is tied to the entry that caused it. `/undo` and forks then see the files as they were at that point.

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
- `tools-reliability`: a few prompts each for `edit` and the `run` argv form; report how many calls were valid. This is how we find out whether models handle argv without extra reasoning, and the fallback is `script`.
- `agent-loop`: end to end through the real `harness/loop.ts` in a temporary git workspace, with approvals auto-granted by the test: read a file, edit it, run a command, and assert the file and the history (it verifies).

Stage B, after the meta tools: `agent-subagent`, `agent-fork`, and a background `run`.

Each scenario skips, not fails, when the model does not support tools. `--record` saves the events so fixtures for offline conformance tests can be made from real runs. The paid runs are yours to start; they join the deferred live verification in the parking lot.

## 4. Starter tools

Each tool is a definition plus an asynchronous `execute` in the host, pinned in the agent setup. Paths are relative to the thread's worktree, which is the workspace.

| Tool | Input | Approval default | Background |
|---|---|---|---|
| `read` | `files`: list of `{path, offset?, limit?}` | allow | no |
| `write` | `files`: list of `{path, content}` | allow | no |
| `edit` | `edits`: list of `{path, after?, before?, content, mode?}` | allow | no |
| `run` | `argv`, `pipe_to?`, `stdin?`, `stdout?`, `append?`, `glob?`, `timeout_seconds?`, `background?` | ask (allowlist skips) | yes |
| `script` | `script`, `timeout_seconds?`, `background?` | ask, always | yes |
| `fork` | `name`, `message`, `auto_run?` | allow | with `auto_run` |
| `subagent` | `brief`, `name?`, `background?` | allow | yes |
| `merge` | `branch`, `summary` | ask | no |

`jobs`, `job_output` and `job_stop` are always allowed.

### 4.1 Leaf tools

**`read`.** Takes a list of files. Each is returned as numbered lines under its own header. Default window 2000 lines per file, plus the result cap; the result says how to ask for the rest with `offset`. One file failing gives an error line for that file and the others still come back. Directories return a listing.

**`write` and `edit`.** `write` creates or replaces whole files (creating directories) and takes a list. `edit` changes part of a file without reading all of it. Each edit gives optional `after` and `before` anchors (exact text that must occur exactly once) and `content`. The region between the end of `after` and the start of `before` is replaced; an omitted `after` means start of file and an omitted `before` end of file; the anchors are kept. With `mode: insert` exactly one anchor is given and `content` goes right after `after` or right before `before`. No match, or several, is an error naming the anchor and listing the candidate line numbers. Both tools apply their list in order and stop at the first failure, saying what was applied. Both are `allow` by default because `/undo` rewinds files.

**`run` and `script`.** Two tools because they have different guarantees.

`run` is a minimal cross-platform shell with no shell involved. `argv` is a list of strings started directly; `pipe_to` is an optional list of further argv lists, each fed the previous one's stdout; `stdin` and `stdout` name files (`append: true` appends) and go through the same boundary and protected-file checks as `write`. The approval prompt and the allowlist therefore see programs and arguments, not a string to parse. Two opt-ins cover what a shell normally does: `$VAR` in an argument is replaced from the host environment only for names listed under `tools.env` in `harness.yml` (a list, or `*`, which the CLI warns about; an unlisted name is an error naming it), and `glob: true` expands arguments containing `*`, `?`, `[` or `{` with `tinyglobby`, relative to and confined to the workspace, sorted, with no match an error. A literal `|`, `>` or `$` as an argument is rare enough that the answer is `script`.

`script` runs a string with `bash -c`. It always asks, no allowlist applies, and the CLI reports it as "running a script", not "calling a program".

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
2. **Approvals.** Each tool has a policy in `harness.yml`: `allow`, `ask` or `deny`. Defaults as in the table. The prompt shows exactly what will happen (program and arguments, the whole script, or the branch and its changed files) and offers yes, no and always-for-this-session. A "no" can carry a reason, returned to the model as `the user declined: <reason>`. The prompt is drawn by the host, never from model-written text. `run` allowlist entries are argv patterns (`[git, status]`, `[grep, "*"]`): `*` matches one argument, a final `**` any number. Redirects and pipes are allowed only when the entry says so (`stdout: "*"`, still boundary-checked); a pipeline is allowed only if every stage matches. `script` is never covered. Without a terminal, `ask` means `deny`.
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
- `run` is argv-based; `$VAR` only for names in `tools.env`; globbing opt-in with `tinyglobby`; `script` is the escape hatch.
- `read`, `write` and `edit` take lists; `edit` uses `after`/`before` anchors with an insert mode.
- Large output: a reference when the repository holds it, a blob otherwise.
- Background tools via an asynchronous executor, `job_event`, and the job tools; idle resume opt-in.
- A child's cost counts toward the parent's turn limit.

## 8. Dependencies

`tinyglobby` becomes the second runtime dependency (after `yaml`). Node's built-in `fs.glob` is checked first and used instead if it is enough.

## 9. Build order and tests

Eight steps, each committed with its tests. All offline tests use the existing fake provider server with scripted `tool_use` responses.

1. **Registry and shaping.** `harness/tools.ts`: tool type with an asynchronous executor, schema validation against the portable subset (`harness/tool-schema.ts`), pinning, truncation, blob and file-reference results (format bump, verifier support). Tests: schema failures become error results, subset violations are rejected at registration, oversized output is cut and recoverable.
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
- Whether Node's built-in `fs.glob` is enough before adding `tinyglobby`.
- How reliably models produce the `run` argv form (a live-check result, section 3.6).
- Whether Responses `strict: true` is worth using for a subset of the definitions.

## 11. Build status

- **Step 1 (done, except the reference form).** `harness/tool-schema.ts` (the portable subset: `checkSchema`, `validateArgs`) and `harness/tools.ts` (`Tool`, `ToolRegistry` with name and schema checks, sorted definitions, pinning, `check` for a model's call; `shapeResult` with head and tail truncation on character boundaries and a `keep` hook for the full output). The file-reference form of a result (format bump and verifier support) moves to step 2, where `read` is its only user; large command output already becomes a blob through the write pipeline's own threshold, and `keep` is how a cut result names where the full text is.
