# Writing a provider adapter

An adapter turns one request context into a stream of neutral events. It is stateless: it knows nothing about
git, the transcript, journals or budgets. This page is the contract and the workflow; the plan and the reasons
are in `docs/providers.md` (P2, P3, P12). The types are in `providers/types.ts`.

## The contract

```ts
interface ProviderAdapter {
  readonly $tag: string;                    // the `$tag` it handles in harness.yml
  stream(req: { context; setup; signal }): ModelStream;
  classify?(from, to, ctx): Change[];       // what a setup change does that the harness cannot tell
}
type ModelStream = AsyncGenerator<StreamEvent, Completed, void>;
```

A stream yields events and **returns** `Completed`, or **throws** `ProviderError`. Exactly one terminal state.
Closing it early cancels the request.

- **Events**: `started`, `observed` (the model that served the request, service tier, response id), `text.delta`,
  `reasoning.delta` (the readable part only), `tool_call.start` / `.delta`, `block.done`, `usage`. The deltas are
  for showing progress; `block.done` carries the **complete** block. Anything opaque (a thinking signature,
  encrypted reasoning, a provider compaction item) goes in a block's `payload` **exactly as the provider sent
  it**, because it is replayed verbatim and the provider rejects it if it changed. A reasoning block's `payload` is the
  provider's own object (a map, stored as YAML in the transcript) and **holds only what `visible` does not**: the readable
  text is stored once, in `visible`, and the adapter puts it back when it replays (Anthropic keeps `{type, signature}` and
  rebuilds `thinking` from `visible`; a server that only returns reasoning text, like Ollama or llama-server, needs no payload at
  all). A compaction item's `payload` is still the provider's JSON as text.
- **Usage** is cumulative for the response so far and never decreases. Thinking tokens are included in
  `output_tokens` (providers bill them as output); report them separately in `reasoning_tokens` too.
- **`Completed`**: the blocks in order, a `stop_reason` (`end_turn`, `tool_use`, `max_tokens`, `refusal`, `pause`,
  otherwise as the provider said it), usage, `observed`, and `ext` for round-trip data with no other home.
- **Errors**: use the kinds in `ERROR_KINDS`. `retryable` means trying the same request again could work. The
  stream attaches the complete blocks received so far as `partial`; do not fill it yourself.
- **Tool arguments**: the provider's argument string is parsed when its block ends. If it is not valid JSON, set
  `args: {}` and keep the original text in `args_raw`; never throw it away.
- **Tolerate what you do not know**: unknown event types and comments are ignored, not errors. Providers add them.
- **Secrets**: never put a credential in an event, an error or a log. The HTTP base scrubs known secrets from errors
  and hook views; an adapter that is not built on it must do the same.

## The HTTP base (`providers/http.ts`)

Most providers speak SSE over HTTP. `httpStream(mapper, req, options)` does the shared work; you supply an
`HttpMapper` (three functions and an optional classifier):

```ts
interface HttpMapper<S> {
  request(req): { url; method?; headers; body? };   // no credentials here
  start(req): S;                                     // fresh state per attempt
  event(sse, state): StreamEvent[];                  // one SSE event in, neutral events out; may throw ProviderError
  done(state): boolean;                              // has the provider's final event arrived?
  finish(state): Completed;
  classify?({ status, headers, body }): { kind?, retryable?, message?, retryAfterMs? } | undefined;
}
```

What the base does so you do not have to: the request (with `auth` headers added last), our own SSE parser (any
chunking, any line ending), idle and total timeouts, retry with backoff and `retry-after`, concurrency limiting,
cancellation, error classification, secret scrubbing, and one rule about time:

> **Retries happen only before the first content event.** `started`, `observed` and `usage` before the first
> text, reasoning or tool event are held back until content arrives (or the stream ends), so a retried request
> never shows the consumer a second `started`. After content has been yielded nothing is retried: the partial
> output was paid for, and the caller decides.

Everything is an option with a default, and any of it can be replaced:

| Option | Default | To change it |
| --- | --- | --- |
| `fetch` | global `fetch` | pass any web-standard `fetch` (a proxy, a recorder, a test double) |
| `auth` | none | return the credential headers; their values are scrubbed from errors and hooks |
| `secrets` | none | more values to scrub |
| `retry` | 4 attempts, 500 ms doubling, 30 s cap, jitter | any of `maxAttempts`, `baseMs`, `maxMs`, `jitter`, `shouldRetry` |
| `timeouts` | 60 s idle, 10 min total | `idleMs`, `totalMs` |
| `limiter` | none | share one `Limiter` across the instances of a provider |
| `hooks` | none | `onRequest`, `onResponse`, `onSse`, `onRetry`: redacted views, cannot break a request |
| `sleep` | timer | tests inject an instant one |

