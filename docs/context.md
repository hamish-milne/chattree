# Context and tool management: instructions, skills, MCP, injections

How the text and tools in front of the model are managed, and how they change during a conversation without
rewriting the cached prefix. Builds on P10 in providers.md (pinned definitions). Decisions are recorded here as they were agreed.

## 1. Principle

The context is a fold over history on every request, so rebuilding it costs no CPU. What costs money is changing the
bytes of the provider's cached prefix (tools, system, instructions, the early turns). Drift handling is therefore about
which changes can be made as **deltas at the tail** of the conversation instead of edits to the prefix.

## 2. The pieces

- **Static instructions** (done): one pinned text per thread, edited with `/instructions`. The host composes it from layers
  when it sets a thread up (user level, project `AGENTS.md`, thread text); `/instructions reload` takes a new snapshot.
- **Skills** (done): the Agent Skills layout (a directory with `SKILL.md`, `name` and `description` in the frontmatter, other keys kept as
  metadata), searched in the user's directory (`CHATTREE_SKILLS_DIR`, else `chattree/skills` under the config directory), then `.agents/skills`
  and `.chattree/skills` of the project root; a later one wins a name, so a project's skill replaces the user's. The pinned unit is the whole
  `SKILL.md`: a value `{name, description, body, meta?, dir?}` in canonical JSON, kind `skill`, blob-stored, so the hash covers the body, the description and
  the directory. A one-line catalog (name and description, one line each, at most 50 lines of at most 200 characters) follows the instructions
  in the prefix. It lists what the *prefix* shows (`AgentSetup.prefix.skills`), not the current setup, and only when the `skill` tool is pinned
  (a catalog of what the model cannot read would only mislead). The `skill` tool takes a name and returns the body as a tool result, from the
  current setup; `/skill <name> [what to do]` records the body as a user message and runs a request; `/skills` lists them. A skill from a directory
  has the directory in the result, so `read` and `run` can reach bundled files (`read` cannot open `.chattree/` or paths outside the workspace);
  a skill with no directory has no bundled files, which is a limit. The loader treats a skill as untrusted data: it reads at most 64 KiB, a link
  that leaves the skill's directory is not followed, frontmatter is bounded and parsed with the config rules (no anchors, aliases or tags), the
  name must be lowercase letters, digits and hyphens and equal its directory name, and a skill that fails any of this is skipped and reported,
  never a failed scan.
