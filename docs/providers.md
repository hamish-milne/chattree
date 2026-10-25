# Provider adapters: plan (v2)

Status: **steps 1 to 6 of the build order are done** (`agent_setup` and its mutations, `config_changed` removed; the context builder and pinned definitions; the provider types and HTTP base; see section 5); the rest is a proposal. Version 2 folds in the first round of decisions. Decisions are numbered
P1–P12 so they can be accepted or changed one by one, as with `git-integration.md`. What changed since v1 is in
section 9; the few questions still open are in section 8.

## 0. Principles this plan rests on

1. **The transcript holds the agent's whole state; `harness.yml` holds only the outside world.** What the agent
   *is* (model, settings, tools, instructions, skills, MCP, pricing it was costed under) is folded from
   `agent_setup` entries on its branch. `harness.yml` holds machine setup (providers, environment variable
   names, host wiring) and the harness's disposition (limits). Its history is its git history, and a commit
   message is the place for a reason.
2. **Everything that can cost money or break a cache is changed by an explicit mutation**, never by a side
   effect, and a mutation that is not allowed fails with an error that says what and why, so a host can ask the
   user and retry.
3. **A limit is a limit.** A host that wants to bypass one changes the configuration.
4. **Providers decide what they can tell us** (model catalog, prices, capabilities) and how: an API, or a bundled
   table. The harness asks through an interface and never assumes a table is static.
5. **The transcript stays replayable without the provider.** Server-side conveniences are optimisations with a
   verified fallback to replay, never the only copy of anything.

## 1. Where we are

- `contextEntries(entries)` returns the **entries** a model should see (fresh-context markers, compactions). It
  does not produce provider messages, and nothing yet renders `subagent_result`, `fork_merge` or `interrupted`
  as text, or decides what happens to reasoning from another model. **That builder is the first piece of work
  (P1).**
- The `assistant` entry carries `provider`, `model`, `blocks` (text, reasoning with an opaque `payload` and a
  `provider` tag, tool calls with `args_raw`), `stop_reason`, `usage`, `ext`; `interrupted` carries `partial`
  blocks and `by`.
- `harness.yml` still holds a single `model:` block, tool/skill names and MCP servers, and a recorded
  `config_changed` entry type. Both are replaced by this plan (P6, P8).
- The write pipeline can redact patterns from strings before they are stored.

## 2. What the APIs look like (checked against current docs)

Only the facts that shape the design; sources in section 10.

| | Anthropic Messages | OpenAI Responses |
| --- | --- | --- |
| Streaming | SSE: `message_start`, per block `content_block_start` / `_delta` / `_stop`, `message_delta`, `message_stop`; `ping` anywhere; unknown event types must be tolerated | SSE: `response.created`, `response.output_item.added/done`, `response.output_text.delta`, `response.function_call_arguments.delta/done`, `response.reasoning_summary_text.delta`, then `response.completed` / `.incomplete` / `.failed`; every event has `sequence_number` |
| Block identity | `index` of the content block | `item_id` + `output_index`; function-call items have both an `id` and a `call_id` |
| Tool-call arguments | `input_json_delta.partial_json`, parse at `content_block_stop` | `function_call_arguments.delta`, full string in `.done`; `arguments` is a JSON **string** |
| Usage | `message_start.usage`, then **cumulative** counts in `message_delta.usage`; thinking tokens in `output_tokens_details.thinking_tokens` (included in `output_tokens`) | one object in `response.completed`: `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` |
| Reasoning round trip | Thinking blocks (with `signature`) and `redacted_thinking` must come back **complete and unmodified** in the active tool loop; dropping or editing them is a 400. Newest models may return an empty `thinking` string with only the signature | `include: ["reasoning.encrypted_content"]` returns replayable reasoning items (needed when a turn has a function call); the final `encrypted_content` is the one in `output_item.done`, not `.added` |
| State | none (stateless) | stored by default for 30 days; `previous_response_id` chains; `store: false` makes it stateless (and is forced for zero-retention accounts). `previous_response_id` does not carry `instructions`. All earlier input tokens in a chain are still billed as input |
| Context compaction | none provided by the API | server-side (`context_management` with `compact_threshold`, emitted in the stream) or standalone (`/responses/compact`); both work with `store: false`; the compaction item is **opaque and encrypted**, to be passed on as is; with `previous_response_id` the guide says not to prune manually |
| Stream recovery | resume only from the last **text** block of a partial response; `tool_use` and `thinking` cannot be partially recovered | background mode with `stream: true`: reconnect with `GET /responses/{id}?stream=true&starting_after=<sequence_number>`; background responses work with `store: false` but are kept only about 10 minutes |
| Provider-initiated model change | the streaming docs describe server-side **fallback** (a `fallback` block at each model boundary, `input_transformations` reported with a beta header) | aliases resolve to dated snapshots; the response reports the model that served it |
| Settings that matter | `thinking: {type: "adaptive"}`, `output_config.effort` (`low`…`max`, default differs by model), `max_tokens` is a per-request cap covering thinking | `reasoning.effort`, `max_output_tokens`, `service_tier` |
| Cache | prefix order tools, system, messages; changing effort or thinking settings invalidates it (*the order is from memory; the caching page was not reachable*) | prefix = hidden instructions, developer messages, tools (names, descriptions, schemas, **order**), history; `reasoning.effort`, `text.format`, `parallel_tool_calls`, compaction also change it. Newer models: write 1.25x (30 min) or 2.5x (12 h), read 0.1x; GPT-6 models have a `configuration_update` item that changes effort **without** altering the prefix |
| Cost surprises | thinking billed as output even when not displayed | reasoning tokens billed as output; above ~272K input tokens the **whole request** moves to a higher rate |
| Compatible servers | n/a | Responses is recommended for new work; from GPT-5.4 Chat Completions cannot call tools with a `reasoning_effort` other than `none`. llama.cpp, vLLM and similar mostly speak Chat Completions |

## 3. Decisions

### P1. A context builder comes first, and it is pure

`buildContext(effectiveSetup, entries) → ModelContext`, no network, no provider code:

```ts
interface ModelContext {
  system: string;                 // the pinned prefix: harness prompt (P10)
  instructions: string;           // global/user instructions; the adapter decides where they go (P10)
  turns: Turn[];                  // user | assistant | tool_results
  tools: ToolDefinition[];        // canonical form (P10); adapters translate
  cacheHints: number[];           // turn indexes where a stable prefix ends
}
```

