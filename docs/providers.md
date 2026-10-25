# Provider adapters: plan

Status: **proposal, nothing built yet.** Decisions are numbered P1–P11 so they can be accepted or changed one by
one, as with `git-integration.md`. Section 7 lists the questions I need answered before building.

## 1. Where we are, and one gap to close first

What exists and what the adapters can rely on:

- `contextEntries(entries)` returns the **entries** a model should see (fresh-context markers, compactions).
  It does not produce provider messages: nothing yet turns entries into "system + turns + tool results", renders
  `subagent_result` / `fork_merge` / `interrupted` as something a model can read, or decides what happens to
  reasoning blocks from another model. The parking lot calls this "context building for models". **The adapters
  need it as their input, so it is the first piece of work (P1), not an assumption.**
- The `assistant` entry already carries what a response needs: `provider`, `model`, `blocks` (text, reasoning
  with an opaque `payload` and a `provider` tag, tool calls with `args_raw`), `stop_reason`, `usage`, `ext`. The
  `interrupted` entry already carries `partial` blocks and `by: user | error`.
- `harness.yml` has `model: { provider: anthropic|openai|llama.cpp, model, base_url, max_output_tokens,
  temperature }`, tool and skill *names*, and MCP servers. It has no system prompt, no tool definitions, no
  credentials, no limits. Provider-level and model-level settings share one object.
- The pipeline can already redact patterns from strings before they are stored (`redact`).

## 2. What the two APIs look like (checked against current docs)

Only the facts that shape the design. Sources are in section 8; two things I could not verify are listed there
too.

| | Anthropic Messages | OpenAI Responses |
| --- | --- | --- |
| Streaming | SSE: `message_start`, per block `content_block_start` / `_delta` / `_stop`, `message_delta`, `message_stop`; `ping` anywhere; unknown event types must be tolerated | SSE: `response.created`, `response.output_item.added/done`, `response.output_text.delta`, `response.function_call_arguments.delta/done`, `response.reasoning_summary_text.delta`, then `response.completed` / `.incomplete` / `.failed`; every event has `sequence_number` |
| Block identity | `index` of the content block | `item_id` + `output_index`; the function-call item has both an `id` and a `call_id` |
| Tool-call arguments | `input_json_delta.partial_json`, parse at `content_block_stop` | `function_call_arguments.delta`, full string in `.done`; `arguments` is a JSON **string** |
| Usage | `message_start.usage`, then **cumulative** counts in `message_delta.usage`; thinking tokens in `output_tokens_details.thinking_tokens` (included in `output_tokens`) | one object in `response.completed`: `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` |
| Reasoning round trip | Thinking blocks (with `signature`) and `redacted_thinking` must come back **complete and unmodified** in the active tool loop; dropping or editing them is a 400. Newest models may return an empty `thinking` string with only the signature | `include: ["reasoning.encrypted_content"]` with `store: false`; replay the reasoning items. Needed when a turn has a function call; the final `encrypted_content` is the one in `output_item.done`, not `.added` |
| State | none (stateless) | stateful by default (`previous_response_id`); `store: false` makes it stateless. `previous_response_id` does not carry `instructions` |
| Settings that matter | `thinking: {type: "adaptive"}`, `output_config.effort` (`low`…`max`, default differs by model), `max_tokens` is a per-request cap covering thinking | `reasoning.effort`, `max_output_tokens`, `service_tier` |
| Mid-stream failure | `error` event (e.g. `overloaded_error`); resume only from the last **text** block; `tool_use` and `thinking` cannot be partially recovered | `response.failed` / `response.incomplete` with `incomplete_details.reason` |
| Cost surprises | thinking billed as output even when `display` is `summarized` or `omitted`; changing effort or thinking settings invalidates the prompt cache | reasoning tokens billed as output; omitting earlier reasoning items weakens caching; above ~272K input tokens the **whole request** moves to a higher rate (2x input, 1.5x output on the listed models) |
| Compatible servers | n/a | OpenAI recommends Responses for new work. Chat Completions stays supported, but from GPT-5.4 it cannot call tools with a `reasoning_effort` other than `none`, so real OpenAI use means Responses. llama.cpp, vLLM and similar mostly speak Chat Completions |

