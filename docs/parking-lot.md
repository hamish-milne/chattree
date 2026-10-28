# Parking lot

Things deliberately left out, with enough context to pick them up later, grouped by priority:

- **High**: correctness. Left alone, it could lose data, show wrong output or block the user.
- **Medium**: features and support. Wider application or significant functionality, weighed against the cost.
- **Low**: small conveniences, unusual edge cases, minor performance gains.
- **Deferred**: pricing data that comes from external pages. It affects no other code, so it is cleaned up close to release.

Each entry says what it is and what a first step would be. Within a group, the order is the order of intent.

## High

- **Verify the Anthropic adapter against the real API.** No free tier, so today it is only checked against Ollama's
  compatible endpoint. From memory: the request shapes for `system` and `cache_control`, breakpoints, lifetimes and
  multipliers. If one is wrong, the paid provider's requests fail. Needs a key and a small spend.

## Medium

- **Tool loop above `requestStream`**: the turn's deadline, `max_requests_per_turn`, tool results, and raising `cost`
  warnings as events from `Prepared.warnings`. The next layer rather than a gap in this phase.
- Merge policy per environment (below), and the production workspace split (below).
- **OpenAI compaction on the real API**: check `context_management`, dropping items before a compaction item, and the
  not-found error the chain fallback matches. Opt-in features. Spend sparingly: the free tier is limited, so use
  `--only` to pick scenarios.
- **API-backed model catalog**: `/models`, and llama-server's `/props` for the context size.
- **Check the `openai-compatible` adapter against a real llama-server** (`--jinja` tools, `reasoning_content`, the usage
  chunk; the list is in docs/providers.md step 8).
- **Windows**: the `Host` seam keeps Node-specific code out of the core, and paths go through `host.path`, but the suite has
  only been run on Linux.
- **A `chattree` command** that creates `.chattree/env`, with a `secrets check` that lists the variables each provider needs.
- **A command-line verifier**: `chattree verify` and `chattree graph` over `verifyHistory` and `readCommitGraph`, so they
  work on any conversation repository.

### Merge policy per environment, file or hunk (the main one)

**Today.** Merging a subagent or a fork (D6, `finishSubagent`, `mergeFork`) has one policy: *trunk wins, per
file*. Files only the child changed come across; a file both sides changed keeps the trunk's version whole, and
the merge entry records exactly what happened (`files.changed/added/discarded`, `merge.conflicts`). That is safe
and predictable, and it is the right default for code, but it is too blunt for other kinds of work.

**The idea.** The workspace an agent works in is an *environment*, and different environments want different
rules. Examples:

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
- **Resolution** for what cannot be merged cleanly: `trunk`, `child`, `union`, `ask` (leave the branch unmerged
  and tell the model what is in the way), or `regenerate` (drop both, run a command).

**Where it is configured.** In `harness.yml`, so it is versioned with the repository (there is no `config_changed` entry any more):

```yaml
merge:
  default: { granularity: file, resolution: trunk }   # today's behaviour
  rules:                                              # first match wins
    - { paths: ["src/**", "test/**"], granularity: hunk, resolution: trunk }
    - { paths: ["docs/**", "*.md"],   granularity: hunk, resolution: union }
    - { paths: ["*.lock"],            resolution: regenerate, command: "pnpm install" }
    - { paths: ["data/**/*.jsonl"],   resolution: union }
```

The policy used is the one recorded in the *receiving* branch's configuration at merge time, and the merge
entry records which rule applied to each path, so a later reader never has to guess.

**How hunk-level could be done.** `git merge-tree --write-tree` (which we already use, git ≥ 2.38) reports
conflicted paths but does not itself offer per-hunk resolution at our minimum version. Two routes:

1. For each conflicted path, run `git merge-file -p --ours|--theirs|--union <current> <base> <other>` on the three
   versions (read through `catFile`) and write the result into the merge tree with `rewriteTree`. `merge-file`
   has existed for a very long time, resolves conflicting *hunks* (not whole files) by the chosen side, and
   needs no new git version. Binary files must be detected first and kept at file level.