- **MCP** (`mcp:` in harness.yml, `harness/mcp/`): a server is a program on stdin and stdout (`command`, `args`, `env`, `env_from`) or an HTTP endpoint
  (`url`, `headers`, `bearer_env`, `header_env`); secrets are named by environment variable and never written to the file or the transcript. Tools only, over stdio and
  streamable HTTP; no resources, prompts, sampling or OAuth. Its tools join the registry as `mcp__<server>__<tool>`, so the loop, approvals and limits
  apply unchanged: **every call asks**, and the user can grant a tool (`/tools`) or the whole server (`allow: {all: <date>}` under the server).
  - **Nothing is started until the thread accepts the server's configuration** (`/mcp accept`), because a harness.yml can arrive with a cloned
    repository and a `command` is a program to run. The configuration without secrets (a header's name, not its value) is pinned in `agent_setup.mcp`; a changed
    command line, URL or environment is "changed" and not started until accepted again. A new thread copies the pins of the one it starts from.
  - **The tools are pinned like any tool's** (`agent_setup.tools`, hash of name, description and schema), but `syncTools` never follows a server silently:
    a new, changed or missing MCP tool makes the loop refuse (`ToolsOutOfSync`) until `/mcp accept` shows what changed and the user allows the `tools_changed`
    cache break. This is what stops a description swapped after approval.
  - **A tool keeps the schema the server wrote** (any JSON Schema for an object; one that cannot be compiled, such as a reference to another document, is not offered).
    What a model is shown of it is decided per model, at request time (`harness/schema-project.ts`, docs/tools.md 3.8); `/mcp show` says what a portable-only model would lose.
  - **Connections are pooled** (`harness/mcp/pool.ts`): one `McpPool` per process, keyed by the server's name, its whole configuration (secrets as a hash) and, for
    a program, the directory it starts in. A connection lives while a thread or subagent holds a lease and closes with the last one. A program starts in the thread's
    worktree by default (`scope: thread`), so a server that works on files sees that thread's files and each subagent has a process of its own; `scope: project` runs
    it once in the project's main directory for every thread (a server with state of its own). A url is always shared. `/mcp refresh` reads the tools again and shows
    the other holders as stale.
  - **Subagents get what their thread has** (`subagent.mcp`: `inherit`, the default, `none`, or a list of names). The child's setup carries the server pins
    (`copySetupTo`), the engine connects the servers for the child's worktree when its loop starts, pins their tools (`syncMcpTools`) and lets go when the loop ends.
    Approvals are the thread's: the child's worktree starts with the thread's `harness.yml`, so `mcp.<server>.allow` and `tools.<name>.allow` hold. A grant the
    parent gets after the child started is not seen by it.
  - **Limits, as built:** a server whose tool list changes while connected is flagged (`/mcp`) and read again on refresh, not followed; on Windows, a
    program that is a `.cmd` (`npx`) needs `command: cmd`, `args: ["/c", "npx", ...]`. Native tools, not a gateway tool (parked: a gateway keeps the prefix stable but
    weakens schema adherence).
- **Injections**: a rule is a pure function of (entries, folded context, config, clock) that returns zero or more `{key, text}`;
  it runs before each request. Each result is **recorded** as an `injection` entry (format 2.4), not generated at request time, so
  the context is identical on every later request, replays exactly, and is costed and audited like any message. A rule's state
  comes from the history ("every N turns" finds the last entry with its key). Sources: config rules in `harness.yml`, built-ins
  (near-limit and context-window warnings, today only shown to the user), and a TypeScript API. Injections cause no drift: their
  output is appended history, and the rules sit outside the transcript like the clock.

## 3. Drift: tail deltas by default

`agent_setup.apply` (format 2.4) is `append` or `rebuild`. The **prefix** is what the model's cached prefix shows for the instructions
and skills; it lags the setup after an `append` until something rewrites it (`AgentSetup.prefix`, folded from the entries).

| Change | Default | How |
|---|---|---|
| Instructions edited | append | The prefix keeps the old text; an "instructions were updated" message with the new text stands where the change was made (after the results of an open turn, like a queued message). |
| Skill added, changed or removed | append | A notice at that point lists what was added and changed (name and description) and what was removed; the `skill` tool serves the new body and refuses a removed one. The old catalog line stays until a rebuild. |
| Tools or MCP tool list changed | rebuild | The tools array is in the prefix: a cache break is unavoidable. |
| Model, renderer changed | rebuild | As before. |

Rules, as built:

- **Nothing is cached before the first request**, so a change then goes straight into the prefix and is not appended.
- A change that loses the cache anyway (a model, tool or renderer change, or whatever an adapter calls `cache_break`) also folds any
  lagging instructions and skills into the prefix, for free. A change that keeps the cache (a `max_output_tokens` edit) leaves it lagging.
- **A compaction is a rebuild**: it rewrites the history, so every append before it is folded into the prefix and its notice is dropped.
- `/rebuild` (`Conversation.rebuildPrefix`) folds lagging changes in on request; it is a `cache_break` the user must allow, and does nothing
  when the prefix already shows everything.
- A change to nothing but instructions and skills is an append whatever mix it is; a skills difference is classified as `instructions_changed` (the
  catalog rides with the instructions in the prefix), MCP stays `tools_changed`.
- Entries from before 2.4 have no `apply`: one that changes the instructions or skills always rewrote the prefix, and still does.
- A fork inherits the entries, so it inherits the lag. A subagent (fresh context) writes a complete first setup, which is a rebuild.
- Adapters classify an append as if the instructions had not changed, so it needs no flags; a rebuild is classified as before.

## 4. Build order and status

1. **Format 2.4 and the append/rebuild fold. Done.** `agent_setup.apply`, `injection` entries (`Conversation.inject`), `AgentSetup.prefix`,
   `pendingAppends`, `rebasesPrefix`, `hasRequested`, `loadDefinitions().prefixInstructions`, the builder's `instructionUpdates`, renderer methods
   `instructionsUpdated` and `injection`, `Conversation.rebuildPrefix`, `/rebuild`. Injection entries are skipped when reading what a thread is
   waiting for, like approvals.
2. **Injection framework. Done.** `harness/injections.ts`: `InjectionRule` (a function of `InjectionContext`: the prepared request, the flow's entries, the
   clock, `turns`, and `since(key)`, the responses since the key last spoke), `runInjections`, `usageRule`, `configRule`. `requestStream` runs the rules after
   `prepareContext`, records what they return with `Conversation.inject`, and builds the context again (so `onPrepared` and the provider see the final one); at most one
   entry per key per request, and a rule that throws is skipped and reported as an `injection_failed` warning. Rules come from `harness.yml` (`injections.usage`, default
   on: the near-limit, context-window and long-context warnings, per kind, repeated every 5 responses while they stand; `injections.rules`: a map by `key` (unique by construction; it is what the entry is recorded under) of `every` N responses,
   `first`, and `text` or a `file` read from the thread's workspace when the rule fires) and from the host (`TurnOptions.injections`). "Turns" are the model's responses.
3. **Skills. Done.** `harness/skills.ts` (loader, pinned value, drift, `syncSkills`, catalog, notices), `harness/skill-tool.ts`, renderer methods `skillCatalog` and
   `skillsUpdated`, the builder's `skillUpdates`, `/skills` and `/skill`. Skills are appendable like instructions (an entry changing both is one append).
   Following the disk is a per-kind policy in `harness.yml`: `skills: { follow: ask | auto | off }` (default `ask`): `ask` reports `N skills changed on disk` once
   (and in the status line) and `/skills sync` takes it, `auto` records an `append` at the start of the next request, `off` never looks. Instructions edits still ask.
   Decisions: a removed skill is announced and refused by the tool, and its catalog line stays until `/rebuild`; a skill whose file turns unreadable stays pinned as it
   was (not treated as removed); the catalog placement is the instructions string handed to the builder (`withCatalog`); the first sync is an ordinary change (nothing
   is pinned automatically under `ask`, a new thread must `/skills sync` once). Subagents inherit skills through `copySetupTo`, which now passes `skills` and `mcp` as
   deltas (they were silently dropped before); their tools are pinned by the subagent tool from the child registry, which includes `skill`. Left out: following
   the disk during a running tool loop (it looks at the start of a request), and a host hook for other sources (the loader takes a list of roots).
4. **MCP. Done.** `harness/mcp/client.ts` (JSON-RPC client; stdio and streamable-HTTP transports; no dependency), `harness/schema-project.ts`, `harness/mcp/servers.ts`
   (configuration pin, acceptance state, naming, tool wrapping, `McpServers`), `syncMcpTools` in `loop.ts`, the tool set's `mcp` and `reloadMcp`, the server-wide `allow`
   in the grant store, and `/mcp` (list, `show`, `accept`, `forget`, `refresh`). Then the pool and subagent access (above).

## 5. Trimming

The cheap kind of compaction: nothing is summarised, so no model is asked and no meaning is lost. The bulky parts of old entries are left out of what the model sees, and every word the user and the model wrote stays.

- **The entry** (format 2.5): `trim { upto, rule: { tool_results?, tool_args?, reasoning? }, by: user | auto }`. From that point the model is shown the entries up to and including `upto` with the parts the rule names left out: tool output of at least `tool_results` bytes (replaced by a line saying how big it was and that running the call again gets it back), text values of at least `tool_args` bytes inside tool-call arguments (the shape of the arguments stays; the provider's raw argument string goes), and, with `reasoning: true`, the model's reasoning. Nothing is rewritten or deleted: the transcript keeps everything and `/show` still reads it.
- **Replay is the same**: the rule is in the entry, and the two marker texts (`harness/trim.ts`) are frozen like a renderer's. Several trims add up (the smaller size and any reasoning win, per entry). A trim whose `upto` is unknown, compacted away or not before it does nothing, and `verify` warns (`trim-ignored`).
- **A trim is a rebuild**, like a compaction: it folds lagging appends into the prefix and loses the cache once, so the next request reads the context at the full input price.
- **By hand**: `/compact trim [keep]`. **Automatically**: see section 6.
- **Left for later**: summaries written automatically (the other strategies in the parking lot), a trim that spares a tool's results by name, and an undo.

## 6. Automatic compaction

`compaction` in `harness.yml` (`harness/compaction.ts`, called by `requestStream` before every request):

```yaml
compaction:
  auto: full            # off (default) | trim | full
  threshold_tokens: 140000   # default: 70% of the model's context window, if known; with neither, nothing happens
  keep_recent: 12       # the last entries stay whole
  summary_model: claude-haiku-5-5   # of the same provider; default: the thread's model
  summary_input: seen   # or raw
  trim: { tool_results: 2048, tool_args: 2048, reasoning: true }
```

**Order, at a request that would reach the threshold.** (1) Trim everything before the last `keep_recent` entries. With `auto: trim` this only happens if it takes out at least a tenth of the threshold (4 bytes to a token), because a trim loses the cache once; with `auto: full` any saving is taken. (2) With `auto: full`, if the request is still at the threshold **and it starts a turn** (the last entry with content is a user message or a finished job), write a summary of everything from the start of the context (an earlier summary included) up to the last `keep_recent` entries. The range never reaches into the open turn and never ends between a call and its result. Both writes come before the request, so the cache is lost once.

**Why not in the middle of a turn.** A summary there would hide the work the model is in the middle of, and a model that cannot see its own recent output loops and contradicts itself. So mid-turn only the trim runs. The default threshold is 70% of the window for the same reason: it leaves 30% for a long tool loop to finish its turn after a trim. The harness also tells the model once the request reaches 85% of the threshold (an `injection` under the key `compaction:soon`, repeated every 5 responses while it stands) that older output will be left out and that it should write down what it needs.

**Hard stop.** With `auto` on, a request that is still at 90% of the window after all that is not sent (`ContextFull`). The thread is intact; `/compact`, a new thread, or a lower `keep_recent` goes on from there.

**What the summarizer reads** (`summary_input`). `seen` (default): exactly what the main model sees for the range, so the past summaries and the trimmed entries. It always fits when the summarizer is the thread's model, because the request it replaces was smaller than the window. `raw`: the entries since the last summary, whole; if that does not fit the summarizer's window it falls back to `seen`; if that does not fit either, it is an error that names `summary_model`.

**Cost.** The summary request is checked against the limits in `harness.yml` before it is sent, like any request (`LimitExceeded`), and its usage is written into the `compaction` entry, which the ledger counts. `/compact` with a model-written summary does the same once the user accepts. The summary model is another model of the thread's provider; its price comes from that provider's pinned table.

**Failure.** An empty summary, or one as long as the text it summarises, is refused and nothing is recorded. A summary that does not bring the request under the threshold is an error (`CompactionInsufficient`, with the numbers and what to change); it stays recorded because it still helped, and no automatic summary is tried again until 6 more entries have been added, so the next request goes out. Nothing older than `keep_recent` to summarise is the same error.

**Not covered.** A request that already breaks a cost limit is refused (by `prepareContext`) before compaction can run; with the default threshold that is rare, and raising the limit or compacting by hand fixes it. Provider-side compaction (OpenAI's `compact_threshold`) stays a separate opt-in. A summary model on another provider is not supported.