Two things follow immediately: the neutral stream must carry **opaque, verbatim blocks** (we replay them), and
the two providers disagree on identity and on when usage is final, so the adapters, not the loop, normalise
that.

## 3. Decisions

### P1. A context builder comes first, and it is pure

`buildContext(entries, options) → ModelContext`, no network, no provider code:

```ts
interface ModelContext {
  system: string;                       // from config/skills, see P6
  turns: Turn[];                        // user | assistant | tool_results, in order
  tools: ToolDefinition[];              // JSON-schema'd, supplied by the agent loop
  cacheHints: number[];                 // turn indexes where a stable prefix ends (end of system, of tools, of a compaction summary, of the last completed turn)
}
```

- It consumes `contextEntries`, then renders the entries that have no provider equivalent as text with fixed
  wording: a compaction summary, `subagent_result`, `fork_merge` ("the user forked this conversation here,
  discussed X, and changed Y"), `interrupted`. `config_changed` and `branch_start` markers are not shown.
- **An interrupted partial never replays as a live tool call**: a half-received call has no result and would
  make the next request invalid. Partial text is kept; partial tool calls become a short text note.
- **Reasoning is replayed only to the model that produced it** (same provider, same model id). Anything else is
  dropped, with the consequences (cold cache, less context for the model) documented. Replaying across models is
  at best useless and on Anthropic risks a 400.
- Golden tests run it over the lifecycle conversation's history.

### P2. The adapter is a stateless function from context to an event stream

```ts
interface ProviderAdapter {
  readonly type: string;                              // "anthropic", "openai", "openai-compatible", ...
  readonly providerSchema: StandardSchema;            // connection, auth, transport (P6)
  readonly settingsSchema: StandardSchema;            // per-request knobs for a model (P8)
  describe(model: string): ModelInfo | undefined;     // capabilities, window, price reference (P8, P9)
  estimate(ctx: ModelContext, s: Settings): Estimate; // tokens + worst-case cost before sending (P9)
  stream(req: { context: ModelContext; model: string; settings: Settings; signal: AbortSignal }): ModelStream;
}
type ModelStream = AsyncGenerator<StreamEvent, Completed>;   // yields events, returns the final result
```

Neutral events (all adapters emit these and nothing else):

- `started` (provider response id, if any, goes to `ext`)
- `text.delta`, `reasoning.delta` (readable part only), `tool_call.start` (`call_id`, `name`), `tool_call.delta`
- `block.done` with the **complete block**, including the opaque reasoning payload exactly as the provider sent it
- `usage` (always cumulative, normalised, raw counts kept)
- the generator **returns** `Completed { blocks, stop_reason (normalised and raw), usage, ext }`, ready to be
  committed as an `assistant` entry, or **throws** `ProviderError { kind, retryable, partial, status? }` where
  `partial` is whatever blocks completed before the failure.

Exactly one terminal state per stream: completed, error, or aborted (abort throws with `kind: "aborted"` and
`partial`). The caller never has to interpret provider event names.

### P3. A shared base for HTTP providers; a "direct" adapter implements the interface itself

`providers/http.ts` is a template, not a base class everyone must extend:

- takes an injected `fetch` (web-standard, so the core stays runtime-independent), builds requests, parses SSE
  (own parser, tested with arbitrary chunk boundaries like the transcript framing), enforces an **idle timeout**
  between events as well as an overall one, and honours `AbortSignal`;
- retries only **before the first content event** (connection errors, 429, 5xx, `overloaded`), with jittered
  backoff and `retry-after`; after content has started it never retries by itself, because the partial output
  was paid for and the caller must decide (P5);
- classifies errors (auth, rate limit, context too long, invalid request, overloaded, server) and strips
  secrets from every message it produces;
- shares a per-provider concurrency limiter, so a fan-out of subagents does not stampede one rate limit.

A provider implements three small functions: `buildRequest(ctx, settings)`, `onEvent(sse, state) → StreamEvent[]`,
`finish(state) → Completed`. Anthropic and OpenAI Responses each do that. An in-process "direct" adapter
(for example a native llama.cpp binding) implements `ProviderAdapter` without any of it.

**Raw `fetch` rather than the vendor SDKs** (question Q2): no dependency, the core stays portable, and we
keep the raw payloads we must replay. The price is that we track API changes ourselves; the conformance suite
(P11) is what makes that tolerable.

### P4. Stateless by construction

- Anthropic is stateless already.
- OpenAI is always called with `store: false` and `include: ["reasoning.encrypted_content"]`; we never use
  `previous_response_id` or a server-side conversation. Server state would not survive our forks, compactions or
  model switches, would make the git history not the source of truth, and conflicts with zero-retention accounts.
- Consequence: every request resends the whole visible context. That is what prefix caching is for, and it is
  why `cacheHints` exist (P1). Anthropic: the adapter turns hints into explicit cache breakpoints. OpenAI:
  automatic prefix caching, so the adapter's job is to keep the prefix **byte-stable** (stable ordering, no
  timestamps in the system prompt).

