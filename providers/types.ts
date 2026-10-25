import type { Block, ModelContext } from "../harness/context-builder.ts";
import type { AgentSetup, Change } from "../harness/setup.ts";

/**
 * The provider seam (docs/providers.md, P2). An adapter is a stateless translation: it takes a `ModelContext`
 * and the agent's setup, makes one request, and streams neutral events. It knows nothing of git, the
 * transcript, journals or budgets. This file is the whole contract; `docs/writing-an-adapter.md` explains it.
 */

/**
 * Token counts, normalised so that the meters are disjoint and each is billed at its own rate:
 * total input = `input_tokens` + `cache_read_tokens` + `cache_write_tokens`. (A provider that reports cached tokens
 * as part of its input count, like OpenAI, has them subtracted.) Providers that do not report a field leave it out.
 * `raw` is the provider's own object.
 */
export interface Usage {
  /** Input tokens that were neither read from nor written to a cache. */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Included in `output_tokens` (providers bill thinking as output); reported separately for analysis. */
  reasoning_tokens?: number;
  raw?: Record<string, unknown>;
}

/** What the provider says about how it served the request. A model that differs from the setup becomes an `agent_setup`. */
export interface Observed {
  /** The model that served the request (a dated snapshot where the provider resolves aliases). */
  model?: string;
  service_tier?: string;
  /** The provider's id for this response (retrieval, recovery). */
  response_id?: string;
}

/**
 * What a stream yields. `block.done` carries the complete block, including opaque payloads exactly as the
 * provider sent them (they are replayed verbatim); the deltas exist only so a UI can show progress.
 * `started`, `observed` and `usage` before the first content event are held back by the HTTP base until content
 * arrives (or the stream ends), so a retry never shows the consumer a second `started`.
 */
export type StreamEvent =
  | { type: "started" }
  | { type: "observed"; observed: Observed }
  | { type: "text.delta"; index: number; text: string }
  | { type: "reasoning.delta"; index: number; text: string }
  | { type: "tool_call.start"; index: number; call_id: string; name: string }
  | { type: "tool_call.delta"; index: number; args_delta: string }
  | { type: "block.done"; index: number; block: Block }
  /** Cumulative for the response so far: never decreases. */
  | { type: "usage"; usage: Usage };

/** What a stream returns when it ends well. */
export interface Completed {
  blocks: Block[];
  /** Normalised: `end_turn`, `tool_use`, `max_tokens`, `refusal`, `pause`; anything else is passed through as the provider said it. */
  stop_reason: string;
  usage: Usage;
  observed: Observed;
  /** Provider round-trip data that has no place in the blocks (response id, prefix digest, ...). */
  ext?: Record<string, unknown>;
}

/**
 * A stream yields events and **returns** `Completed`, or **throws** `ProviderError`. Exactly one terminal state.
 * Closing it early (`return()`) cancels the request.
 */
export type ModelStream = AsyncGenerator<StreamEvent, Completed, void>;

export const ERROR_KINDS = [
  /** The credentials were refused (401, 403). */
  "auth",
  /** Too many requests (429). */
  "rate_limit",
  /** The provider is overloaded or unavailable (503, 529). */
  "overloaded",
  /** The request itself is wrong or too large (400, 413, 422). Retrying cannot help. */
  "invalid_request",
  /** A provider-side failure (500, 502, 504, an error event in the stream). */
  "server",
  /** The connection failed or was reset. */
  "network",
  /** No data within the idle limit, or the overall limit passed. */
  "timeout",
  /** The caller aborted. */
  "aborted",
  /** The provider's output did not follow its own protocol (stream ended early, malformed event). */
  "protocol",
  /** The provider declined to answer for policy reasons. */
  "content_filter",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface ProviderErrorInit {
  kind: ErrorKind;
  message: string;
  status?: number;
  /** Whether trying the same request again could work. The HTTP base retries only these, and only before content. */
  retryable?: boolean;
  /** How long the provider asked us to wait. */
  retryAfterMs?: number;
  /** Blocks that were complete before the failure. Filled in by the stream when it throws. */
  partial?: Block[];
  cause?: unknown;
}

export class ProviderError extends Error {
  override name = "ProviderError";
  readonly kind: ErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  partial: Block[];
  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
    this.partial = init.partial ?? [];
  }
}

export interface StreamRequest {
  context: ModelContext;
  setup: AgentSetup;
  /** Aborting it ends the stream with a `ProviderError` of kind `aborted`. */
  signal: AbortSignal;
}

/** The part of an adapter the turn runner needs. Catalog, pricing, estimates and schemas arrive with later steps. */
export interface ProviderAdapter {
  /** The `$tag` it handles in `harness.yml`. */
  readonly $tag: string;
  stream(req: StreamRequest): ModelStream;
  /** What a change of setup does that the harness cannot tell (cache, cost, capabilities). */
  classify?(from: AgentSetup, to: AgentSetup, ctx: { midLoop: boolean }): readonly Change[];
}
