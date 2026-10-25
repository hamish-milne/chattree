import { cacheWriteRate, findModel, ratesFor, ttlMinutes, type ModelPrice, type PriceTable, type Rates } from "../providers/pricing.ts";
import type { ModelInfo } from "../providers/registry.ts";
import type { Change } from "./setup.ts";
import { IMAGE_TOKEN_GUESS, pdfTokenGuess } from "./attachments.ts";
import type { ModelContext } from "./context-builder.ts";

/**
 * A pre-flight estimate of one request (docs/providers.md, P9). Deliberately pessimistic, because it guards a
 * spending limit: input tokens are guessed from the size of the context (about 3 bytes a token, more than most
 * text needs), priced at the plain input rate or, if dearer, the cache-write rate for the requested `cache_ttl` (a write
 * replaces the plain rate), never at the cache-read discount, and the output is priced as if all of
 * `max_output_tokens` is used. Real counts come back in the response's usage; an adapter with a token-counting
 * endpoint can improve on this later.
 */

export interface Estimate {
  inputTokens: number;
  maxOutputTokens: number;
  /** Dollars if every meter involved has a price; `undefined` when the price is unknown. */
  usd: number | undefined;
  /** The model's context window, when known. */
  contextWindow: number | undefined;
  /** The long-context threshold the request is near or past, when the model has one. */
  longContextAt: number | undefined;
  /** True when `inputTokens` is the provider's own count rather than the byte-based guess. */
  counted?: boolean;
}

const BYTES_PER_TOKEN = 3;

/** The dearest a prompt token can cost: plain input, or a cache write at the requested lifetime if that is more. */
function promptRate(r: Rates, cacheTtl: unknown): number | undefined {
  if (r.input === undefined) return undefined;
  const w = cacheWriteRate(r.cache_write, typeof cacheTtl === "string" ? ttlMinutes(cacheTtl) : undefined);
  return w === undefined ? r.input : Math.max(r.input, w);
}

/** JSON for sizing or digesting a context: attachment bytes become their hash and length instead of an array of numbers. */
export function contextJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? `bytes:${v.length}` : v));
}

export function estimateInputTokens(ctx: ModelContext): number {
  const text = contextJson({ system: ctx.system, instructions: ctx.instructions, tools: ctx.tools, turns: ctx.turns });
  let attached = 0;
  for (const t of ctx.turns) {
    if (t.role !== "user") continue;
    for (const p of t.parts) if (p.type === "attachment") attached += p.kind === "image" ? IMAGE_TOKEN_GUESS : pdfTokenGuess(p.bytes.length);
  }
  return Math.ceil(new TextEncoder().encode(text).length / BYTES_PER_TOKEN) + attached;
}

export function estimateRequest(ctx: ModelContext, model: { id: string; settings?: unknown }, table: PriceTable | undefined, info?: ModelInfo, counted?: number): Estimate {
  const inputTokens = counted ?? estimateInputTokens(ctx);
  const maxOutputTokens = Number((model.settings as { max_output_tokens?: unknown } | undefined)?.max_output_tokens ?? 0);
  const price = table === undefined ? undefined : findModel(table, model.id);
  const tier = (model.settings as { service_tier?: unknown } | undefined)?.service_tier;
  let usd: number | undefined;
  if (price?.free === true) usd = 0;
  else if (price !== undefined) {
    const r = ratesFor(price, typeof tier === "string" ? tier : undefined, inputTokens);
    const per = r === undefined ? undefined : promptRate(r, (model.settings as { cache_ttl?: unknown } | undefined)?.cache_ttl);
    if (r?.output !== undefined && per !== undefined) usd = (inputTokens * per + maxOutputTokens * r.output) / 1_000_000;
  }
  return { inputTokens, maxOutputTokens, usd, contextWindow: info?.context_window, longContextAt: price?.long_context?.above_tokens, ...(counted === undefined ? {} : { counted: true }) };
}

/**
 * What switching model or tier does to the next request at the current conversation size, as a `cost_increase`
 * change when it is at least `ratio` times dearer (and at least a cent). The host calls this from its classifier.
 */
export function costIncrease(opts: { tokens: number; maxOutputTokens: number; from: { price: ModelPrice | undefined; tier?: string | undefined }; to: { price: ModelPrice | undefined; tier?: string | undefined }; ratio?: number }): Change | undefined {
  const at = (p: { price: ModelPrice | undefined; tier?: string | undefined }): number | undefined => {
    if (p.price?.free === true) return 0;
    const r = p.price === undefined ? undefined : ratesFor(p.price, p.tier, opts.tokens);
    return r?.input === undefined || r.output === undefined ? undefined : (opts.tokens * r.input + opts.maxOutputTokens * r.output) / 1_000_000;
  };
  const a = at(opts.from);
  const b = at(opts.to);
  if (b === undefined) return { kind: "cost_increase", message: "the price of the new model is unknown, so the cost of the next request cannot be estimated" };
  if (a === undefined || b - a < 0.01) return undefined;
  const times = a === 0 ? Infinity : b / a;
  if (times < (opts.ratio ?? 2)) return undefined;
  const usd = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
  return { kind: "cost_increase", message: `the next request costs about ${usd(a)} now and about ${usd(b)} after${Number.isFinite(times) ? ` (${times >= 10 ? Math.round(times) : times.toFixed(1)}x)` : ""}, at this conversation's size`, estimatedCost: b - a };
}
