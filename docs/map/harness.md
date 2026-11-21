# `harness/`: conversations, turns and tools

**Purpose.** The agent harness proper: a conversation as a Git repository (create, open with crash recovery, append, fork, subagents, merge, compaction), the entry schemas, the model context and request, the turn and tool loop, tools, limits and cost. It is provider-neutral (it sees neutral events and blocks) and host-neutral (it knows nothing of terminals; it reaches the machine through `Host`).

**Depends on:** `src/`, and the provider seam types from `providers/`. **Used by:** `cli/` and any other host (see [Extending: embedding](../extending/embedding.md)). The tools that ship are in `starter/`; MCP is in `mcp/`.

How the pieces fit: a `Conversation` (one thread, one branch, one `chat.yml`) is the only thing that changes history. `request.ts` turns the transcript and the folded agent setup into a request context; `turn.ts` runs one request through a provider adapter and commits the result; `loop.ts` repeats that while the model asks for tools; `pump.ts` and `runs.ts` decide which threads can go on without a person.

## Conversation and history

| File | Role |
|---|---|
| `conversation.ts` | The `Conversation` handle: create, open (version check, crash recovery), append and `appendMany`, entry index, fork, subagents, fork merge, compaction, interrupt, rewind, archive, blob GC, worktrees, `switchWorkspace` (the project folder and a thread's worktree trade branches, with ignored files swapped by `workspace-swap.ts`; refused while either thread is busy or has unsaved changes). A conversation can exist with no model pinned (no `agent_setup` yet); what needs one (a request, compaction, price pinning) is refused with `NoModelPinned`, a `ConversationError` that says to add a provider and choose a model. Every mutation takes the branch lock, appends, commits, and on failure rolls back (ADR 3, 5). Large; the sections follow the order of those operations. |
| `entries.ts` | The entry types (TypeBox schemas, strict), the format version, and `EntryReader`, the reader whose state is the version (ADR 9). **Any change to what an entry may hold starts here.** |
| `blocks.ts` | Provider-neutral blocks from a turn to the entry shapes committed; one path for live, recovered and interrupted responses. |
| `context.ts` | `contextEntries`: which entries a model is shown (fresh-context markers, compactions, trims). The transcript is never rewritten; this is how it is read. |
| `context-builder.ts` | `buildContext`: entries to a provider-neutral `ModelContext` (system, instructions, turns, tools, cache hints). Pure. |
| `setup.ts` | The agent's state folded from `agent_setup` entries; `ChangeNotAllowed` and the change classification (ADR 13, 14). |
| `definitions.ts` | Pinned definitions: tools, instructions, skills, MCP stored as name plus hash, with `blob` or `external` storage (ADR 21). |
| `blob-store.ts` | Blobs as content-addressed files in the worktree; recording store for direct-to-git commits. |
| `journal.ts` | The journal of a request in flight, beside the repository, so `open` can recover paid output (ADR 18). |
| `index-cache.ts` | Optional on-disk cache of a branch's entry index; never trusted without checks. |
| `verify.ts` | `verifyHistory`: read-only audit of the history against the format's promises; returns problems, never throws. |
| `graph.ts` | The history as a graph (commit, owning branch, time, tool calls, branch kind) and as a Mermaid `gitGraph` for inspection. |
| `ulid.ts` | Sortable ids; history orders entries by id as strings. |
| `lease.ts`, `lease-ref.ts` | The run lease (who is running a thread, until when), as files or as refs on a shared remote. Separate from the short append lock. |
| `config.ts`, `config-schema.ts` | `harness.yml` schema and loading, and the generated editor schema. |
| `secrets.ts`, `trust.ts` | Where secrets come from (ADR 19); which `harness.yml` each thread has approved. |

## Requests, cost and context size

| File | Role |
|---|---|
| `request.ts` | Builds what one request sends: context, media conversion, limit checks. Used before every request, by the loop and by compaction. |
| `turn.ts` | One request from transcript to transcript: build, stream the adapter's events to the caller while journalling, commit the `assistant` entry or an `interrupted` entry, write a provider-observed setup change first. |
| `partial.ts` | Folds stream events into what is known so far, for a turn that ends early. |
| `estimate.ts`, `ledger.ts`, `limits.ts` | The pessimistic pre-flight estimate; cost derived from usage times the pinned price table (`entrySpends` per entry, `computeLedger` the totals); the limits (ADR 20). |
| `oneshot.ts` | A model call outside the transcript (summaries). |
| `file-open.ts` | `resolveFileOpen`: where a file a message named is found, worked out when the person clicks: on disk in the thread's worktree (the project folder for the checked-out thread), read-only from history when the thread has no worktree or a commit is asked for, or refused with a reason. Never creates a worktree. |
| `workspace-swap.ts` | `swapIgnored`: trade the git-ignored top-level entries (`node_modules`, build output) between two worktree folders by rename, so a thread switch needs no install. Never moves `.git` or `.chattree`; leaves a name the other side holds as a tracked entry; rolls back on failure (and returns `undo`); across disks (`EXDEV`) leaves everything and says why. |
| `injections.ts`, `environment.ts`, `renderer.ts` | Recorded injections (ADR 23); the system prompt and environment note (parts switched by `injections.environment_details`; the workspace path is one of them, so moving the workspace makes the model be told again); the text a model reads for entries with no provider equivalent. Renderer ids never change meaning. |
| `compaction.ts`, `trim.ts` | Summaries and trimming, automatic and by hand (ADR 31). |

## Tools and the loop

| File | Role |
|---|---|
| `tools.ts` | The `Tool` type and `ToolRegistry`: definitions checked at registration, calls checked against schemas, outputs shaped for the transcript. |
| `tool-schema.ts`, `schema-project.ts`, `tool-args.ts` | Argument validation (TypeBox, with an ajv-parity corpus); what a model is shown of a tool's schema (ADR 25); typed readers for arguments. |
| `loop.ts` | The tool loop (ADR 26): request, run each call in order, write each result as its own entry, repeat. Provider-neutral; yields events. |
| `approvals.ts` | The pure part of approvals: expiry, coverage, editing the `allow` map in the file text. |
| `jobs.ts` | Background jobs and their `job_event` entries (ADR 28). A job with no `lease` (`timeout_seconds: 0`) is a daemon: it holds no run lease and lives as long as the process. `watch` tells the UI of job changes and log text; `stop(id, "user")` records the stop with `by: "user"` (format 2.9), which `foldTip` ignores, so the model hears of it with the next event instead of being woken. |
| `job-log.ts` | `JobLog`: what a job printed, tagged `stdin`/`stdout`/`stderr`, ANSI-stripped, capped at 1 M characters (oldest dropped). Fed by `Host.run`'s `onOutput` through `ToolContext.output`. Commands run with `NO_COLOR`, `TERM=dumb` and the like so most print plain text. |
| `runs.ts`, `pump.ts`, `tip.ts` | The run manager (one owner for every running loop in a process); the pump that works out from each tip what needs no person (`blockedOn(thread)` says which threads a blocked one waits for); what a thread's tip needs, derived from history. |
| `subagent.ts`, `subagent-models.ts`, `fork-tools.ts`, `thread-tools.ts` | The `subagent`, `fork`, `merge`, `thread_read` and `thread_send` tools and the model allowlist (ADR 29). Who may talk to whom is worked out from history, never from what the model says. |
| `search.ts`, `search-tool.ts` | Lexical search over threads and the tool that exposes it, with permission keys. |
| `instruction-files.ts` | Instruction files (`agent_setup.files`, format 2.8): a map of canonical path to the hash of the content (in `blobs/`), `null` removes, omitted keeps. A relative path is a file of the repository: `Conversation.syncInstructionFiles` (run before each request) records a new entry when it differs or has gone; an absolute path is a file the host passed in. The prefix shows the files after the instructions in order of path; a later change is shown where it was made (`append`) until a rebuild folds it in, as with the instructions. |
| `skills.ts`, `skill-tool.ts` | Skills as untrusted input pinned by whole `SKILL.md`, and the `skill` tool. |
| `starter/` | The built-in file and command tools (`read`, `mm_read`, `write`, `edit`, `run`, `script`), the `run` command parser, globbing, workspace boundary, approval keys, portable commands for Windows. |
| `mcp/` | The MCP client (tools only, stdio and streamable HTTP), the per-process connection pool, and server acceptance and pinning (ADR 24). |

## Media

| File | Role |
|---|---|
| `attachments.ts`, `formats.ts`, `ebml.ts` | Attachments (the host names the type; the harness never guesses) and the formats known by content (`file-type`). A WebM or Matroska file with sound and no picture is read as audio: `ebml.ts` walks its track list for that. |
| `media-spec.ts`, `prepare-media.ts` | What a sink accepts and the request-time step that converts anything it does not. The transcript keeps the original. |
| `converter.ts`, `ffmpeg-converter.ts`, `convert-cache.ts` | Converters (stateless bytes in, bytes out), the ffmpeg one, and a cache under the git directory. |

## Invariants

- History is append-only; a mutation is lock, check, apply, commit, or roll back. New mutations need crash-injection coverage (`test/harness/`).
- A request is built from the transcript plus the folded setup; nothing is read from `harness.yml` for what the agent *is*.
- Limits are checked before a request is sent; an unknown price is unknown.
- Model output and tool arguments are untrusted: validated, never cast.
- A tool result is committed as soon as it exists. After a crash, an unanswered call is answered "did not run"; it is never silently re-run.
- Entries and renderer, dialect and tag ids keep their meaning once released.

## To change X

- *Add or change an entry field or type:* `entries.ts` (strict schema, version constant, `entryTypesByMajor` if major), then the code that writes and reads it, `verify.ts` if it affects invariants, and tests in `test/harness/entries.test.ts`. Widening is a minor bump.
- *Add a mutation on a conversation:* a method in `conversation.ts` that follows the lock, check, apply, commit skeleton, an event if hosts should see it, a crash test, and a line in `verify.ts` if history has a new promise.
- *Add a tool:* [Extending: tools](../extending/tools.md); starter tools in `starter/` and `app/toolset.ts`.
- *Change what the model is shown:* `context.ts` and `context-builder.ts` (and the renderer for new wording; a changed wording is a new renderer id).
- *Add a limit or cost meter:* `limits.ts`, `ledger.ts`, `estimate.ts` and the price tables in `providers/pricing.ts`.
- *Change setup classification:* `setup.ts` for core kinds, the adapter's `classify` for provider-specific ones.

## Whether a call started

A loop marks a call as started just before its tool runs, as a hold `exec:<call id>` on the thread's run lease (dropped once the result is recorded; it is not listed as what the thread is busy with). When a host dies the next loop finds the lease stale and reads what it held: a call with no `exec` mark was still waiting for a decision, so it is carried on (it runs, or asks again) rather than answered "did not run"; a call with the mark may have run and is answered as lost. If the stale lease cannot be read, every call counts as possibly started. Time and how long a person took to answer never decide this.
