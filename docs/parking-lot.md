# Parking lot

Things deliberately left out, with enough context to pick them up later, grouped by priority:

- **High**: correctness, safety and verification. Left alone, it could lose data, show wrong output, leak something or block the user, or it is a claim we have built on and not yet checked.
- **Medium**: features and support. Wider application or significant functionality, weighed against the cost.
- **Low**: small conveniences, unusual edge cases, minor performance gains.
- **Deferred**: checks and data that go stale, or that need a key or money, so they are done close to release: pricing data from external pages, the Anthropic adapter's verification against the real API, and benchmark numbers for the guide.

Each entry says what it is and what a first step would be. Within a group, the order is the order of intent. Last reviewed 2026-11-23, and again with the maintainer in the evening (the transcript-in-workspace and background-job entries became ADRs 41 and 42; after the graphical UI, the controller, background jobs, attached repositories and the editor's quick start); entries for things that have since been built were removed.

## High

Nothing at present. The Anthropic adapter's verification, which was here, is deferred to release (below).

## Medium

- **Compaction, what is left.** Built: `trim` by hand (`/compact trim`) and automatically, `auto: full` with a summary written between turns (`summary_model`, `summary_input`, `summary_budget`), the summary counted in the ledger, the heads-up injection, the 90% hard stop and the clear error when a summary does not help; also OpenAI's server-side compaction. Left: (a) *Anthropic's own context management* (a first-class compaction or clearing of old tool results): check whether it is usable; it is cache-friendly and cheap but opaque, and the `provider_compaction` block is never sent to another provider. (b) *A summary model of another provider*, with that model's price pin (today `summary_model` is a model of the thread's provider). (c) *A request that already breaks a cost limit* is refused before compaction can run; let compaction try first. (d) *Trim extras*: spare a tool's results by name, and an undo. (e) *Tuning on a real long task*: everything so far ran against the test server; try `keep_recent`, the 70% threshold, the summary prompt and `summary_budget` on a long unattended job. (f) *Subagents*: a child reads the same `compaction` setting for its own context; check what a parent's report looks like after the parent has compacted. (g) *Showing it*: the CLI shows an automatic trim or summary only through the transcript; add a notice and a status mark, and what a summary covers in `/history`.
- **Quick start from the command line, and more than one repository.** A quick-started repository is found from the editor through `chattree.attach` in `.vscode/settings.json` (ADR 40); the command line run inside it finds no conversation. First step: `chattree` resolves a directory through the same map (or a `--conversation <path>` flag), reusing `inspectFolder`'s `WorkspaceLink`. The map allows several repositories under one folder and the editor only offers the folder itself; first step: list the repositories one level down in the picker, with `linkNameFor(key)` giving each its name.
- **Thread communication, what is left.** Built: `thread_read`, `thread_send`, parent and child, siblings behind `threads.siblings`. Left: a child does not see approvals the parent grants after it started (its `harness.yml` was copied at spawn); a way for a message to be a question the sender waits on without ending its turn; messages to threads of other users or machines; questions from threads the user is not on are only counted, not shown; `/history` and the pump should say where a `from` message came from (the CLI shows it as a normal user entry).
- **Conversation search, what is left.** Built: lexical `search` tool, `/search`, scopes, ordering, visible-exclusion, permission keys. Left: *semantic search* (an embeddings model as a provider setting; it sends transcripts to a provider, so it needs the same redaction as requests and an explicit opt-in; the index is derived data kept next to the index cache, keyed by entry id, append-only, rebuildable); a persistent lexical index when a project is large (today every wider search reads each branch's transcript once per process); searching attachments and image text; ranking beyond match count (BM25-like weighting); searching the *current* reasoning of other threads is only with `reasoning`.
- **Live output from other sessions.** Another session shows finished entries, not the stream (tail the journal; a `follow` helper does not exist). A job's own output is live in the process that runs it (`JobLog`, `job_output`, and the editor's jobs popup with its live terminal), but the log is memory only: another process, or this one after a restart, sees only what the `job_event` recorded.
- **Jobs without a time limit in other processes.** A job with `timeout_seconds: 0` holds no lease, so a second process that opens the thread cannot see it; its loop's recovery marks the job lost. Fine while a thread has one host; a heartbeat hold would fix it but would make the thread look busy for as long as a server runs.
- **A release and packaging story.** Package name and publishing (npm, or a single executable), `engines`, a versioning policy for the CLI and the history format (the format is 2.11: what does opening an older repository do, and is there a `chattree upgrade`?), a changelog (there is none), and the install check in CI. The package is still `private` at 0.0.1. The VS Code extension needs the same: a publisher, a version, packaging a `.vsix` in CI, and what the marketplace listing says about needing Node and Git 2.40.

### Validation and wire formats, what is left

- **Nested-schema `changes[]` edit task.** A bench task where the model edits through a `changes[]` array whose items are themselves schemas; it exercises nested-schema handling in the tool-argument validator and the projection of schemas to each endpoint. First step: write the task and run it against the local models to see which fail on the schema and which on the edit.
- **ETag-based `pull --update`.** Refetch a model file only when the remote's ETag differs from the one recorded at download, instead of by size or by a forced `--force`. First step: record the ETag beside the downloaded file and send `If-None-Match`.
- **Size-driven re-encoding.** Re-encode an attachment (an image, say) when its size would break a provider's limit, instead of refusing it. Related to attachment capabilities (Low).
- **Constraint probing.** Find out what a model or endpoint accepts (schema keywords, argument shapes) by asking it with small requests, and remember the answer in the model's info, instead of the fixed `portable` and `full` levels.
- **Small gaps in the format-version work.** A branch start and a merge do not append a bumped header when the file's minor is older (only a plain append does). `nullable: true` in a tool schema is not supported by the TypeBox validator (ajv had it as an OpenAPI extension).

### Merge, workspaces and environments

- **Merge policy per environment, file or hunk.** (The design is below.) Merging a subagent or a fork has one policy today for files: trunk wins, per file. (The code of attached repositories is merged by state, ADR 38, with only the `attached.merge` flags to set.)

### Providers and models