### P5. Streaming: pass events through; journal them beside the repository, never in the transcript

The two options you gave, and why I'd pick neither as stated:

1. **In-memory passthrough** is the right interface: `stream()` is an async generator and a UI consumes it.
   Alone, it loses the partial response (and the money spent on it) if the process dies.
2. **A streaming entry in `chat.yml`** would break what the transcript guarantees: every entry complete,
   canonical, and committed exactly once, with an incomplete tail meaning "truncate on open". A growing entry is
   a partial write by definition, and it would have to be removed or rewritten before the commit.

**Proposal: option 1 plus an optional journal, as a consumer of the stream rather than part of any adapter.**

- The turn runner tees the neutral events into a **journal**, one append-only file per branch under the git
  directory (`<git-common-dir>/chattree/journal/<branch>.jsonl`, the same place as the lock files, never committed, so no ignore rules are needed). It is
  plain JSON lines, not canonical YAML and not content-addressed, flushed in small batches (a few hundred ms)
  with a documented loss window. Other processes (a UI, a `tail -f`) can follow it.
- It starts with a record naming the request (provider, model, settings, a digest of the context). It ends one
  of two ways, **always before the commit**:
  - success: the `assistant` entry (this *is* the "response complete" record, so no new entry type) is appended
    and committed, then the journal is deleted;
  - interruption: the runner builds an `interrupted` entry from the completed blocks in the journal
    (`partial`, `by: user | error`), commits it, then deletes the journal.
- **Crash recovery** is one more step in `open`, next to truncating a torn entry and committing complete ones: a
  journal with no matching commit becomes an `interrupted` entry with `by: error`, built from its completed
  blocks. The `recovery` event reports it.
- Partial blocks follow what the providers can actually resume: complete text and reasoning blocks are kept; a
  partial tool call or thinking block is not usable and is recorded only as text (P1). "Continue from where it
  left off" is a later, explicit action that builds a new request (Anthropic documents two different ways to do
  this depending on the model), not something the adapter does silently.

### P6. Configuration: providers, models, settings, limits; adapters bring their own schemas

`harness.yml` moves to `version: 2` (with a migration from today's shape):

```yaml
version: 2
providers:                        # connection and auth: one entry per account/endpoint
  anthropic:
    type: anthropic
    api_key_env: ANTHROPIC_API_KEY      # the NAME of an environment variable, never a key
  openai:
    type: openai
    api_key_env: OPENAI_API_KEY
    service_tier: standard              # provider-specific property, validated by the adapter
  local:
    type: openai-compatible
    base_url: http://localhost:8080/v1
models:                           # what to call and how
  main:
    provider: anthropic
    model: claude-opus-5-5
    settings: { max_output_tokens: 16000, thinking: adaptive, effort: medium }
  helper:
    provider: openai
    model: gpt-5.4-mini
    settings: { max_output_tokens: 4000, reasoning_effort: low }
agent: { model: main, subagent_model: helper }
limits: { max_request_usd: 1.00, max_turn_usd: 5.00, max_conversation_usd: 50.00, warn_at: 0.8 }
```

- **Schemas by tag.** An adapter registers itself the way entry types register (`defineEntry`): a `type` name,
  a provider schema and a settings schema. The loader validates `providers.<name>` with the schema of its
  `type`, and `models.<name>.settings` with the schema of its provider's adapter, so an adapter can demand any
  properties it likes (`api_version`, `organization`, `region`) without the core knowing them. Adapters
  describe schemas through Standard Schema, so a third-party adapter is not tied to zod. If you meant
  *YAML tags* (`!anthropic {...}`) literally, that also works with the `yaml` package and matches the
  transcript's `!tag` convention; I prefer a `type:` key because it shows up in editors and JSON-schema tools
  (question Q3).
- Everything that is not an adapter's business (the shape of `providers`, `models`, `agent`, `limits`,
  cross-references like "model names a provider that exists") stays in the core schema.