- It consumes `contextEntries`, then renders entries that have no provider equivalent as text with fixed
  wording: a compaction summary, `subagent_result`, `fork_merge` ("the user forked this conversation here,
  discussed X, and changed Y"), `interrupted`. `agent_setup` and `branch_start` markers are not shown.
- **An interrupted partial never replays as a live tool call.** A half-received call has no result and would
  make the next request invalid. Partial text is kept; a partial tool call becomes a short text note.
- **Reasoning is replayed only to the model that produced it** (same provider, same resolved model). Anything
  else is dropped, with the consequences documented. Which model produced a block is known from the setup
  folded at that point (P8), so the setup entry for a provider-observed change is written *before* the assistant
  entry it explains.
- Provider-native compaction items (P4) are replayed only to the provider that made them; for anyone else the
  builder uses the full history (the transcript is append-only, so it still exists), and our own `compaction`
  entry takes over when that no longer fits.
- Golden tests run it over the lifecycle conversation's history.

### P2. The adapter is a stateless function from context to an event stream, and it owns what the provider knows

```ts
interface ProviderAdapter {
  readonly $tag: string;                                   // "anthropic", "openai", "openai-compatible", ...
  readonly providerSchema: StandardSchema;                 // connection, auth, transport, pricing overrides (P6)
  settingsSchema(model: string): StandardSchema;           // per-request knobs for that model (P8)
  catalog(): Promise<ModelInfo[]>;                         // from an API or a bundled table: the adapter's choice
  pricing(model: string): Promise<PriceTable>;             // normalised dimension tables (P9)
  classify(from: AgentSetup, to: AgentSetup, at: Position): Change[];   // what a change would do (P8)
  estimate(ctx: ModelContext, setup: AgentSetup): Estimate;             // tokens + worst-case cost
  stream(req: { context: ModelContext; setup: AgentSetup; signal: AbortSignal }): ModelStream;
}
type ModelStream = AsyncGenerator<StreamEvent, Completed>;  // yields events, returns the final result
```

Neutral events: `started`, `text.delta`, `reasoning.delta` (readable part only), `tool_call.start` / `.delta`,
`block.done` (the **complete block**, with opaque payloads exactly as the provider sent them), `usage`
(cumulative), and `observed` (what the provider reports about how the request was served: the resolved model,
and the service tier where it says). The generator **returns** `Completed { blocks, stop_reason, usage,
observed, ext }` or **throws** `ProviderError { kind, retryable, partial }` where `partial` is the blocks
completed before the failure. Exactly one terminal state per stream: completed, error, or aborted.

### P3. A shared HTTP base, open for extension and documented as an extension point

Raw `fetch`, because it keeps the core portable and the raw payloads we must replay. It is also the part most
likely to change under the user's feet, so it is designed to be changed:

- **Injected `fetch`** (web-standard), so any runtime, proxy, or test double works.
- **Everything the base does is a replaceable piece**, passed in as an option with a documented default:
  `auth` (how credentials become headers), `retry` (a policy object: which errors, how long, jitter,
  `retry-after`), `timeouts` (connect, idle between events, total), `sse` (the line parser), `limiter`
  (shared concurrency per provider), `redact` (what is scrubbed from errors and logs), and `hooks`
  (`onRequest`, `onResponse`, `onEvent`, all receiving redacted views) for logging, tracing and recording.
- **A provider is three small functions**: `buildRequest(ctx, setup)`, `onEvent(sse, state) → StreamEvent[]`,
  `finish(state) → Completed`. A new API version means editing those, not the base.
- **A "direct" adapter** (an in-process engine) implements `ProviderAdapter` without any of this.
- The base retries only **before the first content event**; after that it never retries by itself, because the
  partial output was paid for and the caller decides (P5).
- **Documentation is a deliverable**, not an afterthought: `docs/writing-an-adapter.md` (the interface, the
  event contract, the conformance suite, how to record fixtures), plus a **fixture recorder** that captures a
  real stream, redacts it, and writes the SSE file the tests replay. When a provider changes its API, the
  workflow is: re-record, diff the fixtures, fix the three functions, run the conformance suite.

### P4. State: Anthropic is stateless; OpenAI is stored by default, with replay always possible

- **Anthropic** is stateless already; the cache hints (P1) become explicit breakpoints.
- **OpenAI** requests are stored by default (`store: true`) because that buys real features: server-side
  compaction and retrieving a response by id. `store: false` is an opt-out flag in the provider config (and
  the server forces it for zero-retention accounts; the adapter reads `response.store` and stops chaining when
  it is false).
- **Chaining is an optimisation with a verified fallback, never the only source of truth.** The adapter
  records the response id and a digest of the rendered prefix in `ext`. A request uses `previous_response_id`
  and sends only the new items **only if** the prefix up to that response is byte-identical to what the response
  saw (no compaction of ours, setup change, fork, or edit since). Otherwise, or if the id has expired or the API
  says it is not found, it replays the full context. Because replay must always be possible, the adapter
  **always** requests `reasoning.encrypted_content` and keeps it in the entry, even when stored.
- `instructions` are not carried by `previous_response_id`, so they are sent on every request.
- **Compaction.** Server-side compaction arrives in the stream as an opaque item. It is stored as a block in
  the assistant entry (provider-tagged, opaque `payload`) and shown as an **event**, not as readable text:
  the transcript gains an automatic compaction, but not one a person can read. It does not replace our own
  `compaction` entry, which is readable and provider-independent; the two coexist (P1).
- **Retrieval has a concrete use: crash recovery.** The response id arrives in the first event and is written to
  the journal (P5). If the process dies, `open` can retrieve the finished response by id (and the response
  existed because it was stored) instead of recording an `interrupted` entry for something that was paid for
  and completed. That step needs the network and credentials, so it is optional and runs only when a provider
  is configured; otherwise recovery falls back to `interrupted`.
- **Privacy note**: stored mode keeps conversation content on OpenAI's servers for the retention period. The
  provider schema's `store` property is documented as such, and `create` mentions it in its output.
- The cost and performance comparison with stateless replay is deferred (parking lot); everything above works
  either way, which is why it is safe to choose now.

### P5. Streaming: pass events through, and journal them beside the repository

- `stream()` is an async generator; a UI consumes it directly.
- The turn runner also tees the events into a **journal**: one append-only JSON-lines file per branch at
  `<git-common-dir>/chattree/journal/<branch>.jsonl`, next to the lock files, never committed. It is not
  canonical YAML and not content-addressed, and is flushed in small batches with a documented loss window.
  Other processes can follow it.
- It starts with a record naming the request (provider, setup digest, context digest) and, for OpenAI, the
  response id as soon as it is known. It ends **before the commit**, in one of two ways: the `assistant` entry
  (this *is* the "response complete" record; no new entry type) is committed and the journal deleted, or an
  `interrupted` entry is built from the completed blocks (`by: user | error`), committed, and the journal
  deleted.
- **Recovery in `open`**: a journal with no matching commit becomes an `interrupted` entry with `by: error`
  (or, for a stored OpenAI response, the retrieved response, P4). The `recovery` event reports it.
- Partial blocks follow what the providers can resume: complete text and reasoning blocks are kept; a partial
  tool call or thinking block is not usable and is recorded only as text (P1). "Continue from where it left
  off" is a later explicit action, not something an adapter does silently.

### P6. `harness.yml` is the outside world; schemas by `$tag`

```yaml
# yaml-language-server: $schema=./.chattree/harness.schema.json
providers:                              # connection, auth, transport, pricing overrides
  anthropic:
    $tag: anthropic                      # same key the transcript codec uses; `!anthropic` is accepted as sugar
    api_key_env: ANTHROPIC_API_KEY       # the NAME of an environment variable, never a key
  openai:
    $tag: openai
    api_key_env: OPENAI_API_KEY
    store: true                          # opt-out flag (P4)
    pricing: { overrides: [...] }        # provider-specific, validated by the adapter
  local:
    $tag: openai-compatible
    base_url: http://localhost:8080/v1
limits: { max_request_usd: 1.00, max_turn_usd: 5.00, max_conversation_usd: 50.00, warn_at: 0.8 }
```

- **`$tag` is the discriminator.** The transcript codec already means "this value's type" by it (`!user` is
  `$tag: user`), so the config uses the same word and the same mapping: a `!anthropic` tag on a provider is
  normalised to `$tag: anthropic` before validation. No rename is needed in either place. It is plain YAML
  (`$tag: anthropic` needs no quoting) and plain JSON Schema (`const`).
- **Schemas by tag.** An adapter registers itself like an entry type: a `$tag`, a provider schema, a settings
  schema. The loader validates each provider with its adapter's schema. Adapters describe schemas through
  Standard Schema and must be able to emit JSON Schema (zod does natively), so a third-party adapter is not
  tied to one library.
- **Editor support.** `create` and `open` generate a combined JSON Schema (core plus every registered adapter)
  into the worktree (`.chattree/harness.schema.json`, gitignored; each open regenerates it, so every worktree
  has one) and `create` writes the `# yaml-language-server: $schema=` line. As far as I know the YAML language
  server cannot learn **custom tags** from a schema (that needs its `yaml.customTags` setting), so tags remain
  optional sugar; a helper that adds them to VS Code settings comes later.
- **Models are not in the file.** Which models exist comes from the provider (P9); which one an agent uses is
  state in the transcript (P8). Any model the provider lists may be chosen: that is a host and user decision.
- **The `config_changed` entry goes away** (with its hash chain, `configStatus`, and the verifier's chain check).
  Config changes are visible as git commits to `harness.yml`; every entry commit includes the file as it was, so
  "what config was in force for this response" is `git show <commit>:harness.yml`.
- No migration code and no version bump: formats change in place until the first release.

### P7. Secrets: names in config, values from a source that cannot be committed

- Config stores **names** (`api_key_env`). The core never reads `process.env`; resolution goes through an
  injected `SecretSource`. The Node entry point supplies the process environment, then a repo-local file.
- The file is **`<git-common-dir>/chattree/env`** (dotenv syntax): inside `.git/`, shared by all worktrees, and
  not committable by `git add -A` or `-f`. A dotfile inside the worktree is read **only if `git check-ignore`
  says it is ignored**; otherwise loading fails with an explanation. `create` writes the `.gitignore` entry.
- **Every resolved secret is registered with the pipeline's `redact`** and the HTTP base's scrubber, so a key
  cannot reach the transcript, the journal, a log or an error, even if a tool result echoes it.
- A missing variable is an error naming the variable and provider, at `open`, not at the first request.

### P8. `agent_setup`: the agent's state in the transcript, folded, changed by explicit mutations

```yaml
- !agent_setup
  id: ...
  reason: user                  # user | fork | subagent | provider | resolved
  model: { provider: openai, id: gpt-5.4, resolved: gpt-5.4-2026-03-05,
           settings: { max_output_tokens: 8000, reasoning_effort: low } }
  tools:  { set: { write_file: { hash: ..., store: blob }, run: { hash: ..., store: external, ref: tools/run } },
            remove: [] }
  instructions: { hash: ..., store: blob }
  skills: { ... }               # same shape as tools
  mcp: { ... }                  # same shape
  renderer: chattree-english-v1 # how structured entries read to the model; immutable per id (harness/renderer.ts)
  pricing: { table: <hash> }    # the price table this agent is costed under (P9)
  allow: [cache_break]          # change kinds the caller allowed for this mutation
  acknowledges: [<entry id>]    # provider-observed changes this entry accepts
```

- **Sections are optional deltas** (`set` / `remove` for maps); the first entry of an agent flow is complete.
  The **effective setup** is the fold of an agent's `agent_setup` entries, kept by the `Conversation` so the
  append path (commit author, descriptions) does not re-read the transcript.
- **Inheritance.** A fork inherits the folded setup, so it needs no entry. A subagent has fresh context
  (`contextEntries` starts at its marker), so it must write its own complete first `agent_setup` right after
  `branch_start`: its model, settings and tools. The coordinator's **subagent allowlist** lives in the
  subagent tool's own configuration; the allowed models appear as an enum in that tool's input schema (so the
  coordinator sees the same list) **and** are enforced in code against the pinned value, because model output
  is never trusted. The allowlist is part of the tool's hash, so changing it is a tool change (P10).
- **Mutations** (`Conversation.setupChange(change, { allow })`, reusing the validate, check, append machinery
  that `changeConfig` had):
  1. validate shapes with the adapter's schemas, then semantics against the catalog (unknown model: a warning,
     never an error; a window the current context no longer fits: an error);
  2. ask `adapter.classify(from, to, position)` what the change would do, as **change kinds**: `model_changed`,
     `provider_changed`, `cache_break`, `cost_increase`, `context_overflow`, `reasoning_dropped`,
     `capability_loss`, `mid_loop` (inside a tool loop, where Anthropic wants one thinking configuration per
     turn), `tools_changed`, `instructions_changed`, `pricing_changed`, `resolved_model_changed`;
  3. any kind not in `allow` throws `ChangeNotAllowed { changes: [{kind, message, estimatedCost}], allowWith }`;
     the host shows a dialog and retries with the flags the user accepted, which are recorded in the entry.
  The same classification differs per provider and model, which is why it belongs to the adapter.
- **Provider-observed changes are facts, not requests.** When a response reports a model (or service tier)
  other than the folded one, the turn runner writes **`agent_setup` with `reason: provider` before the
  assistant entry**, in one atomic `appendMany`, so the producer of every block is known from the fold. It
  raises a `setup_changed` event (the host's toast). Observing it is never refused (the response was already
  paid for); the **next request** is gated: while a provider-reason entry is unacknowledged, a request whose
  change kinds are not in the host's standing allow set throws `ChangeNotAllowed`, and the host answers with a
  mutation whose `acknowledges` names it.
- **Aliases are pinned.** The first response under a setup reports the resolved model id. Writing it is an
  expected `reason: resolved` entry (not gated); from then on requests send the resolved, dated id where the
  provider has one, so the provider cannot silently re-point an alias. A later mismatch (deprecation, a
  server-side fallback) is a real `reason: provider` change.
- **`assistant` entries are slimmed**: the model settings that v1 repeated (`request` block, effort, tier,
  token caps) are not stored per entry; the fold has them. What the *response* reports stays: `usage`,
  `stop_reason`, `ext`, and (open question Q1) the served model id.

### P9. Catalog, pricing and cost: through the provider, pinned by hash

- **Catalog.** `adapter.catalog()` returns the models, with capabilities (context window, maximum output,
  supported effort levels, whether temperature is allowed with thinking, forced tool choice, deprecation). An
  API-backed provider (llama-server's `/v1/models` and `/props`, for context size) fetches it, with a short-
  lived cache under the git directory and a bundled fallback offline; OpenAI and Anthropic ship a bundled
  table. The harness treats all of them alike.
- **Pricing is normalised.** `adapter.pricing(model)` returns dimension tables: meters (input, output, cache
  read, cache write by lifetime; reasoning is billed as output and aliased), tiers (standard, flex, priority,
  batch), context bands (the long-context cliff), and `rate(model, meter, tier, band) → $/Mtok`, with `asOf` and
  `source`. A provider with a real pricing API returns the same shape; a local server returns an explicit **zero**
  (free), not unknown. Overrides come in through the provider config schema.
- **Pinned, so history is reproducible.** The setup records the **hash of the effective table** (bundled plus
  overrides) it is costed under; the table itself is stored as a blob (or externalised like any definition,
  P10). Each turn compares the effective table's hash with the pin; a mismatch (a package upgrade changed the
  bundled table, an override was edited) is a `pricing_changed` change that needs an explicit mutation. A real
  price change you want to preserve is therefore a mutation, and the old table stays reachable at the earlier
  commit for analytics. A genuinely retroactive correction is a config edit plus the same mutation.
- **Cost is derived**, not stored per entry: usage × the pinned table for the setup folded at that entry. The
  ledger is a fold over the transcript, including usage rolled up in `subagent_result` / `fork_merge`, so
  budgets survive restarts and forks.
- **Limits are enforced**: `max_request_usd` against the pre-flight estimate (input tokens plus
  `max_output_tokens` priced as fully used, which is why `max_output_tokens` is required in the settings),
  `max_turn_usd`, `max_conversation_usd`, `max_requests_per_turn`, a wall-clock cap, and `max_subagent_usd` in
  the subagent tool's configuration. A request that would exceed a limit is not sent. `warn_at` raises a `cost`
  event first. To go past a limit the host edits `harness.yml`.
- **Unknown price** is shown as unknown, never zero; a limit `unknown_price: warn | block` decides what then.
- **Surprises checked specifically**: a model or tier switch ("next turn about $0.04 now, $1.20 after, 30x,
  for this conversation's current size"); the price spread between the cheapest and the "pro" tiers (about
  300x on one provider's list); the long-context cliff (warn within 10% of the threshold); cache loss from
  effort or thinking changes, dropped reasoning, compaction, or waiting past the cache lifetime; subagent
  fan-out; and partial responses that were billed anyway (usage is recorded on `interrupted` entries).

### P10. Pinned definitions: tools, instructions, skills, MCP

- **A canonical internal format** for tool definitions (name, description, JSON-schema input, behavioural
  flags); each adapter translates it to its provider's shape deterministically. The **hash** is the hash of
  the canonical encoding (the transcript codec's canonical emitter, as config hashing already does), so it
  covers schema, description and implementation identity, because all three change behaviour and cache bytes.
  The adapter version is also an input to the rendered bytes; it is recorded with the setup.
- **The setup records `name → { hash, store, ref? }`; presence means enabled.** Two storage modes, host's
  choice per definition: `store: blob` copies the canonical bytes into `blobs/` (replayable byte-for-byte,
  checkable by `verifyHistory`), or `store: external` records only the hash and the host's locator (for
  example a path in a shared submodule of organisation-wide tooling, where copying would be redundant).
- **The host provides one hook**, so the harness can discover and retrieve definitions and the host handles the
  wiring:
  ```ts
  interface DefinitionSource {
    list(): Promise<{ kind: "tool"|"instructions"|"skill"|"mcp"; name: string; hash: string; ref?: string }[]>;
    get(kind, name, hash): Promise<Uint8Array | undefined>;     // the canonical bytes for exactly that hash
  }
  ```
  At the start of each turn the harness recomputes the hashes of everything pinned. A mismatch is
  `definition_changed`; a pinned name that is no longer listed is `definition_missing`; both fail with the same
  `ChangeNotAllowed` error as other drift, so detection is safe in either mode. For external pins the verifier
  can only check what the host's source can serve, and reports the rest as unresolvable.
- **What happens when these change** (the prefix is pinned within an agent flow):
  - *Tools* (names, descriptions, schemas, order) are part of both providers' cached prefix, so any tool change
    is a `cache_break` and costs a full re-read of the conversation. **Removing** a tool is better done as a
    restriction (OpenAI: `allowed_tools` or `tool_choice: "none"`; Anthropic: `tool_choice`, whether it has an
    allow-list equivalent is to verify) than by deleting the definition, because history may contain calls to
    it. Adding a tool changes the prefix and is a mutation.
  - *System prompt*: part of the prefix; changing it is a `cache_break` mutation.
  - *Global instructions*: the context has separate slots for `system` (pinned) and `instructions`; the adapter
    places the latter in the system block or as the first developer or user message, depending on provider and
    model, deterministically from the setup. An edit mid-conversation **defaults to appending a short "your
    instructions were updated" message at the tail** (cache-friendly; the old text stays in context); a
    re-render of the prefix is an explicit `cache_break` mutation.
  - *Skills and MCP*: the same shape. An MCP server's tool list can change under us; the hash of the list it
    presents is pinned, and a difference is drift like any other.
  - Whether a given change is free, cache-breaking or incompatible is the **adapter's classification** (P8).

### P11. Entry changes (in place, no version bump)

- **Added**: `agent_setup` (P8). **Removed**: `config_changed`.
- `assistant`: `usage` normalised to `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`, `reasoning_tokens` with the raw provider usage in `ext`; settings no longer repeated (P8);
  content blocks get an optional `ext` so a provider can keep what replay needs (OpenAI's item `id` beside
  `call_id`); a provider-tagged opaque `compaction` block kind (P4); `ext` also holds the response id and prefix
  digest (P4).
- `interrupted`: optional `usage`. `subagent_result` / `fork_merge`: optional `usage` rollup of the child.
- `stop_reason` stays a string, normalised, raw value in `ext`.
- `verifyHistory` loses the config-chain check and gains: setup folds are valid, a `provider` setup precedes the
  assistant entry it explains, every pinned `blob` definition matches its hash, subagents start with a complete
  setup.

### P12. Testing without calling the providers

- **Recorded fixtures** (text, tool calls, thinking, errors, mid-stream failure, fallback, compaction items),
  captured with the recorder, redacted, committed as SSE files.
- **Chunking property test**: any split of a fixture into network chunks, including mid-line and mid-UTF-8,
  yields identical events.
- **Fake server** in `node:http`: retry before first content only, `retry-after`, idle timeout, abort, 429 and
  5xx, a reset mid-stream; for OpenAI also `previous_response_id` chaining, an expired id, `store` forced off,
  and retrieval by id.
- **Replay round trip**: `assistant` entry → builder → request body: reasoning byte-identical, tool calls and
  results paired, foreign reasoning dropped, chaining used only when the prefix digest matches.
- **Conformance suite** every adapter runs: one terminal state, cumulative usage never decreases, complete blocks
  match deltas, secrets never appear in any event or error, `classify` is symmetric where it should be.
- **Mutation tests**: every change kind allowed, refused and acknowledged; a provider change written before its
  assistant entry atomically; crash sweeps over that `appendMany`, and over the journal.
- **llama-server early**: a probe test against a local build (tool calls need `--jinja` as I understand it,
  reasoning arrives in `reasoning_content`, context size from `/props`) before the compatible adapter is
  designed in detail.
- **Live tests** against the real providers are opt-in by environment variable with a hard spend cap; none are
  required for the build (no API key is available at present).

## 4. Layout

```
harness/context-builder.ts      P1   setup + entries -> ModelContext
harness/attachments.ts          --   media types, kinds, size limit, token guesses for files added to messages
harness/setup.ts                P8   agent_setup fold, ChangeNotAllowed, mutations
harness/definitions.ts          P10  canonical formats, hashing, DefinitionSource, drift checks
harness/ledger.ts               P9   cost fold
harness/secrets.ts              P7
harness/config.ts               P6   harness.yml (providers, limits) + JSON Schema generation
harness/turn.ts, journal.ts,
  partial.ts                    P5   context -> adapter -> journal tee -> commit (one request); recovery is in `open`
providers/types.ts              P2   interfaces, events, errors
providers/http.ts, sse.ts       P3   shared transport and its extension points
providers/anthropic/            P3   mapping, catalog, prices
providers/openai/               P3   Responses mapping; chaining, compaction, retrieval
providers/openai-compatible.ts  P3   Chat Completions for llama-server and friends
docs/writing-an-adapter.md      P3
tools/record-fixture.ts         P3   capture and redact a real stream
test/providers/fixtures/        P12
```

`src/` (the core) is untouched: no provider code, no `process.env`, `fetch` injected.

## 5. Build order

1. **Format and setup first. Done**: `agent_setup` entry and fold (`harness/setup.ts`), `Conversation.setupChange`,
   `appendResponse`, `checkRequest`, `ChangeNotAllowed`, the `setup_changed` event; `config_changed` and its
   hash chain removed; `harness.yml` reduced to providers, limits and compaction; `$tag` and `!tag` sugar in
   the config reader; verifier checks for setups. Not yet: usage normalisation and the optional block `ext`
   (P11), which wait for the first adapter. The `assistant` entry never carried settings, so there was nothing to slim.
2. **Context builder and definitions. Done**: `harness/context-builder.ts` (`buildContext`, `contextProblems`; calls and results always
   pair; reasoning only to the model that wrote it; texts read in from blobs; every piece of wording comes from
   the setup's **renderer**, `harness/renderer.ts`: `chattree-english-v1` is frozen and pinned by a test, a new
   wording is a new id, changing it is the `renderer_changed` kind, and an agent's first setup records it
   explicitly), `harness/definitions.ts` (canonical
   tool format, hashes, `pinDefinition` for `blob` and `external`, the `DefinitionSource` hook, `checkDefinitions` /
   `assertDefinitions` drift detection, `loadDefinitions` with hash verification), and `harness/request.ts`
   (`prepareContext`: gate on unacknowledged provider changes, check drift, load definitions, build the context for
   the dated model). A golden file (`test/harness/golden/context-rich.json`, rewritten with
   `CHATTREE_UPDATE_GOLDEN=1`) and a structural check in the fuzz and lifecycle tests guard it.
   Conventions fixed on the way: a definition's hash is the SHA-256 of its canonical bytes (sorted-key JSON; the
   text itself for instructions), so a `blob` pin's hash is the blob's hash; `provider` on setup and assistant
   entries is the **name** of the provider in `harness.yml`, not the adapter tag; drift of any definition is the
   `tools_changed` or `instructions_changed` kind, so one `ChangeNotAllowed` covers all of it.
3. **Provider types, SSE parser, HTTP base, fake server, conformance checks, fixture recorder. Done**:
   `providers/types.ts` (events, `Completed`, `ProviderError` with its kinds, the adapter interface),
   `providers/sse.ts` (own parser, tested at every split point and at random chunkings, including mid-character and
   mid-CRLF), `providers/http.ts` (`httpStream` with an `HttpMapper`; per-attempt timeouts; retry before the first
   content event only, with held-back `started`/`observed`/`usage`; `retry-after`; limiter; scrubbing; hooks that
   cannot break a request; early `return()` cancels the request and frees the slot),
   `providers/conformance.ts`, `providers/fixtures.ts` (`recordingFetch`, `replayFetch`), `tools/record-fixture.ts`,
   `test/support/fake-server.ts` and a made-up `toy-adapter.ts` that exercises all of it, and
   `docs/writing-an-adapter.md`. The catalog, pricing, estimate and settings-schema parts of the adapter interface
   are not in `providers/types.ts` yet; they arrive with step 6 and step 5.
4. **Anthropic adapter, then OpenAI Responses. Done, including chaining, compaction and retrieval (step 4b)**:
   `providers/anthropic.ts` and `providers/openai-responses.ts` (settings schemas, request bodies, stream mappers,
   `classify`), `harness/blocks.ts` (`toEntryBlocks`), the optional block `ext` (item ids), and
   `tools/live-check.ts`, an opt-in script that runs the adapter against a real or local server (Ollama speaks
   the Anthropic and OpenAI Responses shapes, so it is a zero-cost check): plain reply, usage, incremental
   streaming, tool-call round trip, reasoning replay, abort, bad model. It is tested against the fake server.
   The adapters were written from the docs and memory, with no recorded fixtures yet. **Unverified until run
   against a real server**: Anthropic's `system` and `cache_control` request shapes and where breakpoints may go,
   the caching and pricing details; for OpenAI the assistant `message` and `function_call` item shapes on replay,
   whether item ids may be replayed, and `include` for models without reasoning. Attachments are refused by both.

   **Step 4b** (same adapter, `providers/openai-responses.ts`): a response the server confirms it stored
   (`response.store === true`, so a server that ignores `store`, like Ollama, is never chained) is recorded in the
   assistant entry's `ext` as `{response_id, store, prefix_digest}`; the digest covers the model and the exact input
   items the response saw plus the items it produced. `planChain` continues from the latest assistant turn only if
   the digest of the context's own prefix matches, and then sends just the items after it (instructions and tools
   are sent every time). Anything else, including an edited history, another model or provider, an interrupted turn
   in between, or the `chain: false` / `store: false` options, replays everything. If the server answers that the
   previous response is not found, and nothing has reached the caller yet, the same request is made again without the
   chain. Provider compaction: the `compact_threshold` setting becomes `context_management`; the `compaction`
   output item is kept as an opaque `provider_compaction` block (own block kind so it cannot be mistaken for our
   readable `compaction` entry), replayed only to the same provider and model, and a replay drops everything before
   the latest one (`pruneAtCompaction`, default on). Retrieval: `ProviderAdapter.retrieve` fetches a finished
   response by id into the same `Completed` (`undefined` for 404 or cancelled, a retryable error while it is still
   running); the turn runner will use it for recovery (step 7). `tools/live-check.ts` gained `chaining` and
   `retrieve` scenarios. **Verified live on 2026-10-25** (free tier, `gpt-6-luna`): all scenarios pass, and the `chaining` scenario really
   chained (`previous_response_id` plus only the new items, the response confirmed `store: true`), and `retrieve`
   fetched a stored response. **Still unverified**: the `context_management` field name, that dropping items before a
   compaction item is right for a stateless replay, and the not-found error text the fallback matches
   (`previous_response`). Not done: the
   standalone `/responses/compact` call.