2. Use `merge-tree -X ours|theirs` if and when the minimum version is raised to one that has it (to be checked
   before relying on it; we avoided depending on it in step 4).

**Format impact.** The merge report grows: per path, the rule that applied, the granularity, and for hunk merges
the number of hunks taken from each side. That is an additive format change (minor 1.4, since 1.3 went to `tool_result.full`); `policy: "trunk"` stays
valid and is simply the default rule.

**Open questions.**

- `ask`: does the merge refuse and leave both branches as they are, or does it merge everything else and report
  the unresolved paths? Either way the model needs a way to resolve and retry; a "resolve" turn on the child
  branch is the natural shape.
- `union` on prose can produce duplicated or contradictory paragraphs; is it only for line-oriented data?
- Is `regenerate` a merge feature at all, or a post-merge hook the environment owns?
- Determinism: resolution must depend only on committed state (the three versions and the recorded config), never
  on timing or on a model call inside the merge, so a merge can be re-verified from the history alone.
- Interaction with the production layout (item 3): a merge across the code submodule and the chat repository.

**First step.** Put the policy type and rule matching (pure, no git) behind the existing merge code, keep the
default identical to today's, and add hunk granularity with `merge-file` behind it, with a test per row of the
table above.

### Production workspace split (D8)

The MVP keeps chat and project files in one repository. The production shape keeps the project in a submodule
with the pointer tracked in the chat repository (plus branch name and a saved diff of uncommitted changes). This
also lets one agent flow work across several repositories. It touches snapshots, forks, merges and verification.

## Low

- **CLI refinements**: ghost-text suggestions in the prompt; streaming one session's reply to another by tailing the
  journal; a per-user preferences file; a coordination daemon over a named pipe (revisit with the tool loop).

- **Attachment capabilities**: a per-model `input: [text, image, pdf]` list so a request with a file the model cannot take
  is refused early and a model switch warns (`capability_loss`); today the provider's error is the signal, and the
  Chat Completions adapter refuses PDFs itself. Also: downscaling large images before sending, and SVG (sent as text).

- **Token counting, further**: llama-server `/tokenize` for the openai-compatible adapter (unverified), and calibrating the
  bytes-per-token estimate from the usage of earlier requests for providers with no counting endpoint.

- **Recovery that checks the owner is dead.** A journal that goes quiet is taken for dead after `journalStaleMs`; a suspended
  but living process is only caught by the commit-time ownership check (`RequestSuperseded`), after its work is wasted.
  A `Host` method that says whether a process is alive would let recovery on the same machine wait for it.
- **Journal extras**: keep a copy of the events of failed requests outside the repository for debugging; a `follow`
  helper so a second process can tail a request's journal (nothing reads it live yet); record the digest the adapter
  computed for the request so a recovered OpenAI response can still be chained from.
- **Usage as it arrives** on `openai-compatible`, not only at the end. A stream that dies mid-way reports no tokens,
  which matters only for a hosted Chat Completions provider. The alternative is to report running totals as events and
  let the result differ.
- **More Chat Completions settings**: `tool_choice`, `parallel_tool_calls`, JSON schema output; an `is_error` prefix for
  tool results (the API has no flag, so errors are plain text).
- **Cache and tool options**: mixed cache lifetimes within one request (the docs allow it, longer first: the pinned
  prefix at 1h and the conversation at 5m; OpenAI's per-breakpoint `prompt_cache_breakpoint.ttl`; today one
  `cache_ttl` covers every marker); an Anthropic equivalent of `allowed_tools` for restricting tools without changing the
  prefix; OpenAI standalone compaction (`/responses/compact`) for compacting on demand.
- **Pricing extras**: calibrate the estimate from the last response's real usage; Anthropic's `inference_geo` 1.1x
  multiplier and batch discounts; OpenAI's regional-processing uplift.
