import { createHash } from "node:crypto";
import { z } from "zod";
import { stable } from "../harness/setup.ts";

/**
 * Prices (docs/providers.md, P9). A price table is plain data: per model, dollars per million tokens for each meter
 * (input, output, cache read, cache write; reasoning is billed as output and already counted there) for each
 * service tier, and an optional long-context band. Tables are pinned by hash in the agent's setup so that the cost
 * of history never changes under it. An unknown price is unknown, never zero: a local server says `free: true`.
 */

const rate = z.number().nonnegative();
/** A cache lifetime in minutes, as a key (`"30"`, `"720"`). */
const minutes = z.string().regex(/^[1-9]\d*$/, "a whole number of minutes");

/** Dollars per million tokens for each meter of one service tier. A meter that is absent is unknown. */
const rates = z.strictObject({
  input: rate.optional(),
  output: rate.optional(),
  cache_read: rate.optional(),
  /**
   * A single rate, or one rate per cache lifetime keyed by minutes (`{ 30: 12.5, 720: 25 }`): writing to a cache
   * that lasts longer costs more. Tokens whose lifetime the usage does not say are priced at the shortest one.
   */
  cache_write: z.union([rate, z.record(minutes, rate)]).optional(),
});
export type Rates = z.infer<typeof rates>;

/** Rates by service tier, named as the provider's `service_tier` setting names them. Use `standard` when there is only one. */
const ratesByTier = z.record(z.string().min(1), rates);
export type RatesByTier = z.infer<typeof ratesByTier>;

export const modelPrice = z.strictObject({
  /** Explicitly free (a local server). Overrides everything else. */
  free: z.literal(true).optional(),
  /** By tier. `standard` is the default; `default` and `auto` in a request's settings mean `standard`. */
  rates: ratesByTier.optional(),
  /** Requests whose prompt (input, cache read and write together) is longer than `above_tokens` use these rates instead. */
  long_context: z.strictObject({ above_tokens: z.number().int().positive(), rates: ratesByTier }).optional(),
});
export type ModelPrice = z.infer<typeof modelPrice>;

export const priceTable = z.strictObject({
  version: z.literal(1),
  /** When these prices were read, `YYYY-MM-DD`. */
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Where they came from (a URL, or "override"). */
  source: z.string().min(1),
  currency: z.literal("USD"),
  models: z.record(z.string(), modelPrice),
});
export type PriceTable = z.infer<typeof priceTable>;

export const emptyTable = (): PriceTable => ({ version: 1, as_of: "1970-01-01", source: "none", currency: "USD", models: {} });

/** Canonical bytes of a table: sorted-key JSON. Its SHA-256 is the table's hash, and the blob's hash when it is stored. */
export const tableBytes = (t: PriceTable): Uint8Array => new TextEncoder().encode(stable(t));
export const tableHash = (t: PriceTable): string => createHash("sha256").update(tableBytes(t)).digest("hex");

export function parseTable(bytes: Uint8Array): PriceTable | undefined {
  try {
    const r = priceTable.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Overrides in a provider's config: replace single models (or all of them, `free`). Merged over the bundled table. */
export const pricingConfig = z.strictObject({
  /** Every model of this provider is free (a local server). */
  free: z.boolean().optional(),
  models: z.record(z.string(), modelPrice).optional(),
});
export type PricingConfig = z.infer<typeof pricingConfig>;

/** The bundled table with the provider's overrides on top. A model override replaces the whole entry. */
export function effectiveTable(bundled: PriceTable | undefined, overrides: PricingConfig | undefined): PriceTable {
  const base = bundled ?? emptyTable();
  if (overrides === undefined || (overrides.free !== true && overrides.models === undefined)) return base;
  const models = { ...base.models, ...(overrides.models ?? {}) };
  if (overrides.free === true) models["*"] = { free: true };
  return { ...base, source: `${base.source} + overrides`, models };
}

const DATED = /^-(\d{4}-\d{2}-\d{2}|\d{8})$/;

/** The entry for a model id: exact, else the entry whose id the dated id extends (`gpt-5.4-2026-03-05` → `gpt-5.4`), else `*`. */
export function findModel(table: PriceTable, id: string): ModelPrice | undefined {
  const direct = table.models[id];
  if (direct !== undefined) return direct;
  let best: string | undefined;
  for (const key of Object.keys(table.models)) if (key !== "*" && id.startsWith(key) && DATED.test(id.slice(key.length)) && (best === undefined || key.length > best.length)) best = key;
  return best === undefined ? table.models["*"] : table.models[best];
}

export interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | undefined;
  /** All tokens written to a cache. */
  cache_write_tokens?: number | undefined;
  /** Of those, how many went to a cache of each lifetime (keyed by minutes); the rest are priced at the shortest lifetime. */
  cache_write_by_minutes?: Record<string, number> | undefined;
}

export interface Priced {
  usd: number;
  /** A meter with tokens had no price: `usd` is then only what is known, and callers must not treat it as the cost. */
  unknown: boolean;
}

/** The rates that apply to a request: the long-context band if the prompt is long enough, then the tier. `undefined` when the tier is not priced. */
export function ratesFor(price: ModelPrice, tier: string | undefined, promptTokens: number): Rates | undefined {
  const by = price.long_context !== undefined && promptTokens > price.long_context.above_tokens ? price.long_context.rates : price.rates;
  const name = tier === undefined || tier === "default" || tier === "auto" ? "standard" : tier;
  return by?.[name];
}

/** Dollars for `tokens` written to caches, given the meter's rate (one number, or one per lifetime). `undefined` if a needed rate is missing. */
function cacheWriteUsd(tokens: Tokens, rate: Rates["cache_write"]): number | undefined {
  const total = tokens.cache_write_tokens ?? 0;
  if (total === 0) return 0;
  if (rate === undefined) return undefined;
  if (typeof rate === "number") return (total * rate) / 1_000_000;
  const windows = Object.keys(rate).sort((a, b) => Number(a) - Number(b));
  const shortest = windows[0];
  if (shortest === undefined) return undefined;
  let usd = 0;
  let known = 0;
  for (const [w, n] of Object.entries(tokens.cache_write_by_minutes ?? {})) {
    if (n === 0) continue;
    const per = rate[w];
    if (per === undefined) return undefined; // a lifetime the table does not price
    usd += (n * per) / 1_000_000;
    known += n;
  }
  const rest = Math.max(0, total - known);
  return usd + (rest * (rate[shortest] as number)) / 1_000_000;
}

export function costOf(tokens: Tokens, price: ModelPrice | undefined, tier?: string): Priced {
  if (price?.free === true) return { usd: 0, unknown: false };
  if (price === undefined) return { usd: 0, unknown: true };
  const read = tokens.cache_read_tokens ?? 0;
  const write = tokens.cache_write_tokens ?? 0;
  const r = ratesFor(price, tier, tokens.input_tokens + read + write);
  if (r === undefined) return { usd: 0, unknown: true };
  let usd = 0;
  let unknown = false;
  for (const [n, per] of [[tokens.input_tokens, r.input], [tokens.output_tokens, r.output], [read, r.cache_read]] as const) {
    if (n === 0) continue;
    if (per === undefined) unknown = true;
    else usd += (n * per) / 1_000_000;
  }
  const w = cacheWriteUsd(tokens, r.cache_write);
  if (w === undefined) unknown = true;
  else usd += w;
  return { usd, unknown };
}