An adapter whose provider keeps conversation state may implement `retrieve` (fetch a finished response by the id it
reported) and may chain requests. Chaining must be an optimisation with a proof: put a digest of what the provider saw
in `Completed.ext`, continue only when the next context's prefix has the same digest, and fall back to a full replay
when the provider has forgotten the state (see `planChain` in `providers/openai-responses.ts`).

The turn runner (`harness/turn.ts`) is the only caller of `stream`. It journals every event you yield, so keep `block.done`
blocks complete and put the response id in `observed` as early as you know it: after a crash, `open` uses it to call
`retrieve` and commit the finished response instead of an `interrupted` entry. If the stream is aborted, throw
`ProviderError` of kind `aborted` promptly; the runner records what had arrived.

An adapter whose provider has a token-counting endpoint may implement `countTokens` (use `jsonRequest` from `providers/http.ts`):
send the request without generation settings or cache markers, return the input token count, throw `ProviderError` on failure.

A provider that is not HTTP and SSE (an in-process engine, a socket protocol) implements `ProviderAdapter`
directly and ignores all this. The conformance checks below apply to it all the same.

## Registering the adapter

An adapter becomes usable from `harness.yml` by registering a definition (`defineAdapter` in `providers/registry.ts`):

- `$tag`: what a provider's `$tag` (or `!tag`) says. Lowercase letters, digits, `-`.
- `config`: a Standard Schema for the provider's keys, `$tag` included. Make it strict so a misspelt key is an error.
  Use `envName` for any key that names an environment variable (it refuses a pasted key), and spread
  `commonProviderFields` / `httpOptionsFor` for `max_concurrent`, `timeouts` and `max_attempts`.
- `settings`: a Standard Schema for the model settings stored in `agent_setup`.
- `jsonSchema()`: JSON Schema for both (zod's `z.toJSONSchema` does it), used for the editor schema.
- `secrets(config)`: the environment variable names it needs; `open` fails naming each one that is unset.
- `create(config, secrets)`: build the adapter. Never put a key in the config, a log, an error or an entry.

`defaultRegistry()` in `providers/index.ts` has the built-in adapters; give `Conversation` a registry of your own
with the `providers` option to add more.

## Tests: fixtures, conformance, the fake server

1. **Record** a real response once: `node tools/record-fixture.ts request.json out.fixture.json`
   (`${NAME}` in the request is filled from the environment, and every value filled in, plus headers that
   identify the account, is scrubbed). **Read the fixture before committing it.**
2. **Replay** it with `replayFetch(fixture, chunkSizes)`, and pass that as the adapter's `fetch`. Replay each fixture
   at one chunk size and at many random ones: the result must not depend on how the network cut the bytes.
3. **Check conformance** on every run: `conformanceProblems(await collectStream(adapter.stream(req)), { secrets })`
   must be empty. It checks that there is exactly one terminal state, `started` comes first and once, usage never
   decreases, `block.done` matches its deltas, the returned blocks are the completed blocks in order, an error's
   `partial` is the blocks completed before it, and no secret appears anywhere in the output.
4. **Fault-test** against `test/support/fake-server.ts` (scripted replies: statuses, headers, delays, a reset, a
   hang) for anything fixtures cannot show: retries, timeouts, abort, a reset mid-stream.
5. Cover, at least: text, a tool call (with arguments split across events), reasoning with an opaque payload, an
   error status, an error event in the stream, a stream that ends early, usage, and an unknown event.

## Checking against a real server

`node tools/live-check.ts --flavor anthropic --base-url http://localhost:11434 --model <model>` (or
`--flavor openai-responses --base-url http://localhost:11434/v1`, or `--flavor openai-compatible` for Chat Completions) runs the adapter through a handful of scenarios
and the conformance checks on each. `--api-key-env NAME` reads a key from the environment (never put a key on the
command line), `--record DIR` saves each scenario's events with secrets scrubbed (a start for a fixture),
`--only NAME` narrows it, `--list` names the scenarios. A scenario the model cannot do (no tools, no reasoning) is
a skip; any failure exits non-zero. Add a flavor in `makeAdapter` when you add an adapter.

## When the provider changes its API

Re-record the fixtures, diff them against the old ones (the diff is the change), fix `request`, `event` and
`finish`, and run the conformance checks. Nothing else in the harness depends on the provider's wire format.