5. **`harness.yml` v-next, secrets, JSON Schema generation and the editor marker (P6, P7). Done**:
   `providers/registry.ts` (`AdapterDefinition`: `$tag`, Standard Schema for the provider's keys and for the model
   settings, `jsonSchema()`, `secrets(config)` naming the environment variables it needs, `create`; `AdapterRegistry`;
   `validateProviders` and `buildProviders`, which report every problem at once, including each unset variable by
   name and provider; `envName`, which refuses a pasted key; the common transport keys `max_concurrent`, `timeouts`,
   `max_attempts`), `providers/index.ts` (`defaultRegistry()` with `anthropic` and `openai`), `harness/secrets.ts`
   (`SecretSource`, `repoSecretSource`: environment, then the worktree's `.chattree/env` only if git ignores it, then
   `.git/chattree/env`; `redactionPatterns`, which skips values under 8 characters), and `harness/config-schema.ts`
   (`configJsonSchema`: core keys plus one `oneOf` variant per adapter keyed on a `$tag` const). `ConversationOptions.providers`
   `{registry, secrets}` makes `create` and `open` validate the providers, resolve the secrets (failing at `open`,
   not at the first request), build the adapters (`convo.providers`, `convo.provider(name)`, shared with forks),
   add every secret to the transcript's redaction, and write `.chattree/harness.schema.json` (only where git ignores
   it); `create` also writes `.gitignore` (`/.chattree/`) and the `# yaml-language-server: $schema=` line, and
   `readConfig` validates provider keys against the adapters. The core still never reads `process.env`: the host
   passes it to `repoSecretSource`. Not done: the VS Code helper for `yaml.customTags`, and the per-adapter pricing
   overrides key (step 6).
