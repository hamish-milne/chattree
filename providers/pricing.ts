import { createHash } from "node:crypto";
import { Type, type Static, type StaticDecode } from "typebox";
import { stable } from "../harness/setup.ts";
import { parser, pattern, record, strictObject } from "../src/validate.ts";

/**
 * Prices (docs/providers.md, P9). A price table is plain data: per model, dollars per million tokens for each meter
 * (input, output, cache read, cache write; reasoning is billed as output and already counted there) for each
 * service tier, and an optional long-context band. Tables are pinned by hash in the agent's setup so that the cost
 * of history never changes under it. An unknown price is unknown, never zero: a local server says `free: true`.
 */

const rate = Type.Number({ minimum: 0 });
const nonEmpty = Type.String({ minLength: 1 });
const opt = Type.Optional;
/** A cache lifetime in minutes, as a key (`"30"`, `"720"`). */
const minutes = pattern(/^[1-9]\d*$/, "a whole number of minutes");

/** Dollars per million tokens for each meter of one service tier. A meter that is absent is unknown. */
const rates = strictObject({
  input: opt(rate),
  output: opt(rate),
  cache_read: opt(rate),
  /**
   * A single rate, or one rate per cache lifetime keyed by minutes (`{ 30: 12.5, 720: 25 }`): writing to a cache
   * that lasts longer costs more. Tokens whose lifetime the usage does not say are priced at the lifetime the request
   * asked for (the `cache_ttl` setting), or at the shortest one if it asked for none.
   */
  cache_write: opt(Type.Union([rate, record(minutes, rate)])),
});
export type Rates = Static<typeof rates>;

/** Rates by service tier, named as the provider's `service_tier` setting names them. Use `standard` when there is only one. */
const ratesByTier = record(nonEmpty, rates);
export type RatesByTier = Static<typeof ratesByTier>;

export const modelPrice = strictObject({
  /** Explicitly free (a local server). Overrides everything else. */
  free: opt(Type.Literal(true)),
  /** By tier. `standard` is the default; `default` and `auto` in a request's settings mean `standard`. */
  rates: opt(ratesByTier),
  /** Requests whose prompt (input, cache read and write together) is longer than `above_tokens` use these rates instead. */
  long_context: opt(strictObject({ above_tokens: Type.Integer({ minimum: 1 }), rates: ratesByTier })),
});
export type ModelPrice = Static<typeof modelPrice>;

export const priceTable = parser(
  strictObject({
    version: Type.Literal(1),
    /** When these prices were read, `YYYY-MM-DD`. */
    as_of: Type.String({ pattern: String.raw`^\d{4}-\d{2}-\d{2}$` }),
    /** Where they came from (a URL, or "override"). */
    source: nonEmpty,
    currency: Type.Literal("USD"),
    models: record(Type.String(), modelPrice),
  }),
);
export type PriceTable = StaticDecode<typeof priceTable.schema>;

export const emptyTable = (): PriceTable => ({ version: 1, as_of: "1970-01-01", source: "none", currency: "USD", models: {} });

/** Canonical bytes of a table: sorted-key JSON. Its SHA-256 is the table's hash, and the blob's hash when it is stored. */
export const tableBytes = (t: PriceTable): Uint8Array => new TextEncoder().encode(stable(t));
export const tableHash = (t: PriceTable): string => createHash("sha256").update(tableBytes(t)).digest("hex");

export function parseTable(bytes: Uint8Array): PriceTable | undefined {
  try {
    const r = priceTable.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return r.ok ? r.value : undefined;
  } catch {
    return undefined;
  }
}

/** Overrides in a provider's config: replace single models (or all of them, `free`). Merged over the bundled table. */
export const pricingConfig = strictObject({
  /** Every model of this provider is free (a local server). */
  free: opt(Type.Boolean()),
  models: opt(record(Type.String(), modelPrice)),
});
export type PricingConfig = Static<typeof pricingConfig>;

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
  for (const key of Object.keys(table.models))
    if (key !== "*" && id.startsWith(key) && DATED.test(id.slice(key.length)) && (best === undefined || key.length > best.length))
      best = key;
  return best === undefined ? table.models["*"] : table.models[best];
}

/** A cache lifetime as the providers write it (`5m`, `30m`, `1h`, `12h`) in minutes; `undefined` if it is not of that form. */
export function ttlMinutes(ttl: string): number | undefined {
  const m = /^([1-9]\d*)([mh])$/.exec(ttl);
  return m === null ? undefined : Number(m[1]) * (m[2] === "h" ? 60 : 1);
}

export interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | undefined;
  /** All tokens written to a cache. */
  cache_write_tokens?: number | undefined;
  /** Of those, how many went to a cache of each lifetime (keyed by minutes). */
  cache_write_by_minutes?: Record<string, number> | undefined;
  /** The lifetime the request asked for (its `cache_ttl` setting): what writes with no stated lifetime are priced at. Unset: the shortest, which is each provider's default. */
  default_cache_minutes?: number | undefined;
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

/** The rate for writes at a lifetime (one number ignores it; a map needs the lifetime, or the shortest if none is asked for). */
export function cacheWriteRate(writeRate: Rates["cache_write"], lifetime?: number): number | undefined {
  if (writeRate === undefined || typeof writeRate === "number") return writeRate;
  const shortest = Object.keys(writeRate).sort((a, b) => Number(a) - Number(b))[0];
  const key = lifetime === undefined ? shortest : String(lifetime);
  return key === undefined ? undefined : writeRate[key];
}

/** Dollars for `tokens` written to caches, given the meter's rate (one number, or one per lifetime). `undefined` if a needed rate is missing. */
function cacheWriteUsd(tokens: Tokens, writeRate: Rates["cache_write"]): number | undefined {
  const total = tokens.cache_write_tokens ?? 0;
  if (total === 0) return 0;
  if (writeRate === undefined) return undefined;
  if (typeof writeRate === "number") return (total * writeRate) / 1_000_000;
  let usd = 0;
  let known = 0;
  for (const [w, n] of Object.entries(tokens.cache_write_by_minutes ?? {})) {
    if (n === 0) continue;
    const per = writeRate[w];
    if (per === undefined) return undefined; // a lifetime the table does not price
    usd += (n * per) / 1_000_000;
    known += n;
  }
  const rest = Math.max(0, total - known);
  if (rest === 0) return usd;
  const per = cacheWriteRate(writeRate, tokens.default_cache_minutes);
  return per === undefined ? undefined : usd + (rest * per) / 1_000_000;
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
  for (const [n, per] of [
    [tokens.input_tokens, r.input],
    [tokens.output_tokens, r.output],
    [read, r.cache_read],
  ] as const) {
    if (n === 0) continue;
    if (per === undefined) unknown = true;
    else usd += (n * per) / 1_000_000;
  }
  const w = cacheWriteUsd(tokens, r.cache_write);
  if (w === undefined) unknown = true;
  else usd += w;
  return { usd, unknown };
}