- **Provider checks and fixtures**: a live A/B of OpenAI stored (`previous_response_id`) versus stateless replay (cost,
  cached tokens, latency; needs a key); whether OpenAI hosted tools (web search, code interpreter) need server-side
  state; the OpenAI WebSocket continuation cache; record fixtures from `tools/live-check.ts --record` runs against
  Ollama (known caveats: no `cache_control` or `tool_choice`, in-stream errors are unreliable, small models may not call
  tools or reason, so those scenarios skip).
- **A merge's rollup** resolves tables the child pinned only from this conversation's providers and blobs, so a child that
  pinned a table which no longer exists here is counted as unpriced (the safe default: unknown is never zero).
- **Events are in memory.** `onEvent` is delivered after commit, but a crash between commit and delivery loses the event.
  Consumers that must not miss anything should rebuild from history (`index()`, the `recovery` event); an at-least-once
  persisted outbox is possible if needed.
- **Index cache assumption.** A cached index is extended when its tip is an ancestor of HEAD, which for a branch that has
  only ever advanced is also on its first-parent line. A branch reset to a sibling line that still contains the old tip
  would be indexed from a longer `git log`, not wrongly, but a first-parent check would make that explicit.
  `verifyHistory` never uses the cache.
- **Locks across machines.** Locks are files, which is right for one machine and for local-disk worktrees; a network file
  system with weak `link`/`rename` semantics is not supported.
- **A persistent `fast-import` process.** Considered and parked on measurement. An append costs two short git processes
  (stage, commit), about 12 ms; the floor is git's own index and commit work. A long-lived `fast-import` would need
  `checkpoint`/`get-mark` round trips for the hash, would leave the index behind the commit (needing `reset` anyway), and
  would add a process to supervise on every handle. `appendMany` already makes bulk writes constant-cost. Revisit only if
  profiling a real agent loop shows process start-up dominating.
- **Renderers**: verifying a renderer's output at runtime (a self-test with fixed inputs, output hash recorded in the
  setup). Decided: stability is part of the renderer interface contract (an id is immutable, renderers are pure), not
  something the harness defensively checks, at least for now. Revisit if host-supplied renderers cause drift.
- **A VS Code helper** that adds the `!tag` custom tags to settings (`yaml.customTags`).

## Deferred: pricing data

Prices come from external pages and affect no other code. Accuracy matters for the cost shown and for limits, so clean
these up together before release.

- **OpenAI**: the long-context threshold is not stated on the page (272k is assumed, from earlier GPT-5.x models); which
  `service_tier` value selects "Fast" (Priority was renamed Fast on 2026-07-30) is unverified; `gpt-6-luna` has no Ultrafast
  price; `gpt-5.4-mini` and other smaller models are no longer on the page; `chat-latest` (an alias) and the cyber
  (`gpt-5.6-sol`, `gpt-5.6-cyber`) and life-sciences models are left to overrides. The tier-to-table binding is
  confirmed (the page's URL carries `latest-pricing=standard|batch|fast|ultrafast`; our `flex` is the page's "Flex/Batch").
- **Anthropic**: the table came from a summarising read of the pricing page; read it in a browser as was done for OpenAI,
  and add the older models once their API ids are confirmed.
- **Prompt caching prices and multipliers** for Anthropic (lifetimes, write multipliers) are verified together with the
  adapter's request shapes (High).

## CLI (left after the first complete version)

Low unless noted. The CLI is chat-only: the tool loop is the next big piece (the engine, activity model and renderer leave room for it).

- **Tool loop** (Medium): planned in `docs/tools.md`; the CLI notes a `tool_use` stop and stops there until it is built.
- **`chattree doctor`**: git and Node versions, providers and keys, a request to each provider with `--online`.
- **`--json` output** for the non-interactive verbs, for scripts.
- **Ghost-text suggestions** and a configurable way to end bare text (today: a blank line sends).
- **Another session's streaming reply**: a second session shows the finished entries as they land, not the stream (tail the journal).
- **`/threads`**: how many sessions point at each thread (`/thread` shows it for the current one).
- **Summaries from `/merge` and `/compact`** are not in the cost ledger (the usage is shown when they are made).
- **Sessions**: `/sessions` cannot yet delete or adopt one; a stale session file is removed by hand.