- The existing `model:` block is migrated to one provider plus one model named `main`.

### P7. Secrets: names in config, values from a source that cannot be committed

- Config stores **names** (`api_key_env`), so `config_changed` hashes and the repository never contain a secret.
- Resolution goes through an injected `SecretSource: (name) => string | undefined` (the core never reads
  `process.env`). The Node entry point supplies, in order: the process environment, then a repo-local file.
- The repo-local file lives at **`<git-common-dir>/chattree/env`** (dotenv syntax), inside `.git/`, so it is
  shared by all worktrees (a gitignored file in the main worktree would not exist in a subagent's worktree) and
  `git add -A` or `git add -f` cannot commit it. A dotfile inside the worktree is also supported **only if
  `git check-ignore` says it is ignored**; otherwise loading it fails with an explanation rather than reading a
  file that the next `append` would commit. `create` writes the `.gitignore` entry for that case.
- **Every resolved secret is registered with the write pipeline's `redact`**, and with the error scrubber in
  the HTTP base, so a key can never reach the transcript, the journal, a log line or an error message, even if a
  tool result echoes it.
- Validation reports a missing variable as an error naming the variable and the provider that needs it, at
  `open` and at `changeConfig`, not at the first request an hour in.

### P8. Provider config, model settings, and what "valid" means

Three levels, validated separately, because they fail differently:

| Level | Examples | Changing it mid-conversation |
| --- | --- | --- |
| **Provider** (connection, auth, transport) | base URL, key variable, service tier, region | invisible to the transcript, but can change cost (tier) |
| **Model** (identity) | provider + model id | reasoning is dropped, the cache goes cold, the context window may shrink |
| **Settings** (per-request knobs) | effort, thinking, temperature, max output tokens | can invalidate the cache (Anthropic) and changes cost |

Validation has two phases and three severities:

1. **Shape**: the adapter-supplied schemas (types, ranges, enums). Errors only.
2. **Semantics**, against a **model catalog** each adapter ships (`describe(model)`): context window, maximum
   output, supported effort levels, whether temperature is allowed with thinking, whether forced tool choice is
   allowed with the chosen thinking mode (the Anthropic docs say some current models reject that), price
   reference, deprecation. Examples: unsupported effort for that model is an **error**; `max_output_tokens`
   above the model's maximum is an **error**; a model not in the catalog is a **warning** ("capabilities
   unchecked, cost unknown"), never an error, because new models appear weekly; the user can supply
   `capabilities` and `price` overrides in the model entry.

`validateConfig(config, adapters, secrets, conversation)` returns issues `{severity, path, message}`, like
`verifyHistory`. Errors block `changeConfig`; warnings are returned with the result and shown. Checks that
need the conversation itself: current context size against the new model's window (error if it no longer
fits), a provider switch dropping reasoning that the next turn needs (warning), and the cost comparison in P9.

### P9. Cost: estimate before sending, budget from the transcript, warn on change, never guess silently

No provider API returns prices, so cost is computed from **usage × a price table**, and everything below
treats the table as data with provenance, not as truth.

- **Price table.** Per model: input, cached input, cache write (by TTL, Anthropic), output, long-context
  threshold and multipliers, tier multipliers. Shipped with the adapters with an `asOf` date, overridable in
  config, and a warning when it is older than 90 days. A model with no price is shown as **unknown cost**,
  never as zero; a limit `unknown_price: warn | block` decides what happens next.
- **Pre-flight estimate** for every request: input tokens (the provider's token-counting endpoint if cheap, a
  conservative character heuristic otherwise, labelled as an estimate) plus **`max_output_tokens`** priced as if
  fully used. This is the worst case, and it is why `max_output_tokens` is **required** in config: no provider
  default unbounded.
