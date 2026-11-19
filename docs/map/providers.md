# `providers/`: model APIs

**Purpose.** Everything that talks to a model: one adapter per API style (a stateless function from a request context to a stream of neutral events), the shared HTTP transport, prices and catalogs, and the dialects used for local models. It knows wire formats; it knows nothing of git, the transcript, journals or budgets. Reasons: ADR 15, 16, 17.

**Depends on:** `src/`, and the context and definition types from `harness/`. **Used by:** `harness/turn.ts` (the only caller of `stream`), `cli/`.

## The contract (`types.ts`)

An adapter has a `$tag`, a provider schema, a settings schema per model, `catalog()`, `pricing()`, `classify()`, `estimate()`, `stream()`. `stream` yields neutral events (`started`, `observed`, `text.delta`, `reasoning.delta`, `tool_call.start/.delta`, `block.done`, `usage`), returns `Completed`, or throws `ProviderError { kind, retryable, partial }`. Exactly one terminal state per stream. Opaque payloads (thinking signatures, encrypted reasoning, compaction items) are kept exactly as the provider sent them.

## Files

| File | Role |
|---|---|
| `types.ts` | The whole provider contract: events, `Completed`, `ProviderError`, usage. |
| `registry.ts` | Adapters register by `$tag` (`defineAdapter`): provider schema, settings schema, secrets needed, `create`. The loader validates each `harness.yml` provider with its adapter's schema. |
| `index.ts` | `defaultRegistry()` of the shipped adapters. Local models are deliberately not in it: their adapter needs a running host. |
| `http.ts` | Shared transport for SSE-over-HTTP adapters: auth, retry (only before the first content event), timeouts, concurrency limiter, error classification, secret scrubbing, cancellation. A provider supplies an `HttpMapper` (request, start, event, done, finish, classify). |
| `sse.ts` | Our own SSE parser (any chunking, any line ending). |
| `anthropic.ts` | Anthropic Messages (and servers that speak it): cache breakpoints, signed thinking, usage. |
| `openai-responses.ts` | OpenAI Responses: stored responses, `previous_response_id` chaining with a verified fallback to replay, encrypted reasoning, server-side compaction items, retrieval for crash recovery. |
| `openai-compatible.ts` | Chat Completions as llama-server, Ollama, vLLM and others speak it. Stateless; every request replays the context. A tool call's `extra_content` (Gemini's thought signature) is kept in the block's `ext` and sent back with the call; an error body in a list (Gemini's) is unwrapped, and one with no message shows the body. |
| `gemini.ts`, `opencode-go.ts` | Services reached through Chat Completions, with a bundled model catalog and service-specific headers. |
| `local-models.ts` | The provider for models chattree runs itself: address, catalog and identities come from the local model host at runtime. Can use dialects. |
| `think-tags.ts` | Splits `<think>...</think>` reasoning out of an answer when a server leaves it inline. |
| `pricing.ts`, `pricing-data.ts` | Price tables as plain data (per meter, tier, context band), pinned by hash in the setup; the bundled tables with their dates. |
| `catalog/` | Bundled model lists (`gemini-rows.ts`, `opencode-go-rows.ts`) and `refresh.ts`, the pure half of `npm run catalog`. |
| `media-specs.ts` | What each wire carries (images, sound, PDF), for media conversion. |
| `identity.ts` | chattree's User-Agent. |
| `wire.ts` | Reading fields of JSON off the wire. |
| `conformance.ts`, `fixtures.ts` | The checks every adapter's stream must pass, and record/replay of HTTP responses with chunk splitting, for tests. |
| `dialect.ts`, `dialects/` | Our own prompt rendering and output parsing for local models over `/completion` (ADR 33); see below. |

## Dialects (`dialects/`)

A dialect (interface in `providers/dialect.ts`) renders a folded context to one raw prompt and parses the model's output back into blocks, over llama-server's `/completion` (ADR 33). Most chat formats are the same machine with different tokens, so they are declared as *families*.

| File | Role |
|---|---|
| `family.ts`, `families.ts` | `defineFamily`: a dialect as a declaration (role markers, tool list placement, call and result markers, thinking tags), and the declared formats, checked against each model's own template by parity tests. |
| `harmony.ts`, `harmony-builtin.ts` | Harmony (gpt-oss): messages with channels, tools as TypeScript, and the built-in `python` and `browser` convention. |
| `gemma.ts`, `qwen-xml.ts` | Gemma 4 and Qwen3.5/Qwen3-Coder formats, with their own argument parsers. |
| `media.ts` | Pictures and sound as the server's media markers in a prompt. |
| `schema-tree.ts`, `scan.ts` | A tool's schema as a typed tree that dialects read; helpers for parsers that read a stream in arbitrary pieces. |
| `index.ts` | The built-in dialects and the rule that maps a model name to one (`dialectForModel`). |

## Invariants

- An adapter is stateless and never retries after content has been yielded: the caller decides, because the partial output was paid for.
- Server-side state (stored responses, chaining) is an optimisation with a verified fallback; the full context can always be replayed.
- No credential appears in an event, error or log. Adapters built on `http.ts` get scrubbing for free; one that is not must do the same.
- Prices are data, dated, and pinned; an unknown price is unknown, never zero.
- An id (`$tag`, dialect id, renderer id) never changes meaning once released.

## To change X

- *Support a new API:* see [Extending: provider adapters](../extending/provider-adapters.md); add the adapter file, register it in `index.ts`, add fixtures and conformance tests (`test/providers/`).
- *The provider changed its API:* re-record the fixtures, diff them, fix the three mapper functions, run conformance.
- *Update bundled prices or models:* `pricing-data.ts` (dated by hand) or `npm run catalog -- <service>` for the catalogs; check the page named in the file's header.
- *A new price meter or tier:* `pricing.ts` and the ledger in `harness/ledger.ts`.