## Tools (follow-ups from docs/tools.md)

Not part of the first tool loop.

- **OS-level sandbox** for `run` and `script` (container or restricted user): the real answer to approved commands having the user's permissions (Medium).
- **Search and web tools** (`grep`, `fetch`) if `run` proves awkward for them.
- **Image and PDF results** from `read`: a tool result that carries an image needs adapter work.
- **Parallel foreground calls**: today they run in order; background jobs are the concurrency story.
- **MCP servers and user-defined tools**: the registry is shaped for them.
- **Detached jobs** that outlive the CLI process (today a crash marks them lost).
- **Strict mode for Responses** (`strict: true`) for definitions that fit it.
- **Use a validation library for tool schemas** instead of `harness/tool-schema.ts`. `zod` is already a dependency (4.6.7, which has `z.fromJSONSchema`), but it is listed under `devDependencies` while the harness imports it at runtime, so that needs fixing first. An off-the-shelf validator would also take on keywords beyond the portable subset; the subset check at registration would stay, since it is about provider portability, not validity.
- **File-reference tool results** (Medium): store a `read` result as a reference (path, offset, length at the entry's commit) re-rendered when the context is built, instead of a copy. The result is formatted with headers and line numbers and can hold several files, so it needs the renderer to run at read time and a format version bump with verifier support. Until then a large result is a blob, shared by hash between identical re-reads.
- **Exact stdout/stderr interleaving** for `run`: the two pipes are separate, so order is by arrival. Exact order needs the child's two descriptors to be one pipe, which Node cannot ask for directly.
- **Describe the host environment to the agent** (operating system, shell availability, which utilities `run` has and where they come from, the working directory, the date): one block in the system prompt, built by the host. Until then `run`'s description says only that it takes a cross-platform bash-like syntax with common utilities and the host's programs.
- **Text-protocol tool calls** for models without reliable native tool calling (e.g. `<call name="run">` blocks with raw, unescaped values), so a large command or file body needs no JSON string escaping. Revisit if the sampler shows escaping slips.
- **`run` stderr handling:** `2>/dev/null` is accepted and ignored (stderr is shown with stdout). Separating stderr per stage would let it really discard, and would let results label it.
- **Pin the busybox download:** `tools/fetch-busybox.ts` prints the zip's SHA-256; once a release is settled on, check it against a pinned value.
- **The transcript is inside the workspace the agent sees.** `ls -R` lists `blobs/`, `grep -r` matches `chat.yml` (including earlier tool results and thinking), and `git log` in the workspace shows the conversation's own commits. gemma and gpt-oss both stumbled over this (extra requests, repeated checks). Options: keep blobs and the transcript under a hidden directory, hide them from `run`'s globbing and listings, or say in the host description which files are the conversation's. Not done yet.
- **Sampler noise floor.** With 10 samples a task that really succeeds 95% of the time scores 9/10 or better only 91% of the time, so a per-cell gate of 9/10 over 51 cells is expected to miss about four by chance. Candidates: 20 samples per cell, a gate that only fails a cell if two runs in a row miss, and classifying each miss as tool, task wording or model.
- **Tool conventions, the rest** (docs/tools.md, 3.7). Built: `full` and `flat`, the refusal, the probe. Parked: (1) a `schemas` block per tool with a hand-written variant per convention and an optional description override, for the first tool that genuinely needs nesting (it must then provide a flat variant to be used on flat models); (2) `text`, calls written as text for models with no native tool calling, built on flat schemas; (3) `raw`, one unescaped text argument (like OpenAI's custom tools), probably for `script` only, which removes JSON string escaping for large commands; (4) bundled `tool_convention` values for models we have measured, once there are enough of them (today it is set in `harness.yml`, because the same model can differ between Ollama and vLLM); (5) a `--tool-convention` flag for the sampler, only needed once a tool is not flat.
- **Nested schema variants for `read`, `write` and `edit`**, to allow batch operation (several files, several changes in one call, applied together). They would be the first tools to need the per-convention `schemas` block above: a nested variant for `full` models and the flat one for `flat` models.
- **Tool instruction generation in llama-server.** When does the `flat` convention apply to user-supplied GGUFs, whose chat template decides how tools are shown? Can we provide our own renderer (a template or a pre-rendered prompt) so a model sees the full schema?
- **A provider option to disable streaming responses**, for debugging and for servers that stream badly. The adapters only parse streams today; a non-streaming response would be replayed through the same mapper, as the throwaway copy-probe patch did for the Anthropic flavor.
- **Test-case note: PELICAN.** Ollama's gpt-oss garbles the word PELICAN (misspellings, inserted zero-width or no-break characters) in about 5% of runs, in its reasoning and its output alike, even in plain native calls. Not our harness. Keep it in mind when choosing words for test cases, and note that a model can emit invisible characters in text.


## Background jobs

- **Live job output.** `job_output` reads a job's output only once it has ended, because `Host.run` collects output rather than streaming it. Streaming (an `onOutput` callback in `RunSpec`, a log kept in the job) would let the model read progress and `tail` a server.
- **Forks and lost jobs.** Recovery decides a job is lost when the branch's history says it started and has no event, and this process is not running it. A fork made while the parent's job is still running inherits that history, so the fork would mark the job lost although the parent still owns it. Fix by recording which branch a job belongs to (in the start result or a `job_start` marker) and recovering only that branch's.
- **Jobs and approvals.** A background job is approved when it starts; nothing re-checks a grant that lapses while it runs (noted in 5.1). A long-running job holding a stale permission is acceptable while jobs are only `run` and `script`; revisit for `subagent`.

## Windows batch programs

- **Resolve shims instead of running them through cmd.exe.** npm, pnpm and yarn install `.cmd` shims that only start `node <script>`. Reading the shim and starting `node` directly would avoid `cmd.exe` altogether, so no flag and no argument restrictions; it needs a parser for each tool's shim format, and breaks when a shim changes.
- **Local shims.** Done as `tools.run.local`, a glob allowlist for batch files that resolve inside the workspace (e.g. `./node_modules/.bin/*.cmd`). A custom shim parser (reading what the `.cmd` shim runs and starting that directly) is still not built.

## CLI backlog from the first real use (2026-10-28)

Collected after the first hands-on session (Windows, a Pong project built by gemma4:12b). Done in the same pass: `/merge` with no argument merges the current fork into its parent and moves there (`/merge <thread>` still merges a named fork into this thread); unnamed forks are `fork/1`, `fork/2` (the smallest unused number, archived threads count); `/merge` checks that the merge can happen (`Conversation.assertMergeable`) before it asks the model for a summary; the summary covers only what the fork wrote since it was last merged and the prompt says the main thread is not shown; the default editor on Windows is Notepad and `$EDITOR` may carry arguments (the path is now quoted).

- **Output display: done as `/display`** (`/show` was taken by "one entry in full"). `/display thinking on|brief|off` and `/display tools full|brief|off`, kept per session, applied to the live display, `/history`, the opening recap and the text handed to the model for summaries (`formatTranscript`, which also lets a tool result know which call it answers). `/export` still has its own `--thinking` flag and always shows tool calls as before. Not done: defaults in a settings file, `usage` as a third switch, and showing tools in `/log` (that is the commit list, not the conversation).
- **A readable log that looks like the TUI.** Mostly done: `/history [n]`, the recap when a thread opens, and the live display now share one format (`formatEntry`/`formatTranscript`: `you:` / model name blocks, `→` call lines, `←` result lines, honouring `/display`). Still to do: user messages in the prompt style, merge and fork markers drawn more clearly, a `/history all` pager, and wrapping to the terminal width.
- **Inline draft ↔ named draft without an editor.** A key combo that moves the half-typed draft into a named draft (and clears the prompt), and a command (`/paste <name>`, or `/draft <name> pull`) that puts a named draft back into the prompt for further typing, so `/send` is not the only way back. Needs the terminal layer to bind a key (readline `keypress`), so it belongs with the TUI work below.
- **CLI settings file.** User-level (not per thread): `%APPDATA%\chattree\settings.yml` / `~/.config/chattree/settings.yml`. First users: `editor` (with the Notepad/vi default), `/show` defaults, colour and width overrides, whether the prompt confirms `/undo`. Also the natural home for the busybox location if it should not live in vendor/.
- **`/exec <command>`.** Run a command in the thread's worktree and show the output, as the user (no approval, nothing recorded in the transcript unless asked: perhaps `/exec --record` writes it as a user message). Use the same portable layer as the tools (`portableStage`, busybox on Windows, the `script` semantics for pipes) so `/exec sh` and `/exec ls | wc -l` work everywhere. Needs `run`'s host plumbing without its approvals, plus streaming output and Ctrl-C.
- **`vite dev` 404 in a fork worktree.** Cause confirmed as the `%2F` in the directory name. Fixed: worktree directories are now `[A-Za-z0-9._-]` only (`fork/1` is `fork-1`, a taken name gets `-2`, ...). Original notes: needs logs from the failing run (the URL requested, vite's `--debug` output, and `dir` of the worktree). Suspects, in order: the worktree path contains `%2F` (`encodeURIComponent("fork/1")`), which is a hostile character to URL-minded tools and to cmd.exe, and a dot directory (`.chattree`) above the project root; the fork's files checked out but `node_modules` missing is not the cause (the page loaded). Worth trying: `/thread new side` (no slash in the name) and the same `vite dev` there, to see whether the `%2F` is involved. If it is, name worktree directories safely (e.g. `/` → `-` with a numeric suffix on collision) instead of percent-encoding.
- **Where worktrees live.** Forks are now nested inside the main worktree (`.chattree/threads/<name>`). Concerns: (1) the main thread's agent and every tool that scans the tree (grep -r, find, tsc's default include, vite/jest watchers, linters, an IDE) sees each fork's full copy of the source, so searches return duplicates and watchers do double work, which is the strongest argument against nesting; (2) Windows path length, with node_modules a few levels deeper; (3) `.chattree` has to be excluded from the main thread's snapshots (it is, through `.git/info/exclude`) and from anything that copies the directory. Against a fully bare layout (`.chattree/threads/main`, an empty root): `chattree init --adopt` and the idea that the user's own checkout is the main thread would go, and an IDE opened on the root would show nothing. Recommendation: keep `main` where it is (the user's directory), move forks out of the tree to a sibling or per-user location (`<root>.chattree/threads/<n>` or the settings file's data directory keyed by project), and make the location a setting. Done so far: the worktree root is configurable with `git config chattree.worktrees <path>` (relative to the main working tree, or absolute; default `.chattree/threads`), used for every new worktree; existing ones are found by branch wherever they are. Still open: a switch to keep `main` out of the repository root (and `init --adopt` moving the current checkout into the worktree folder), a default outside the tree, and `git worktree move` for existing nested worktrees.
- **TUI improvements.** Done (batch 1 and 2): `/display` and the shared readable history; colour in the history as in the live display (labels bold, tool lines dim, errors red); width detection and wrapping of history and recap entries (hanging indent kept, code fences and long words left alone; not re-wrapped on resize); arrow-key selection for tool approvals and yes/no questions (up/down or k/j, a letter jumps, Enter chooses, Escape or Ctrl-C gives the default, which is highlighted first). To plan: colour themes and a light/dark setting; wrapping of command output such as tables; a status line that stays at the bottom (model, thread, cost, running jobs); a scrollable pager for long output (`/expand`, `/history`); syntax highlighting and diff colouring in tool previews; live streaming of job output; multi-line editing with cursor movement inside the draft; mouse handling off by default; Windows console quirks (legacy conhost, `chcp`, VT sequences) on a real machine; key bindings for the draft/named-draft moves above; selection lists for `/thread`, `/undo n` and `/accept`; re-wrapping on resize.