- **The ledger** is a fold over the transcript: sum of each `assistant` entry's usage priced at the table
  version recorded with it, plus the rollup recorded in `subagent_result` / `fork_merge` (P10), because a
  subagent's own entries live on its branch. Budgets therefore survive restarts and forks (a fork inherits what
  was spent before it), and `verifyHistory` can recompute it.
- **Limits** (config): `max_request_usd` (checked against the estimate, blocks the request), `max_turn_usd` (a
  tool loop is many requests, and `max_tokens` is per request), `max_conversation_usd`, plus
  `max_requests_per_turn` and a wall-clock cap. `warn_at` fires a `cost` event before the limit is reached. An
  interactive host can answer the event with proceed or abort.
- **Surprises the library checks for specifically**, because they are the ones that actually bite:
  - *Model or tier switch*: "the next turn is estimated at $0.04 on the current model and $1.20 on the new one
    (30x), for this conversation's current size." Computed from the real context, not a price list.
  - *Price spread*: the listed OpenAI models span about 300x in input price between the cheapest and the
    "pro" tier, so a one-line config edit can change spend by two orders of magnitude.
  - *Long-context cliff*: one provider moves the **whole** request to a higher rate above a size threshold; the
    estimate warns when a request is within 10% of the threshold or over it.
  - *Cache loss*: changing effort or thinking settings (Anthropic), dropping reasoning items, compaction, or
    waiting past the cache lifetime makes the next request pay full input price; the estimate reports it.
  - *Fan-out*: N subagents multiply a loop's spend; `max_subagent_usd` caps each, the conversation limit caps
    the sum.
  - *Paid partials*: a failed or interrupted response was still billed; usage on `interrupted` entries is
    recorded (P10), not lost.

### P10. Entry format changes (additive, format 1.3)

- `assistant`: `usage` normalised to `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`, `reasoning_tokens` with the provider's raw usage kept in `ext`; optional
  `cost: { usd, table: "<asOf>", estimated: true }` so history stays interpretable after prices change;
  optional `request: { service_tier, effort, max_output_tokens }` as actually sent.
- Content blocks get an optional `ext` so a provider can keep what replay needs (OpenAI's item `id` next to
  `call_id`); reasoning keeps its opaque `payload`.
- `interrupted`: optional `usage` and `cost`.
- `subagent_result` / `fork_merge`: optional `usage` and `cost` rollups of the child branch.
- `stop_reason` stays a string, normalised, with the raw value in `ext`.
- All fields optional, so older readers ignore them.

### P11. Testing without calling the providers

- **Recorded fixtures.** Real streams (text, tool calls, thinking, errors, mid-stream failure) captured once,
  redacted, committed as SSE files. Each adapter must turn each fixture into the expected neutral events.
- **Chunking property test.** Any split of a fixture into network chunks, including mid-line and mid-UTF-8,
  must yield identical events (the same idea as the transcript framing fuzz).
- **Fake server** in `node:http` for transport behaviour: retry before first content only, `retry-after`,
  idle timeout, abort, 429 and 5xx, a connection reset mid-stream.
- **Replay round trip.** `assistant` entry → context builder → request body: reasoning blocks come back
  byte-identical, tool calls and results are paired, foreign reasoning is dropped.
- **Conformance suite** every adapter (ours or third-party) runs: exactly one terminal state, cumulative
  usage never decreases, complete blocks match the deltas, secrets never appear in any event or error.
- **Live tests**, opt-in by environment variable, tiny `max_output_tokens`, a hard spend cap in the test.
- **Journal** crash sweeps like the ones for `append`: fail at every operation, reopen, history verifies, an
  interrupted entry exists for any orphan journal.

## 4. Layout

```
harness/context-builder.ts     P1  entries -> ModelContext
harness/ledger.ts              P9  cost fold over a transcript
harness/secrets.ts             P7  SecretSource, repo-local env, redaction wiring
harness/config.ts              P6  version 2 core schema + migration
harness/validate.ts            P8  validateConfig
harness/turn.ts                P5  context -> adapter -> journal tee -> commit (single request; the tool loop is later)
harness/journal.ts             P5  append, replay, recovery
providers/types.ts             P2  interfaces and neutral events
providers/http.ts, sse.ts      P3  shared transport, SSE parser
providers/anthropic/           P3  request/response mapping, catalog, prices
providers/openai/              P3  Responses mapping (Chat Completions for compatible servers later)
test/providers/fixtures/       P11 recorded streams
```