- **Local model framework, what is left.** Built: installing llama.cpp, downloading models resumably with hash checks, the preset, a supervised daemon and the `chattree models` verbs, using llama-server's router mode rather than `llama-swap` (`docs/map/localmodels.md`). Our own prompt rendering is also built, as dialects (ADR 33, `providers/dialects/`): chattree writes the prompt and reads the reply through `/completion`, with the tools' schemas rendered by the dialect from a typed tree (`schema-tree.ts`), not as the server's template flattens them, for Gemma, gpt-oss (harmony), Qwen, GLM, Mistral, Kimi, DeepSeek-R1 and others. Left: (1) which models use one by default: `chattree init` pins `gemma` only, and gpt-oss and Qwen stay on the server's template until a longer run on pinned settings says otherwise (ADR 33); a model name no dialect matches (`dialectForModel`) stays on the chat path. (2) The model's context size is still read from settings or the catalog, not from the server: `/props` is used for media support only, so a server started with a smaller `--ctx-size` than the catalog says is not noticed. (3) Open: who a user-supplied GGUF's chat template belongs to, and when `flat` applies to it.
- **ExLlamaV3 as an engine for local models.** The engine seam in `localmodels/engine.ts` was written for a second engine (the first is llama-server's router mode). ExLlamaV3 is a GPU-only engine with its own quantisation format (EXL3, not GGUF), so the settings need a model format as well as an engine, the installer a different set of files (Python, not a release zip), and the catalog the same facts it takes from `/props` today. It is not yet checked what server would front it, or what it reports about itself. First step: find the server and its API, then see what in `plan.ts` and `store.ts` assumes GGUF.
- **Links to threads, and styling that tells the kinds apart.** Links in a reply today are workspace files and external hyperlinks. Add links to threads (a thread by name, perhaps to an entry in it), and style the three kinds differently so a person can tell what a click does before making it: a workspace file opens in the editor, a thread opens in the graph, an external address opens a browser (and says so). Needs a syntax the model can write reliably (a scheme such as `thread:`, or a path form) and a rule for a link to a thread that no longer exists. First step: list what the renderer does with each kind of link now.
- **Forms in markdown.** In place of a tool for structured questions, parse and render checkboxes, radio buttons and text fields in the response itself, and send the form's state to the model along with any text the person adds. Open: the syntax (GFM task lists already give checkboxes; radio buttons and fields need a convention a model will write reliably); how the state is recorded (a `user` entry that says what was chosen, so the transcript still reads without the UI); what happens to a form in an earlier reply (answered, stale, or still open); and the terminal, which would show the form as text or ask the questions one at a time. Rendering only: nothing from the model's markdown may run. First step: decide the syntax and the entry shape, then the webview.
- **Graph interface, preview before a drag-and-drop merge.** Dragging a thread onto another to merge it should show first what the merge will do: the files, the code in attached repositories and any conflicts that the merge report would give, and the resulting graph with the new merge commit in place, before anything is written. Needs a dry run of the merge (`#planCode` and the tree merge already work out most of it before writing) that returns the report without committing. First step: a `previewMerge` on the conversation that returns the `MergeReport` and the code plan without a write.
- **Code completions and next-edit suggestions.** Inline completions and next-edit suggestions in the editor, using the context of a linked thread; accepted edits reach the thread through the external-changes mechanism (ADR 37). Designed below ("Code completions and next-edit suggestions: the design"); nothing is built. First step: the completion seam with one FIM format (Qwen2.5-Coder) over `/completion`, and a replay bench to measure it.
- **The model makes a repository in the workspace.** What should happen when the model runs `git init` or `git clone` in the workspace, to commit to it or only to explore? The workspace is the conversation's repository, so a nested repository shows up as an untracked folder, or a gitlink on the next snapshot. Not yet looked at: what a snapshot, a rewind, a fork and a merge do with one, and whether `discoverAttached` should pick it up. Options: treat it as scratch (kept out of git through `info/exclude`, and never restored); attach it on the spot (the model asks, the person approves, it is recorded as an attached repository under ADR 38); or, for exploration, give the model a place to clone that is outside the conversation's history. See ADR 41. First step: try each in a test and write down what happens now.
- **Verify OpenAI compaction on the real API**: `context_management`, dropping items before a compaction item, and the not-found error the chain fallback matches. Spend sparingly: the free tier is limited, so use `--only` to pick scenarios.
- **Check the `openai-compatible` adapter against a real llama-server** (`--jinja` tools, `reasoning_content`, the usage chunk). Also measure which compatible servers take full tool schemas, and set `tool_schema: full` in their catalog entries (the default is the portable subset).
- **The credential layer and subscription providers.** `chattree auth login`, a store for credentials that is not the environment, and, on top of it, the ChatGPT/Codex subscription provider. Parked together because the second needs the first.

### Plugins, tools and context

- **A plugin API.** Injections, context renderers, dialects, tools, providers and commands loaded from JavaScript modules named in `harness.yml` (or the user's settings). The seams exist (`AdapterRegistry`, `Renderers`, `injections` options, `ToolRegistry`, the command registry); what is missing is one `Plugin` interface, a loader, and the rules. Rules to settle: a module from a cloned repository is code to run, so it is accepted per thread like an MCP server (a pin of its content, nothing loaded until accepted); a plugin's tools are pinned like any tool, and its renderer has an immutable id and is pure (as decided for renderers); a versioned, typed API with a compatibility promise; where modules are found (project, user directory, `node_modules`); and that Node gives no sandbox, so a plugin has the user's permissions. First step: expose injections and tools through the loader, since they need the least.
- **MCP, parked.** A gateway tool (`mcp(server, tool, args)`) that keeps the prefix stable; OAuth for HTTP servers (needed for hosted servers); resources, prompts, sampling and elicitation; following `tools/list_changed` while connected (today it is flagged and read again on refresh). Also the cost of a process per subagent for each worktree-scoped server, if it turns out to matter.
- **File-reference tool results**: store a `read` result as a reference (path, offset, length at the entry's commit) re-rendered when the context is built, instead of a copy. The result is formatted with headers and line numbers and can hold several files, so it needs the renderer to run at read time and a format version bump with verifier support. Until then a large result is a blob, shared by hash between identical re-reads.
- **OS-level sandbox** for `run` and `script` (container or restricted user): the real answer to approved commands having the user's permissions.
- **Detached jobs** that outlive the CLI process (today a crash marks them lost).
- **Search and web tools** (`grep`, `fetch`) if `run` proves awkward for them. **Image and PDF results** from `read`: a tool result that carries an image needs adapter work.
- **Subagent budgets.** (1) A `max_spend` argument (and a default under `subagent`) that the child's requests are limited by, on top of the inherited ledger. (2) Telling the child how much is left: the injection framework exists, so this is a rule that reads the ledger (spend and requests left) and asks the child to wrap up; elapsed time is another. (3) A child's spend against the parent while it runs: the parent's limits do not see the child's spend until the merge's rollup, so several background children can break a limit the parent passes; either the run manager sums live children into the parent's check, or their requests are charged to the parent's ledger as they happen.

### Code health

- **MCP against more real servers.** Exercised 2026-11-04 against the reference servers `@modelcontextprotocol/server-filesystem` and `server-everything` (2.1.0, installed with npm and started by `node`): connect, list, accept and pin, calls with a string where a number was declared (coerced), an image result (noted as not shown), structured content, a server-side error, a path outside the server's allowed directory (failed cleanly), and a call that takes a second. All worked, with no change needed. Not yet tried: cancellation of a running call; the pool shared between a thread and a subagent, and `scope: project` (`server-memory` has state, so it would show it); the `portable` schema report on real schemas; a streamable-HTTP server (needs OAuth for hosted ones, see MCP, parked); a server that changes its tools while connected or dies mid-call; the git and fetch servers through `uvx`; and Windows, where `npx` is a `.cmd` (`command: cmd`, `args: ["/c", "npx", ...]`) and nobody has tried it. First step: a `tools/mcp-check.ts`, like `live-check.ts`, that takes server configs and reports the tool list, the schema report per level, a call of each tool that needs no arguments and a recorded transcript to turn into a fixture. It needs packages from the network, so it stays a manual check.
- **Architecture and code review.** Draw the module graph (a dependency-cycle report such as `dependency-cruiser`) and clean it up: the layering `src` ← `harness` ← `cli`, with `providers` and `hosts` beside them, has leaks (`harness/schema-project.ts` imports `Conversation`; the adapters know about harness types); some files are very large (`harness/conversation.ts`, `harness/loop.ts`, `cli/engine.ts`) and want splitting along their seams. (Linting and formatting are done: oxlint with type-aware rules and oxfmt, enforced in CI.) `harness/conversation.ts` was split on 2026-11-23 (3,314 → about 2,750 lines): the errors and exported types (`conversation-errors.ts`, `conversation-types.ts`), the entry-text helpers (`entry-text.ts`) and the attached-code merge (`code-merge.ts`) are out. Still in it: the workspace switch and trade, the configuration and trust section, and the index cache; `harness/attached.ts` is 670 lines. Check the `tsconfig` strictness flags and unused-code settings. First step: the graph report and a list of what `conversation.ts` holds, before choosing the seams.
- **Live checks in CI.** `tools/live-check.ts` and the sampler run by hand against providers and local models; a scheduled job against a free provider would catch drift, if the keys can be kept safe.

## Low

### Providers, requests and cost

- **Attachment capabilities**: a per-model `input: [text, image, pdf]` list so a request with a file the model cannot take is refused early and a model switch warns (`capability_loss`); today the provider's error is the signal, and the Chat Completions adapter refuses PDFs itself. Also: downscaling large images before sending, and SVG (sent as text).
- **Token counting, further**: llama-server `/tokenize` for the openai-compatible adapter (unverified), and calibrating the bytes-per-token estimate from the usage of earlier requests for providers with no counting endpoint.
- **Usage as it arrives** on `openai-compatible`, not only at the end. A stream that dies mid-way reports no tokens, which matters only for a hosted Chat Completions provider. The alternative is to report running totals as events and let the result differ.
- **More Chat Completions settings**: `tool_choice`, `parallel_tool_calls`, JSON schema output; an `is_error` prefix for tool results (the API has no flag, so errors are plain text).
- **Cache and tool options**: mixed cache lifetimes within one request (the docs allow it, longer first: the pinned prefix at 1h and the conversation at 5m; OpenAI's per-breakpoint `prompt_cache_breakpoint.ttl`; today one `cache_ttl` covers every marker); an Anthropic equivalent of `allowed_tools` for restricting tools without changing the prefix; OpenAI standalone compaction (`/responses/compact`) for compacting on demand.
- **Strict mode for Responses** (`strict: true`) for definitions that fit it: a third schema level next to `full` and `portable` (every property required, no open objects), now that the model's view of a schema is a projection.
- **A provider option to disable streaming responses**, for debugging and for servers that stream badly. The adapters only parse streams today; a non-streaming response would be replayed through the same mapper, as the throwaway copy-probe patch did for the Anthropic flavor.
- **Pricing extras**: calibrate the estimate from the last response's real usage; Anthropic's `inference_geo` 1.1x multiplier and batch discounts; OpenAI's regional-processing uplift.
- **Provider checks and fixtures**: a live A/B of OpenAI stored (`previous_response_id`) versus stateless replay (cost, cached tokens, latency; needs a key); whether OpenAI hosted tools (web search, code interpreter) need server-side state; the OpenAI WebSocket continuation cache; record fixtures from `tools/live-check.ts --record` runs against Ollama (known caveats: no `cache_control` or `tool_choice`, in-stream errors are unreliable, small models may not call tools or reason, so those scenarios skip).
- **Catalog data.** The bundled descriptions, tiers and level names are written by hand (dated 2026-10-25), and the effort names a model accepts depend on the model. Check them against the providers' documentation; a live check that sends each level and reports the provider's refusal would keep them honest. Level names beyond low/medium/high/off, such as `max`, and per-level cost hints, if the tiers turn out too coarse.
- **Cost ordering for approvals.** Keys are `provider/model@level` with globs. "Anything cheaper than X" would need an order in the catalog (tier numbers or a price rank); not built, on purpose.
- **A merge's rollup** resolves tables the child pinned only from this conversation's providers and blobs, so a child that pinned a table which no longer exists here is counted as unpriced (the safe default: unknown is never zero). **Summaries from `/merge` and `/compact`** are not in the cost ledger either (the usage is shown when they are made).

### History, recovery and locks

- **Recovery that checks the owner is dead.** A journal that goes quiet is taken for dead after `journalStaleMs`; a suspended but living process is only caught by the commit-time ownership check (`RequestSuperseded`), after its work is wasted. A `Host` method that says whether a process is alive would let recovery on the same machine wait for it.
- **Journal extras**: keep a copy of the events of failed requests outside the repository for debugging; a `follow` helper so a second process can tail a request's journal (nothing reads it live yet; the live-output entry in Medium needs it); record the digest the adapter computed for the request so a recovered OpenAI response can still be chained from.
- **Events are in memory.** `onEvent` is delivered after commit, but a crash between commit and delivery loses the event. Consumers that must not miss anything should rebuild from history (`index()`, the `recovery` event); an at-least-once persisted outbox is possible if needed (the editor's controller polls the repository instead).
- **Index cache assumption.** A cached index is extended when its tip is an ancestor of HEAD, which for a branch that has only ever advanced is also on its first-parent line. A branch reset to a sibling line that still contains the old tip would be indexed from a longer `git log`, not wrongly, but a first-parent check would make that explicit. `verifyHistory` never uses the cache.
- **Config approval, follow-ups.** Done. Left: the approval store is not locked; the hash is of the raw bytes (a canonical hash of the parsed file would survive reformatting, but the parsed hash includes schema defaults, so it would change on upgrade); a trusted file's approval is per branch name, so a branch deleted and made again by hand starts unapproved (intended); per-setting approval (approve the providers but not the tools) is not offered; a `harness.yml` committed by the user on a branch merged outside chattree needs one `/trust`.
- **Locks across machines.** Locks are files, which is right for one machine and for local-disk worktrees; a network file system with weak `link`/`rename` semantics is not supported.
- **A persistent `fast-import` process.** Considered and parked on measurement. An append costs two short git processes (stage, commit), about 12 ms; the floor is git's own index and commit work. A long-lived `fast-import` would need `checkpoint`/`get-mark` round trips for the hash, would leave the index behind the commit (needing `reset` anyway), and would add a process to supervise on every handle. `appendMany` already makes bulk writes constant-cost. Revisit only if profiling a real agent loop shows process start-up dominating.
- **Blob garbage collection and finished worktrees**: `gcBlobs` exists; running it, and cleaning up worktrees of merged or abandoned threads, is manual.
- **Renderers**: verifying a renderer's output at runtime (a self-test with fixed inputs, output hash recorded in the setup). Decided: stability is part of the renderer interface contract (an id is immutable, renderers are pure), not something the harness defensively checks, at least for now. Revisit if host-supplied renderers (the plugin API) cause drift.

### Tools

- **Tool conventions, the rest**. Built: `full` and `flat`, the refusal, the probe. Parked: (1) a `schemas` block per tool with a hand-written variant per convention and an optional description override, for the first tool that genuinely needs nesting (it must then provide a flat variant to be used on flat models); (2) `text`, calls written as text for models with no native tool calling (`<call name="run">` blocks with raw, unescaped values), built on flat schemas; (3) `raw`, one unescaped text argument (like OpenAI's custom tools), probably for `script` only, which removes JSON string escaping for large commands; (4) bundled `tool_convention` values for models we have measured, once there are enough of them (today it is set in `harness.yml`, because the same model can differ between Ollama and vLLM); (5) a `--tool-convention` flag for the sampler, only needed once a tool is not flat. The dialects (ADR 33) render the schema themselves and use the call format they declare, so (1) and (4) matter on the chat path only: hosted models and local models without a dialect.
- **Nested schema variants for `read`, `write` and `edit`**, to allow batch operation (several files, several changes in one call, applied together). They would be the first tools to need the per-convention `schemas` block above.
- **Parallel foreground calls**: today they run in order; background jobs are the concurrency story.
- **Exact stdout/stderr interleaving** for `run`: the two pipes are separate, so order is by arrival. Exact order needs the child's two descriptors to be one pipe, which Node cannot ask for directly. **`run` stderr handling:** `2>/dev/null` is accepted and ignored (stderr is shown with stdout). Separating stderr per stage would let it really discard, and would let results label it.
- **Sampler noise floor.** With 10 samples a task that really succeeds 95% of the time scores 9/10 or better only 91% of the time, so a per-cell gate of 9/10 over 51 cells is expected to miss about four by chance. Candidates: 20 samples per cell, a gate that only fails a cell if two runs in a row miss, and classifying each miss as tool, task wording or model.
- **Windows batch programs.** Resolve npm, pnpm and yarn `.cmd` shims instead of running them through `cmd.exe` (they only start `node <script>`, so reading the shim and starting `node` directly would need no flag and no argument restrictions, but needs a parser per tool's shim format and breaks when a shim changes). Local shims are done as `tools.run.local`.
- **Notes for test cases.** Ollama's gpt-oss garbles the word PELICAN (misspellings, inserted zero-width or no-break characters) in about 5% of runs, in its reasoning and its output alike, even in plain native calls. Not our harness. Keep it in mind when choosing words for test cases, and note that a model can emit invisible characters in text.

### CLI and terminal

- **Commands and output**: `chattree doctor` (git and Node versions, providers and keys with what each provider needs, a request to each provider with `--online`; this absorbs the old idea of a `secrets check`); `chattree graph` over `readCommitGraph` (`verify` already works as a verb); `--json` output for the non-interactive verbs; `/threads` showing how many sessions point at each thread; `/sessions` deleting or adopting a session (a stale session file is removed by hand); `/exec --record` (send the command and its output to the model as a user message), output streaming instead of taking over the terminal, and `/exec` in non-terminal sessions.
- **Prompt and display**: ghost-text suggestions and a configurable way to end bare text (today a blank line sends); `/display` defaults (settings file), `usage` as a third switch, and tools in `/log`; user messages in the prompt style in the history, clearer merge and fork markers, a `/history all` pager; other key bindings (a configurable map belongs with the settings file; Ctrl-O inside a bracketed paste is ignored on purpose).
- **Terminal plan**: colour themes and a light/dark setting; wrapping of command output such as tables; syntax highlighting and diff colouring in tool previews; multi-line editing with cursor movement inside the draft; mouse handling off by default; Windows console quirks (legacy conhost, `chcp`, VT sequences) on a real machine; selection lists for `/thread`, `/undo n` and `/accept`; re-wrapping on resize; a fuller screen layer if a pager needs one (a line pinned to the bottom was not worth fighting readline's redraws for).
- **Where worktrees live.** Forks are nested inside the main worktree (`.chattree/threads/<name>`, configurable with `git config chattree.worktrees`). A conversation that was started by the editor's quick start (ADR 40) already lives in the data directory, outside the code, so for it concerns (1) and (2) below do not arise; they remain for a project that is a code repository itself, and an attached repository's own worktree in each fork makes the copies larger. Concerns: (1) the main thread's agent and every tool that scans the tree (grep -r, find, tsc's default include, vite/jest watchers, linters, an IDE) sees each fork's full copy of the source, so searches return duplicates and watchers do double work, which is the strongest argument against nesting; (2) Windows path length, with node_modules a few levels deeper; (3) `.chattree` has to be excluded from the main thread's snapshots (it is, through `.git/info/exclude`) and from anything that copies the directory. Recommendation: keep `main` where it is (the user's directory), move forks out of the tree to a sibling or per-user location (`<root>.chattree/threads/<n>`, or the settings file's data directory keyed by project), and make that the default. Still open: that default, a switch to keep `main` out of the repository root (and `init --adopt` moving the current checkout into the worktree folder), and `git worktree move` for existing nested worktrees.
- **Small ones**: a VS Code helper that adds the `!tag` custom tags to settings (`yaml.customTags`); a per-user preferences file (the settings file exists, `app/settings.ts`; display and key-binding preferences are not in it); a coordination daemon over a named pipe.

## Found in the comment audit (2026-11-17)

Reported while the module comments were written, then each read in the code on the same day. Read again on 2026-11-23: every item below is still as described, and nothing here is fixed yet.

**Real defects**

- **`ensureLlamaServer` records a program's hash in memory before it is verified** (`localmodels/install.ts`). If the program then fails to start, the entry stays and the next `lock.save()` writes it; a later release file of the same name with a different hash is then refused. Low impact (the hash is of a download that was itself checked), but wrong. First step: set the entry after the verify step.
- **The Responses chained-request fallback keys on the error message** matching `/previous_response/` (`providers/openai-responses.ts`), which breaks if the provider rewords it. First step: key on the error's code or status where the API gives one.
- **A trim's worth-check assumes 4 bytes a token** while the summary budget and the estimator assume 3 (`harness/compaction.ts`; the config comment says 3). Pick one constant.

**Inconsistent or misleading, harmless today**

- `deliverSubagents` accepts a `review` option it never reads (documented in the code); `cli/chat.ts` has a ternary whose two branches return the same string; the `ChangeNotAllowed` retry block in `cli/turn.ts` exists twice; `fetchJson` (`localmodels/hf.ts`) and `DownloadError` (`localmodels/store.ts`) are re-exported with no importer; `renderQwen` and `qwenParser` are used only by a test.
- `/merge` reports its summary cost as "not in the ledger" while `/compact` records it once accepted. `/undo n` restores only the first dropped user message as a draft (by design, documented). A fork cannot be named with a number while an entry with that number exists.
- `describeCall` cuts arguments at 1,500 characters in the approval prompt, which the text beside it should say, since the doc says "exactly what will run".
- A lease's headroom is 30 s in the loop and `lease-ref.ts` but `JOB_HEADROOM_MS` is 35 s in `jobs.ts`; confirm it is deliberate and say why.
- `graph.ts` labels a commit "(unreachable)" when only a merge's second parent reaches it, which happens once the child's branch is gone.
- `src/config.ts` rejects NUL bytes without a recorded reason.

**Checked and fine:** `jsonRequest` and the Responses `retrieve` default to a 60 s total timeout where `httpStream` allows 10 minutes. That is a non-streaming request against a streaming one, so the difference is reasonable; a comment saying so would help.

**Price data is close to due:** the bundled tables are dated 2026-10-25 and the Gemini and OpenCode Go snapshots 2026-10-30, and some listed price changes take effect on 2026-12-01.

## Deferred: close to release

- **Verify the Anthropic adapter against the real API.** No free tier, so today it is only checked against Ollama's compatible endpoint. From memory: the request shapes for `system` and `cache_control`, breakpoints, lifetimes and multipliers. If one is wrong, the paid provider's requests fail. Needs a key and a small spend. The prompt-caching prices and multipliers (below) are verified together with it.
- **Benchmark results in the local-models guide.** `docs/guide/local-models.md` has no benchmark table now (the old Devstral entry pointed at a document that no longer exists). If one is added, add it close to release, from fresh runs, so the numbers do not date.

## Deferred: pricing data

Prices come from external pages and affect no other code. Accuracy matters for the cost shown and for limits, so clean these up together before release.

- **OpenAI**: the long-context threshold is not stated on the page (272k is assumed, from earlier GPT-5.x models); which `service_tier` value selects "Fast" (Priority was renamed Fast on 2026-07-30) is unverified; `gpt-6-luna` has no Ultrafast price; `gpt-5.4-mini` and other smaller models are no longer on the page; `chat-latest` (an alias) and the cyber (`gpt-5.6-sol`, `gpt-5.6-cyber`) and life-sciences models are left to overrides. The tier-to-table binding is confirmed (the page's URL carries `latest-pricing=standard|batch|fast|ultrafast`; our `flex` is the page's "Flex/Batch").
- **Anthropic**: the table came from a summarising read of the pricing page; read it in a browser as was done for OpenAI, and add the older models once their API ids are confirmed. Prompt caching prices and multipliers (lifetimes, write multipliers) are verified together with the adapter's request shapes (High).

## Code completions and next-edit suggestions: the design

Drafted 2026-11-24, from a discussion of the two prompt shapes. Nothing here is built. Facts about models were read on 2026-11-24 from model cards and papers (cited by name); anything marked *unchecked* is from memory.

### What it is

Two things for the editor. **Completion**: ghost text at the cursor, fast. **Next edit**: a suggestion to change something other than where the cursor is, shown as an edit and reached by a jump. Both take their context from a chattree thread (what it has learned about the code and the task) and both are cheap enough to run on every typing pause, which rules out the thread's own model and cache.

### Two modes, one request path

- **`fim`: fill in the middle.** A model trained for it gets the text before and after the cursor, in that model's own sentinel format, and writes what goes between. The suffix is what stops the model repeating what came before, and gives it the code that follows. The prompt is raw, so it goes through the same `/completion` transport as dialects (ADR 33). This needs a base or code model; instruct variants are less reliable at it (*unchecked*).
- **`edit`: rewrite a window.** The prompt marks an editable region around the cursor, with the person's recent edits as a diff, and the model returns the new region; the editor diffs it against the old one, so insert, replace and delete are one operation. Output is **text we parse, not a tool call**: code in JSON strings is escaped wrongly by small models, a tool schema costs prompt and latency, and a streamed call cannot be shown early. Line-number instructions ("replace lines 10 to 14") are not used: models miscount. Models trained for it have their own format (Sweep's, below); for a general chat model we write one: system message, the brief, retrieved snippets, the window with a cursor marker, the edit history, and the instruction to return the region.

Both go through a **completion format**: a declaration, like a dialect family, of how a request becomes a prompt and how the text comes back (`render(input) → { prompt, stop }`, `parse(text) → suggestion`). It is a sibling of the dialect seam, not a dialect: there is no conversation, no tools and no reasoning, one request has one answer, and the budget is a few hundred milliseconds. It reuses the `/completion` transport, `/tokenize` for markers and the local model host. Hosted chat models can only do `edit`, through the chat adapters with the generic format and a small, fast model, with thinking off.

The formats differ in ways that make the declaration necessary, and are the test of the seam: sentinel spelling, whether the suffix comes before or after the prefix, and whether other files are given as "files" in the prompt.

### Context, in the order that suits a prefix cache

1. The format's preamble.
2. **The thread's brief** (below). Stable between requests.
3. **Retrieved snippets**: the definitions of symbols near the cursor (from the language server), the enclosing scope and imports' signatures (tree-sitter), recently edited files and open tabs, then lexical search over the project; embeddings later if lexical is not enough.
4. The window of the current file, with the cursor marked.
5. **Recent edits as a diff**, from the editor's events and the external-changes record (ADR 37).

Everything that changes per request is last, so a local server reuses the cached prefix; a hosted one charges cache reads on every request, which is part of why hosted models are the exception. The budget per request depends on the model's context (Mellum's is 8,192 tokens; Sweep's 32,768).

Files the person's ignore rules or the project's `.gitignore` exclude, and anything that looks like a secret, are never put in a prompt. Sending code to a hosted model on every pause needs consent per folder, and a visible setting.

### Linking a thread: the brief

The raw transcript is the wrong thing to give a small model: it is long, mostly about other things, and changes on every turn. A thread instead produces a **brief**: a compact account (a few thousand tokens at most) of the architecture, the conventions and the task in hand, written by the thread's own model when asked (a command, and after a compaction), and kept in git. A change of the brief is a change of the cached prefix, which is acceptable because it is rare.

Which thread: **derived** by default (the thread that last read or edited this file or its neighbours, which the transcript records), overridden by a glob (`completions` settings: `match` → `thread`) or by a command on the open file. Later, and only if the brief is not enough: an agent that prepares a set of files and notes per glob, and a harness-managed semantic index kept on a thread.

### What is recorded

Accepted suggestions are file changes, and files changed outside the chat are already told to the model (ADR 37): nothing new is needed for the thread to know. A suggestion that was shown and not taken is not recorded in the transcript. Counts (shown, accepted, latency) go in a local file, off by default, for tuning.

### Request discipline

Debounce typing, cancel the request in flight on the next key, do not start mid-word, and keep a shown suggestion while the typed characters still match it. After an accept, prefetch the next edit. Completion requests have their own cost line, not the thread's ledger. Decode speed: a rewrite copies most of its window, so lookup or draft decoding against the old window should help on the local host (not measured).

Filters before showing: drop a suggestion that is empty, equals the existing text, repeats the line after the cursor (the usual FIM failure), or does not parse in the language when the cursor is in code.

### Models

| Model | What | Read |
|---|---|---|
| Qwen2.5-Coder base, 0.5B to 32B | The common FIM reference, with repo-level file sections in its format (*the tokens: unchecked*) | 7B card: Apache-2.0, 131k context (32k default); check each size's licence |
| Sweep next-edit v2 7B, and a 1.5B GGUF | Next edit, on Qwen2.5-Coder-7B with SFT, GRPO and DPO on editing traces | Apache-2.0; 32,768 context, up to 1,024 output tokens; sections separated by `<\|file_sep\|>`: about 300 lines of file around the cursor, retrieved chunks, recent diffs as `original:`/`updated:`, then `original/`, `current/` (with `<\|cursor\|>`) and `updated/`, which the model completes, seeded up to the cursor line; stops at `<\|endoftext\|>` or `<\|file_sep\|>` |
| Zeta 2 (Zed) | Open-weight next edit; about 100,000 training examples; adds language-server context | Base model, size, prompt format and licence not read: check before relying on it |
| Mellum 4B (JetBrains) | FIM completion with multi-file context (same directory, directory distance, retrieval) | Apache-2.0; 8,192 context; base, SFT and DPO variants; FIM with the suffix first; designed for 90% of requests under 500 ms in production; on CPU alone up to 3 s |
| Seed-Coder 8B base (ByteDance) | FIM | MIT; 32,768 context; `<[fim-suffix]>`, `<[fim-prefix]>`, `<[fim-middle]>`, written in that order, ending at the middle token |
| Qwen3-Coder 30B-A3B | A chat and agent model with 3.3B active of 30.5B | Apache-2.0; 262,144 context; its card does not mention FIM, so use it for `edit` through a generic format, not `fim`, until shown otherwise |
| Codestral 22B v0.1, StarCoder2, DeepSeek-Coder (and V2-Lite) | FIM-trained code models (*unchecked*) | licences and sentinels to read; the FIM tokens differ between them |

Size is set by latency, not by capability alone: roughly 1B to 7B (or a mixture-of-experts with few active parameters) for completion, more for next edit, where in one study (Next Edit Prediction, arXiv 2508.10074, a 210-commit benchmark) judged quality rose from 42.4 at 3B to 61.0 at 32B for Qwen2.5-Coder, and a fine-tuned 7B beat GPT-4o. Treat that as a hint. Base models for `fim`; for `edit`, a model trained on the format (Sweep, Zeta) or a capable instruct model.

### Evaluation, before an editor

A replay bench, like `tools/dialect-bench.ts`, run over git history: a **fim** task blanks a syntactic region of a file at a commit and scores exact match and edit similarity against the original; a **next-edit** task gives the state and the previous diff and scores whether it found the right place and the right content (the paper's position match and exact match). Report time to the first token and in total, with the prefix cache cold and warm, and tokens used. Use repositories the models cannot have trained on (private, or commits after their cutoff). Our own history, where the transcript says what the thread was doing, is the source for the thread-brief comparison: the same task with no brief, a hand-written one and a generated one.

### First results (2026-11-24)

**The bench**, Qwen2.5-Coder-1.5B Q8_0 on `llama-server` (CPU, 2 cores), 12 tasks from this repository's TypeScript (so the model may have seen some of it), 64 tokens at most:

- Both endpoints work, and neither needed special handling. `/infill` and a prompt we render ourselves from the Qwen format scored the same within noise (edit similarity 0.41 against 0.39, exact match 17% for both): with n=12 this says only that our rendering is not worse than the server's. Whether `/infill` is better for a model whose template the server knows less well is not answered.
- Other files as context did not help at this size (exact 8% against 17%, similarity about the same) and tripled the prompt. One small model on a dozen tasks is not evidence against repo-level context; it is a reason to run it on the larger models.
- The cache matters more than the endpoint: a cold 650-token prompt took about 10 s on this CPU, the warm repeat 1.5 to 5 s (it is mostly the 64 generated tokens at about 12 tokens a second). With other files, cold was about 21 s.
- Block completions scored lowest (exact 0%), as expected for a 1.5B model.

Not yet run: Mellum, Seed-Coder, StarCoder2, DeepSeek-Coder, and Sweep (the next-edit task and its scoring are not built). The sandbox has no GPU, so those runs belong on a machine that has one: `node tools/completion-bench.ts --model NAME=FORMAT ...`.

**The VS Code probe** (`extensions/vscode/probe`, VS Code 1.147 under xvfb; `pnpm --filter ... probe:inline`):

- Stable API: ghost text that inserts at the cursor works, single and multi-line, and is requested again automatically after typing and after an accept. A suggestion that replaces a range with text that does not extend what is already there is dropped silently (end of life "ignored", never shown), so a stable-only extension cannot show an edit to earlier lines.
- With the proposed `inlineCompletionsAdditions` API, `isInlineEdit` with a range on an earlier line renders as a diff (old line struck through, new line below, a gutter marker); accepting applies it and moves the cursor. `handleDidShowCompletionItem` and `handleEndOfLifetime` (accepted, rejected, ignored) fire, which gives the acceptance signal the request discipline wants. `jumpToPosition` behaved as a jump first and did not apply the edit with the commands I ran; `displayLocation` looked like ordinary ghost text.
- The proposal needs the `enabledApiProposals` entry in the manifest and, outside development, a launch flag. A provider with proposal members is refused outright without them. Whether the Marketplace accepts such an extension is from memory and unverified: check before relying on it. The fallback is stable ghost text for `fim` and for the part of an edit at the cursor.

**The executable bench** (`tools/exec-bench.ts`, 2026-11-24): 38 small JavaScript modules with tests; 63 fill-in tasks (spans blanked) and 36 next-edit tasks (a rename made at the declaration only, or a changed signature or return value whose callers have not caught up); an answer is right if the module's outputs match the original's. Qwen2.5-Coder-1.5B, all 63 fill-in tasks: **87%** work through our prompt and **83%** through `/infill` (blocks 80% and 70%), while only 54% and 51% are the original text, so about a third of the working answers are ones an exact-match score calls wrong. The two endpoints are within noise on lines, and `/infill` was worse on blocks (three syntax errors against one), which one run does not settle. The filters cost something: a closing bracket the suggestion itself opened was cut as the editor's own (`items.slice(i, i + size)` before `);`), which turned working answers into syntax errors: fixed (it now cuts a closer only when the suggestion has more closers than openers), and the bench is how to see the next one. **Next edit, Sweep 1.5B** (Q8_0, Apache-2.0): its model card's `run_model.py` shows a layout that is not the 7B's (no cursor marker or line ranges; `PATH.diff` hunks; the whole file before, now and after; the answer is the whole file), so it has its own format, `sweep-next-edit-1.5b`. On all 36 edit tasks: **97%** work (renames 33 of 33, edits to a changed signature or return value 2 of 3), 75% are the original text, median 11 s on this CPU (the whole file is written). The one failure left the call without its new argument, the half-finished state the task is made of. The 7B layout fed to the same 1.5B model, on 8 tasks, gave 7 of 8: too few to say the layout matters. Renames are too easy to separate models (a 1.5B model never misses one in a 15-line module), so there are now 11 harder edits written by hand (a changed return shape, a parameter turned into an options object, a method renamed, an argument order swapped, a boolean inverted: each used in two to four places). The suite is 46 modules, 63 fill-in tasks and 44 edit tasks. Sweep 1.5B on the 11 hand-written edits: **55%** work (36% the original text), median 15 s.

**All eight models, GPU run (2026-11-27)**, 63 fill-in tasks (works / the original text) and 44 edit tasks:

| model | via our prompt | via `/infill` |
|---|---|---|
| Qwen2.5-Coder 1.5B | 86% / 54% | 84% / 51% |
| Qwen2.5-Coder 7B | 89% / 59% | 90% / 62% |
| Seed-Coder 8B | 90% / 56% | refused (501) |
| Mellum 4B | 76% / 49% | 71% / 48% |
| DeepSeek-Coder 6.7B | 73% / 29% | 73% / 29% |
| StarCoder2 7B (with `special: true`) | 81% / 44% | not measured |
| Sweep 1.5B, as a fill-in model (24 tasks, run here) | 79% / 54% | 50% / 29% |

Next edit: Sweep 1.5B 89% (renames 100%, hand-written edits 55%), Sweep 7B 91% (100%, 64%). Reading it:

- Our prompt is as good as `/infill` everywhere it was tried, and `/infill` is unavailable for Seed-Coder, whose sentinels (`<[fim-prefix]>`) llama.cpp does not know. Bearing in mind that `/infill` also took the Sweep model from 79% to 50% where our prompt did not, the formats are worth having and `/infill` is not something to depend on.
- The best fill-in model is not the biggest: Seed-Coder 8B and Qwen 7B are level, Qwen 1.5B is 3 to 6 points behind at a fifth of the size and half the latency, and the 4B Mellum is behind both, which may be our guess at its layout (not confirmed).
- Exact match is a poor judge: DeepSeek-Coder works 73% of the time and writes the original text 29%. (Its answers are the same through both endpoints, to the figure.)
- StarCoder2's 8% was a harness fault, confirmed: its end marker (`<file_sep>`) is not one llama.cpp recognises by name (its list holds Qwen's `<|file_sep|>` and Granite's `<reponame>`, not StarCoder2's `<file_sep>` or `<repo_name>`), so the server neither stopped there nor printed it, and 55 of 63 answers ran on into an unrelated file. Started with `options: { special: true }` the marker is printed, our stop string matches, and the model scores **81%** (51 of 63; 44% the original text) through our prompt. The same applies to any model whose stop token the server does not know: it needs `special: true` or a stop it can see. The `/infill` arm scored 3% in that run only because the bench did not send the format's stop strings to it; it does now.
- Answers that run on after a correct middle (into the code already after the cursor, and then into more of the model's own) are now cut where they reach that code (`providers/completion/filters.ts`, the two lines after the cursor found again in the answer). Measured on every saved run, as shown versus raw: DeepSeek-Coder +2 of 63, StarCoder2 +1 to +3, nothing worse anywhere.
- Sweep keeps its fill-in ability through our prompt (79% for the 1.5B against Qwen's 86%), so one Sweep model could serve both; through `/infill` it does not.

**Mellum and Zeta 2.1 (2026-11-27).** Mellum's format was checked against its card's example and renders it byte for byte (the card's own stray space apart), and its answers end cleanly (`eos` in 56 of 63), so its 76% is the model's, not a harness fault. Zeta 2.1 (Zed, Apache-2.0, fine-tuned from Seed-Coder-8B-Base, which is why Seed-Coder's score matters) is the `zeta-2.1` edit format, written from its card and sample prompt: a suffix-first prompt of related files, the edit history as a diff (`<filename>edit_history`) and the file, with an editable region cut by numbered `<|marker_N|>` markers and the cursor marked; the model answers with two markers and the new text between them, so it writes only what it changes (about 90 tokens, against Zeta 2's 270). Two things in it are guesses: how far apart the markers are (the sample has them 14 to 16 lines apart; ours are 8) and how large the region is (the whole file up to 41 lines, else 20 each side of the cursor lines). The marker, cursor, and `<filename>` strings are ordinary text in its tokenizer (only the sentinels and the end of sentence are special tokens), so it needs no `special` option. There is no official GGUF; `adilkairolla/zeta-2.1-GGUF` (Apache-2.0, Q8_0) is a conversion. First run (2026-11-27): 34%, because a span over several markers writes the markers in between out again and the parser kept them as code (fixed: they are taken out); a rough re-grade of those answers gives renames about 31 of 33, the rest unknown until rerun. Asked for plain fill-in (as a Seed-Coder model) it scores 0%: with no markers in the prompt it answers `<|marker_1|><|marker_1|>`, which looks like its "no edit" reply, so the fine-tune lost fill-in, where Sweep kept it. StarCoder2 through `/infill` with the format's stop strings: 81% works (83% as shown), the same as through our prompt.

**Context and notes measurements (2026-11-27).** `exec-bench.ts` now has 12 cross-file modules (`cross-*.fn`, with the other file in `NAME.ctx`) and 10 notes modules (`notes-*.fn`, a project convention the right answer follows, plus a plausible wrong answer that must fail), and arms for them: `completion+files`, `infill+files` (the other file as context), `completion+notes` (the note as a comment banner in the prefix) and `completion+notes-file` (a pseudo-file `NOTES.md`). The summary has `set:cross` and `set:notes` rows. First run, Qwen 2.5 Coder 1.5B on CPU (small n, 16 and 10 tasks): cross-file 6% without the other file, 63% through `completion+files` (56% through `/infill`); notes 10% without, 30% as a banner, 20% as a file. So context files are worth the most by far, and a banner beat a note file for this small model. `tools/completion-typing.ts` replays typing against a server (a request every few characters) and reports tokens evaluated per keystroke and the cached share, with `--cache-reuse` to compare; on a 96-token prompt 88% was cached, but with 6000 characters after the cursor (a 1,838-token prompt) **0% was cached**: Qwen's prefix-first order puts the changing text before the suffix, so the server re-evaluated about 1,836 tokens per keystroke (19 s each on this CPU). Without `--cache-reuse` that is the cost of typing in the middle of a file; whether `--cache-reuse` and a suffix-first format (Seed-Coder) fix it is the GPU run's question.

### Open

- Whether `/infill` beats our own prompt for any model (see the results above; needs more models and more tasks).
- Whether `localmodels` can serve a base model with no chat template and a FIM request (`/completion` is what the dialects use).
- Whether the proposed edit API is usable in a published extension.
- Whether the brief is a new entry kind, a file in the workspace, or the latest compaction summary.
- Where the completion model is set: the project's settings, not a thread's, since a completion is not part of any one thread.

## Merge policy per environment, file or hunk: the design

**Today.** Merging a subagent or a fork (`finishSubagent`, `mergeFork`) has one policy: *trunk wins, per file*. Files only the child changed come across; a file both sides changed keeps the trunk's version whole, and the merge entry records exactly what happened (`files.changed/added/discarded`, `merge.conflicts`). That is safe and predictable, and it is the right default for code, but it is too blunt for other kinds of work.

**The idea.** The workspace an agent works in is an *environment*, and different environments want different rules. Examples:

| Environment | What it wants |
| --- | --- |
| Source code | Hunk-level merge; on a true conflict of hunks, trunk wins (or ask). |
| Prose and docs | Hunk-level merge; on conflict keep both with a marker for a human or a follow-up turn. |
| Data files, logs, append-only | `union`: keep both sides' additions. |
| Lockfiles, generated output | Take neither: drop both sides and regenerate (run a command after the merge). |
| Binary assets | File-level only; child wins if the trunk did not touch it, otherwise trunk. |
| Notes the agent owns (`notes.md`) | Child wins: the subagent was *asked* to update it. |

Two independent choices make up a policy:

- **Granularity**: `file` (what we have) or `hunk`.
- **Resolution** for what cannot be merged cleanly: `trunk`, `child`, `union`, `ask` (leave the branch unmerged and tell the model what is in the way), or `regenerate` (drop both, run a command).

**Where it is configured.** In `harness.yml`, so it is versioned with the repository:

```yaml
merge:
  default: { granularity: file, resolution: trunk }   # today's behaviour
  rules:                                              # first match wins
    - { paths: ["src/**", "test/**"], granularity: hunk, resolution: trunk }
    - { paths: ["docs/**", "*.md"],   granularity: hunk, resolution: union }
    - { paths: ["*.lock"],            resolution: regenerate, command: "pnpm install" }
    - { paths: ["data/**/*.jsonl"],   resolution: union }
```

The policy used is the one recorded in the *receiving* branch's configuration at merge time, and the merge entry records which rule applied to each path, so a later reader never has to guess.

**How hunk-level could be done.** `git merge-tree --write-tree` (which we already use; the minimum is git 2.40, ADR 39, because `--merge-base` needs it) reports conflicted paths but does not itself offer per-hunk resolution at our minimum version. Two routes:

1. For each conflicted path, run `git merge-file -p --ours|--theirs|--union <current> <base> <other>` on the three versions (read through `catFile`) and write the result into the merge tree with `rewriteTree`. `merge-file` has existed for a very long time, resolves conflicting *hunks* (not whole files) by the chosen side, and needs no new git version. Binary files must be detected first and kept at file level.
2. Use `merge-tree -X ours|theirs` if a later minimum version has it (to be checked before relying on it).

**Format impact.** The merge report grows: per path, the rule that applied, the granularity, and for hunk merges the number of hunks taken from each side. That is an additive format change; `policy: "trunk"` stays valid and is simply the default rule.

**Open questions.**

- `ask`: does the merge refuse and leave both branches as they are, or does it merge everything else and report the unresolved paths? Either way the model needs a way to resolve and retry; a "resolve" turn on the child branch is the natural shape.
- `union` on prose can produce duplicated or contradictory paragraphs; is it only for line-oriented data?
- Is `regenerate` a merge feature at all, or a post-merge hook the environment owns?
- Determinism: resolution must depend only on committed state (the three versions and the recorded config), never on timing or on a model call inside the merge, so a merge can be re-verified from the history alone.
- Interaction with attached repositories (ADR 38, built): the code is merged by state, per repository, and the policy rules above would apply to the conversation's own files only; whether a rule may name a path inside an attached repository (`code/**`) is open.

**First step.** Put the policy type and rule matching (pure, no git) behind the existing merge code, keep the default identical to today's, and add hunk granularity with `merge-file` behind it, with a test per row of the table above.
