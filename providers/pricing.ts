import { createHash } from "node:crypto";
import { z } from "zod";
import { stable } from "../harness/setup.ts";

/**
 * Prices (docs/providers.md, P9). A price table is plain data: per model, dollars per million tokens for each meter
 * (input, output, cache read, cache write; reasoning is billed as output and already counted there), optional
 * service tiers, and an optional long-context band. Tables are pinned by hash in the agent's setup so that the cost
 * of history never changes under it. An unknown price is unknown, never zero: a local server says `free: true`.
 */

export const METERS = ["input", "output", "cache_read", "cache_write"] as const;
export type Meter = (typeof METERS)[number];

const rate = z.number().nonnegative();
const rates = z.strictObject({ input: rate.optional(), output: rate.optional(), cache_read: rate.optional(), cache_write: rate.optional() });
export type Rates = z.infer<typeof rates>;

export const modelPrice = z.strictObject({
  /** Explicitly free (a local server). Overrides everything else. */
  free: z.literal(true).optional(),
  /** Standard tier, dollars per million tokens. A meter that is absent is unknown. */
  rates: rates.optional(),
  /** Other service tiers by the name the provider's `service_tier` setting uses; each lists the meters it prices. */
  tiers: z.record(z.string(), rates).optional(),
  /** Requests whose prompt (input, cache read and write together) is longer than `above_tokens` use these rates instead. */
  long_context: z.strictObject({ above_tokens: z.number().int().positive(), rates }).optional(),
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
  cache_write_tokens?: number | undefined;
}

export interface Priced {
  usd: number;
  /** A meter with tokens had no price: `usd` is then only what is known, and callers must not treat it as the cost. */
  unknown: boolean;
}

/** The rates that apply to a request: the tier, then the long-context band. `undefined` when the tier is not in the table. */
export function ratesFor(price: ModelPrice, tier: string | undefined, promptTokens: number): Rates | undefined {
  if (price.long_context !== undefined && promptTokens > price.long_context.above_tokens) return price.long_context.rates;
  if (tier === undefined || tier === "standard" || tier === "default" || tier === "auto") return price.rates;
  return price.tiers?.[tier];
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
  for (const [meter, n] of [["input", tokens.input_tokens], ["output", tokens.output_tokens], ["cache_read", read], ["cache_write", write]] as const) {
    if (n === 0) continue;
    const per = r[meter];
    if (per === undefined) unknown = true;
    else usd += (n * per) / 1_000_000;
  }
  return { usd, unknown };
}