`src/` (the core) is untouched: no provider code, no `process.env`, `fetch` injected.

## 5. Build order

1. **Context builder** and golden tests (P1). Needed by everything; no network.
2. **Provider types, SSE parser, HTTP base, fake server, conformance suite** (P2, P3, P11).
3. **Anthropic adapter** against fixtures; then **OpenAI Responses adapter**.
4. **Config v2, secrets, registry schemas, validation with severities** (P6–P8), with migration of the
   existing `harness.yml`.
5. **Catalog, price table, ledger, estimate, limits, warnings** (P9, P10 format 1.3).
6. **Turn runner and journal** with recovery in `open` and crash sweeps (P5).
7. **Live smoke tests**, docs, and an example in the lifecycle test using a fake provider.

The tool-execution loop, system-prompt assembly from skills, and MCP are separate from this plan.

## 6. Out of scope here

The tool loop and permissions; skills and MCP; context-window management policy (when to compact); a
Chat Completions adapter for llama.cpp, vLLM and similar (designed for, built after Responses: the
`openai-compatible` type in the config above is that adapter); prompt-cache tuning beyond hints; batch APIs.

## 7. Questions for you

- **Q1. Journal location.** Under the git directory (my recommendation, never committed, shared across
  worktrees), or a gitignored dotfile in each worktree?
- **Q2. Raw `fetch` or the vendor SDKs?** I recommend raw `fetch` plus our own SSE parsing (P3).
- **Q3. Config discriminator.** A `type:` key (my recommendation) or YAML `!tags`? And is moving to config
  `version: 2` with a migration acceptable?
- **Q4. Cost in the transcript.** Record an estimated `cost` and the price-table date in each `assistant` entry
  (self-contained history), or record usage only and price it when read?
- **Q5. Budget enforcement.** Hard limits enforced by the library (a request over the limit is not sent), or
  advisory events the host may ignore? I'd make limits hard and warnings advisory.
- **Q6. Stateless only.** Are you happy to give up OpenAI's stored conversations and `previous_response_id`
  completely (P4)?
- **Q7. Where tool schemas and the system prompt come from.** Today config has tool *names* only. I assume the
  agent loop owns tool definitions and a prompt assembler builds `system`; the adapters just receive them.
- **Q8. Price table maintenance.** Bundled with a date and overridable (my recommendation), or fetched at
  runtime from somewhere? Bundled means someone has to update it.
- **Q9. Provider switch mid-conversation.** Drop reasoning silently and warn (my recommendation), or refuse the
  switch while a tool loop is in flight?
- **Q10. Scope of the first release.** Anthropic and OpenAI Responses only, with `openai-compatible` (and the
  existing `llama.cpp` value) deferred?

## 8. Sources and what I could not check

Checked in this session:

- Anthropic, [streaming messages](https://platform.claude.com/docs/en/api/messages-streaming): events, delta
  types, cumulative usage, mid-stream errors, partial-response recovery.
- Anthropic, [thinking with tool use](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)
  and [thinking cost and effort](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost):
  verbatim replay, `display`, `output_config.effort`, thinking-token billing, forced tool choice restrictions,
  cache invalidation on effort change.
- OpenAI, [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events),
  [reasoning items](https://developers.openai.com/cookbook/examples/responses_api/reasoning_items) and
  [Responses vs Chat Completions](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions?api-mode=responses).
- OpenAI price spread, long-context threshold and tier multipliers:
  [a third-party price table dated 20 October 2026](https://developer.puter.com/tutorials/openai-api-pricing/).
  **Treat it as illustrative**; the real table must come from the provider's own pricing page.

**Not verified** (the pages were not reachable from this session):

- Anthropic's **prompt caching** details (breakpoint limits, TTL options, write/read multipliers, minimum
  lengths) and its **price table**. P4 and P9 describe the cache design in general terms only; the numbers need
  a pass against the official pages before the catalog is written.
- Whether OpenAI requires a replayed reasoning item to travel with the item that followed it in every case
  (it is reported to), and whether message item ids are needed for stateless replay. The first live tests
  must settle both before the OpenAI replay path is trusted.