6. **Catalog, pricing tables, ledger, estimates, limits (P9). Done**: `providers/pricing.ts` (the table format:
   per model, `rates` keyed by service tier (`standard` when there is only one; `default` and `auto` in a
   request's settings mean `standard`), each giving dollars per million tokens for `input`, `output`, `cache_read` and
   `cache_write`, which is one number or a map from cache lifetime in minutes to rate (`{ 30: 12.5, 720: 25 }`), plus an
   optional `long_context` band with the same by-tier shape; usage carries the per-lifetime split as
   `cache_write_by_minutes` (entries store it as `cache_write_tokens_<minutes>m`, `usageRecord` / `tokensOf` convert), and
   writes with no stated lifetime are priced at the lifetime the request asked for; `free: true` is an explicit zero; `costOf` returns `{usd, unknown}` and an unpriced meter
   with tokens makes the whole request unknown rather than cheaper; `effectiveTable` puts a provider's overrides
   over the bundled table; `tableHash` is the SHA-256 of the canonical bytes, which is also the blob's hash),
   `providers/pricing-data.ts` (bundled tables, **Anthropic's read from the pricing pages on 2026-10-25 by a summarising tool, so check them before relying on a limit; OpenAI's read in a browser the same day with every tab and the Short/Long toggle clicked (the long-context threshold, 272k, is assumed: the page does not state it)**, only for models whose ids are known; Anthropic `cache_write` is keyed
   `{5, 60}`; the adapter reads the split from `usage.cache_creation`, which the caching docs confirm), provider config keys `pricing: {free, models}` and `models: {id: {context_window,
   max_output_tokens}}`, and adapter definitions' optional `prices` and `models`. `harness/ledger.ts` folds the
   transcript (each response priced under the table pinned by the setup in force at that entry, so history is never
   repriced; `interrupted.usage`; a merged branch's `spend` rollup on `subagent_result` / `fork_merge`, computed at the
   merge from the child's own entries since it diverged or was last merged; unknown prices counted as `unpriced`,
   never as zero). `Conversation.pinPricing()` stores the table as a blob and pins its hash (doing it again after a
   price change is the explicit mutation that accepts it); `ledger()`, `priceTable()`, `modelInfo()`.
   The lifetime is a **model setting** requested per call, as the providers do it: `cache_ttl` is `5m | 1h` for
   Anthropic (`cache_control.ttl` on every marker; 5 minutes is the default and is left out) and `30m | 12h` for OpenAI
   (`prompt_cache_options.ttl`, GPT-5.6 and later; earlier models take `prompt_cache_retention` through `extra`, and have
   no write charge); a write replaces the plain input charge, which is how usage already splits `input_tokens`. OpenAI's
   per-lifetime split is read from `input_tokens_details.cache_write_tokens_details`. Writes whose lifetime the usage does
   not state are priced at the setting's lifetime, else the shortest. (From the providers' caching pages, read by a
   summarising tool, 2026-10-25.)
   `harness/estimate.ts` (pessimistic: about 3 bytes a token, plain input rate or the cache-write rate for the requested lifetime if that is dearer, all of `max_output_tokens` used;
   `costIncrease` says what a model or tier switch does at the current size, for the host's classifier).
   `harness/limits.ts` (`max_request_usd`, `max_turn_usd`, `max_conversation_usd`, `max_requests_per_turn`,
   `unknown_price: warn|block`, `warn_at`; warnings for nearing a limit, unknown price, unpriced history, the context
   window at 90% and the long-context cliff within 10%). `prepareContext` now also requires the pin to match the
   provider's table (`pricing_changed`, accepted with `allowDrift` or by re-pinning), enforces the limits
   (`LimitExceeded`, nothing is sent), and returns `estimate`, `ledger` and `warnings`; it does nothing of this without
   the `providers` option or with `cost: false`. Token counting (added later): an adapter may implement
   `countTokens({context, setup, signal})` (Anthropic `POST /v1/messages/count_tokens`, OpenAI `POST /responses/input_tokens`,
   both free). `prepareContext` calls it only when the byte estimate is near a limit, 60% of the context window or of the
   long-context threshold (`count: "auto"`, or `"always"`/`"never"`), recomputes the estimate and limits from the exact
   figure (`estimate.counted`), caches by context digest per conversation, and on failure keeps the estimate and adds a
   `token_count_failed` warning. Not done: an API-backed catalog (`/models`, llama-server's `/props`); the wall-clock cap `max_turn_seconds` is in the
   config but enforced by the turn runner (step 7); `max_subagent_usd` belongs to the subagent tool's configuration.
7. **Turn runner and journal**, recovery (including retrieval) in `open`, crash sweeps (P5). **Done.**
   `harness/turn.ts`: `requestStream(convo, opts)` (an async generator of the provider's events that returns how the
   request ended) and `runRequest` (drains it into `onEvent`). One request, not the tool loop: `prepareContext`, the
   stream teed into the journal, then the commit: `assistant` (with the `agent_setup` entry for a model the provider
   changed, atomically, as `appendResponse` already did) when it completes; an `interrupted` entry with what
   arrived and the tokens when it does not. Outcomes: `completed`, `interrupted` (`by: user` for the caller's
   signal or for stopping the iteration, `by: error` for a provider failure or the deadline) and `cancelled` (the user
   stopped it before anything arrived: nothing is recorded). A provider failure before anything arrived **throws** the
   `ProviderError` and leaves the transcript untouched, so asking again is safe. The deadline is `opts.deadline` or
   `limits.max_turn_seconds` counted from the start of the request; a loop passes one deadline to every request of a turn.
   `harness/partial.ts` (`StreamAccumulator`) is the one rule for "what had arrived": complete blocks, the text of an
   unfinished block, a started tool call (shown as a note, never as a call); unfinished reasoning is dropped.
   `harness/journal.ts`: the file is `<git-common-dir>/chattree/journal/<branch>.jsonl`, created exclusively (a second
   request on the branch gets `JournalBusy`), buffered and flushed every 250 ms or 64 KiB, with a heartbeat line every
   15 s. Two changes from the plan above: the journal ends with a `done` record holding the whole `Completed`, flushed
   *before* the transcript is touched (so a crash between the end of the stream and the commit loses nothing, which the
   `assistant` entry alone could not promise), and a recent journal means *live*: `open` leaves a journal whose
   modification time is within `journalStaleMs` (default 60 s) alone and reports `in_flight`, because the branch lock is
   not held while streaming and another process may still be running the request. If the commit fails the journal is
   kept for recovery. `open` recovers a stale journal in this order: already committed (an `assistant` or
   `interrupted` entry follows the entry the journal began after: only the file is deleted), `done` present (commit it),
   a response id and an adapter that can `retrieve` (fetch with `recoveryTimeoutMs`, before taking the lock; gone or a
   failure falls through with a note), else `interrupted` by error with what the journal holds, else nothing worth keeping
   (discarded). The result is `convo.recovery.journal` and a second `recovery` event. Tests: scripted provider, early
   ends of every kind, every recovery outcome, a heartbeat, and a sweep that cuts a journal at line boundaries and
   inside lines.
   Ownership: each journal's start record carries a random nonce, and the runner checks, under the branch lock and just
   before committing, that the file still begins with its own start line; if another process took it for dead and
   recovered it, the request throws `RequestSuperseded` (carrying the completed response, if any) instead of writing a
   second outcome, and a request never writes into a journal that is no longer its own (so a woken process cannot bring a
   deleted journal back).
   Not done: a recovered response does not carry the adapter's chaining digest (it is computed from the request, which
   the journal does not keep), so the next request replays instead of chaining; that is always correct, only less cheap.
8. **`openai-compatible`** with the llama-server probe, then docs and an example in the lifecycle test using a fake
   provider. **Done** (`providers/openai-compatible.ts`, `$tag: openai-compatible`, registered in `defaultRegistry()`).
   Chat Completions for llama-server, Ollama, vLLM, LM Studio and similar: stateless, no cache control, storage or
   retrieval; every request replays the context. Provider config: `base_url` (required, including `/v1`: there is no
   default, so a conversation can never go to the wrong place by omission), `api_key_env` (bearer), `max_tokens_param`
   (`max_tokens`, or `max_completion_tokens` for OpenAI's own models), `include_usage` (`stream_options`), plus the common
   fields (`pricing: {free: true}` for local). Model settings: `max_output_tokens` (required), `temperature`, `top_p`,
   `stop`, `seed`, `reasoning_effort`, `replay_reasoning`, `extra` (server extensions such as `top_k` or `chat_template_kwargs`;
   cannot override owned fields). The mapper is lenient where servers differ: reasoning from `reasoning_content` or
   `reasoning`; tool calls assembled from `index`-keyed fragments, with a made-up id when the server sends none and
   arguments accepted as an object; a finished call is `tool_use` whatever `finish_reason` says (Ollama says `stop`);
   `refusal` becomes text with the `refusal` stop reason; the end is `[DONE]`. Decisions: reasoning is **not** sent back
   by default (most chat templates drop it; `replay_reasoning` sends the visible text as `reasoning_content` for the models
   that want it next to tool calls); usage is reported as **one** event at `[DONE]`, because chunks may carry running totals
   and a cache hit found partway lowers the uncached input, and an event cannot be taken back (so a stream that dies
   mid-way reports no tokens; fine for local servers, and the parking lot has the alternative); cached tokens are taken
   out of `prompt_tokens` so the meters stay disjoint; a server that reports no usage gives zero tokens and
   `ext.usage_reported: false`. Inline reasoning (`providers/think-tags.ts`, setting `think_tags: auto | off | implicit | {open, close}`):
   servers that leave `<think>…</think>` in the text (vLLM without a reasoning parser, llama-server with reasoning parsing off,
   gateways for R1- and Qwen3-style models; Ollama splits natively) get it split into a reasoning block. `auto` is the default
   and looks only at the very start of a response, so it costs nothing and cannot touch a tag later in an answer. There is no
   unescaping: model text has no escaping, so an answer that itself *begins* with a literal `<think>` cannot be told from the
   delimiter (use `off`). `implicit` is for templates that open the tag in the prompt (output starts mid-thought, only
   `</think>` appears); a response that skips thinking is then all reasoning, so it is opt-in. `live-check --flavor openai-compatible` runs the same scenarios (retrieval skips; chaining
   reports that it replayed). Tests: fixtures-by-hand for text, tool calls, both reasoning fields, Ollama's whole-call chunk,
   invalid arguments, finish reasons, revised usage, chunking invariance, errors, request bodies, the registry, and an
   end-to-end test (`test/integration/compatible-turn.test.ts`) that drives a conversation through a tool call and back with
   costs on. **Unverified**, to check with a real llama-server (none was available): that `stream_options.include_usage` and
   `prompt_tokens_details.cached_tokens` are sent, that `reasoning_content` carries thinking only with
   `--reasoning-format deepseek` (otherwise `<think>` stays in the text), that tool calls need `--jinja`, and the exact error
   bodies (the classifier knows `exceed_context_size_error`). Checked live against Ollama only before this step, through the
   other two adapters; run `node tools/live-check.ts --flavor openai-compatible --base-url http://localhost:11434/v1 --model <m>`
   to check this one the same way.

### Repository maintenance (added after step 8)

`gc.auto` stays off so git never rewrites the repository behind a running conversation, which left loose objects
accumulating. The harness now packs them itself: `harness.yml` has a `maintenance:` section (`auto: true`,
`loose_objects: 1000`, `packs: 20`, `check_every: 200`), and `Conversation` checks `git count-objects -v` at `open` and
every `check_every` transactions, inside the branch lock. Past `loose_objects` it runs `git repack -d` (packs reachable
loose objects and removes the packed copies; objects written but not yet committed are unreachable and stay put); past
`packs` it runs `repack -a -d` to merge packs. It never runs `gc` or `prune`, so nothing is ever deleted that history,
or an in-flight append, could need. A `maintenance` event reports bytes and counts before and after; `convo.maintain()`
does it on demand; `auto: false` turns the automatic checks off. A failure is swallowed and retried at the next check.

### Continuing after an interruption (added after step 8)

`convo.continueInterrupted({ instruction? })` is the one mutation for resuming: the last entry (setup changes after it
are skipped) must be an `interrupted`, otherwise it throws `ConversationError`. It appends an ordinary `user` entry
(default text from the agent's renderer, `Renderer.continueInterrupted()`: the reply was cut off, continue from where it stopped without repeating; written into the entry, so it is stored text) and
the commit carries `Chattree-Continues: <interrupted id>`; the host then calls `runRequest`. Nothing about the
transcript format changes: the interrupted entry keeps its partial text, the model sees it and the new message, and
the wording is stored text, so a later renderer change cannot alter it. Never done silently: the host decides.

### Attachments (added after step 8)

A user entry's `content` may hold `attachment` parts (`{name?, data: !blob {sha256, bytes, mime}}`, already in the
format). The harness never guesses a file's type: the host passes the media type to `convo.attach(bytes, {mime, name?})`
(a browser has it; a CLI wrapper detects it, which is the right place for that), which refuses a missing or malformed
type, a type no model is given, an empty file and one over `attachments.max_bytes` (`harness.yml`, default 20 MiB), then
stores the bytes as a blob and returns the part for the entry. `harness/attachments.ts` classifies types: png, jpeg, gif
and webp images; `application/pdf`; text (`text/*`, JSON, XML, YAML, TOML and `+json`/`+xml`/`+yaml` types). The context
builder (given `readBytes`, which `prepareContext` supplies) inlines text files as text through
`Renderer.textAttachment` and passes images and PDFs on as `AttachmentPart {kind, name, mime, sha256, bytes}`.
Adapters: Anthropic `image`/`document` base64 blocks; OpenAI Responses `input_image` (data URL) and `input_file`
(`file_data` data URL); Chat Completions `image_url` data URLs, PDFs refused with an error that says to send text. The
pre-flight estimate prices an image at 2000 tokens and a PDF at 1500 plus a token per 25 bytes (high on purpose); the
counting endpoints replace that near a limit. Unverified against the real APIs: the exact request shapes above.

## 6. Out of scope here

The tool-execution loop and permissions; skills and MCP implementations (only their pinning); when to compact;
prompt-cache tuning beyond hints; batch APIs; hosted tools (web search, code interpreter) on OpenAI.

## 7. Parked (recorded in `parking-lot.md`)

The live comparison of stored versus replayed OpenAI state (cost, cached tokens, latency); verifying Anthropic's
caching and pricing pages and the cache order; whether hosted tools need server state; OpenAI's WebSocket
continuation cache; a VS Code helper for custom tags; `allowed_tools`-style restriction on Anthropic.

## 8. Decided (formerly open)

- **Q1.** The served model id **stays on the `assistant` entry** and nothing else of the settings does. Done:
  `appendResponse` writes the model the provider reported as the entry's `model`.
- **Q2.** Compaction policy (`threshold_tokens`, `keep_recent`) lives in **`harness.yml`**: it is the harness's
  disposition, not the agent's state. Already so in the schema.
- **Q3.** A provider-observed change **gates the next request by default**; the host's standing allowance (the
  `standing` argument of `checkRequest`) is configurable. Done.

## 9. What changed since v1

Added: `agent_setup` and folding, mutation machinery with typed allow flags, provider-observed changes written
before the assistant entry, alias pinning, pinned definitions with a host hook and two storage modes,
pricing through the provider interface and pinned by hash, OpenAI stored by default with verified replay
fallback, compaction as an opaque block, retrieval-based crash recovery, an extensible and documented HTTP
layer with a fixture recorder, `$tag` as the config discriminator with a JSON Schema marker, `openai-compatible`
in scope. Removed: `config_changed`, the `models` section of `harness.yml`, per-entry settings, migration and
version bumps. Changed: limits are hard; cost is derived from usage and the pinned table rather than stored per
entry.

## 10. Sources and what I could not check

Checked in this session: Anthropic
[streaming messages](https://platform.claude.com/docs/en/api/messages-streaming),
[thinking with tool use](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) and
[thinking cost and effort](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost);
OpenAI [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events),
[reasoning items](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items),
[Responses vs Chat Completions](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions?api-mode=responses),
[conversation state](https://developers.openai.com/api/docs/guides/conversation-state),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[compaction](https://developers.openai.com/api/docs/guides/compaction) and
[background mode](https://developers.openai.com/api/docs/guides/background). The price spread comes from
[a third-party table dated 20 October 2026](https://developer.puter.com/tutorials/openai-api-pricing/) and is
illustrative only.

**Not verified**: Anthropic's prompt-caching page (breakpoints, lifetimes, multipliers, the tools, system,
messages order) and price table, which were not reachable; whether OpenAI requires a replayed reasoning item to
travel with the item after it, and whether message item ids are needed for stateless replay; whether
`previous_response_id` works with `store: false` (the guide does not say, so the plan assumes not); that the
response reports the service tier actually used; whether Anthropic has an allow-list equivalent to
`allowed_tools`; every llama-server detail above (from memory).
