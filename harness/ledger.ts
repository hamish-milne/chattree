import { costOf, findModel, parseTable, tableHash, ttlMinutes, type PriceTable, type Tokens } from "../providers/pricing.ts";
import type { ChatEntry } from "./entries.ts";
import { applyChange, emptySetup, type AgentSetup } from "./setup.ts";
import { nth } from "../src/nth.ts";

/**
 * What a conversation has cost. Derived, never stored per entry: each response's usage is
 * priced under the table pinned in the setup in force at that entry, so the answer is the same on every replay and
 * survives restarts and forks. A merged branch's spend arrives as the rollup on its `subagent_result` / `fork_merge`.
 * An unknown price is counted as unpriced and left out of `usd`; it is never treated as zero.
 */

export interface Spend {
  usd: number;
  requests: number;
  /** Requests whose price was unknown. `usd` understates the cost by their share. */
  unpriced: number;
}

export interface Ledger {
  /** Everything on this branch's history. */
  conversation: Spend;
  /** Since the last user message. */
  turn: Spend;
  byModel: Record<string, Spend>;
}

/** Finds a price table by hash: the providers' current tables, or the blob a setup pinned. */
export interface PriceResolver {
  table(hash: string): Promise<PriceTable | undefined>;
}

const zero = (): Spend => ({ usd: 0, requests: 0, unpriced: 0 });
const add = (a: Spend, b: Spend): void => {
  a.usd += b.usd;
  a.requests += b.requests;
  a.unpriced += b.unpriced;
};

const WINDOW_KEY = /^cache_write_tokens_(\d+)m$/;

/**
 * Usage as an entry stores it: flat names, with the per-lifetime cache writes as `cache_write_tokens_<minutes>m`. `tokensOf`
 * reads this shape back.
 */
export function usageRecord(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number | undefined;
  cache_write_tokens?: number | undefined;
  reasoning_tokens?: number | undefined;
  cache_write_by_minutes?: Record<string, number> | undefined;
}): Record<string, number> {
  const out: Record<string, number> = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  for (const k of ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens"] as const) if (u[k] !== undefined) out[k] = u[k];
  for (const [m, n] of Object.entries(u.cache_write_by_minutes ?? {})) out[`cache_write_tokens_${m}m`] = n;
  return out;
}

export function tokensOf(usage: Record<string, number> | undefined): Tokens {
  const by: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage ?? {})) {
    const m = WINDOW_KEY.exec(k);
    if (m !== null) by[nth(m, 1)] = v;
  }
  return {
    input_tokens: usage?.["input_tokens"] ?? 0,
    output_tokens: usage?.["output_tokens"] ?? 0,
    cache_read_tokens: usage?.["cache_read_tokens"] ?? 0,
    cache_write_tokens: usage?.["cache_write_tokens"] ?? 0,
    ...(Object.keys(by).length > 0 ? { cache_write_by_minutes: by } : {}),
  };
}

export interface LedgerOptions {
  /** Count only entries from this index on (a child's own spend after the point it diverged); setups before it still apply. */
  from?: number;
}

/**
 * Price every response on the branch. Setup changes are applied in order as the entries are walked (even those before
 * `opts.from`), so each entry is priced under the table in force when it was written. Requests whose price is unknown are
 * counted in `unpriced`, not as zero.
 */
export async function computeLedger(entries: readonly ChatEntry[], prices: PriceResolver, opts: LedgerOptions = {}): Promise<Ledger> {
  const out: Ledger = { conversation: zero(), turn: zero(), byModel: {} };
  const from = opts.from ?? 0;
  // The turn starts at the last user message from `from` on, or at `from` when there is none.
  let turnStart = from;
  for (const [i, e] of entries.entries()) if (e.$tag === "user" && i >= from) turnStart = i;
  for (const [i, s] of await entrySpends(entries, prices)) {
    if (i < from) continue;
    add(out.conversation, s.spend);
    if (i >= turnStart) add(out.turn, s.spend);
    if (s.model !== undefined) add((out.byModel[s.model] ??= zero()), s.spend);
  }
  return out;
}

/** What one entry cost, and the model it is counted under (none for a rollup). */
export interface EntrySpend {
  spend: Spend;
  model?: string | undefined;
}

/**
 * The cost of each entry that has one, by its index in `entries`: a response, a compaction or interrupted request that
 * reported usage, a merged branch's rollup. Setup changes are applied in order, so each is priced under the table in
 * force when it was written.
 */
export async function entrySpends(entries: readonly ChatEntry[], prices: PriceResolver): Promise<Map<number, EntrySpend>> {
  const out = new Map<number, EntrySpend>();
  let setup: AgentSetup = emptySetup();
  const cache = new Map<string, PriceTable | undefined>();
  const table = async (hash: string): Promise<PriceTable | undefined> => {
    if (!cache.has(hash)) cache.set(hash, await prices.table(hash));
    return cache.get(hash);
  };

  const spendOf = async (model: string, usage: Record<string, number> | undefined): Promise<Spend> => {
    const hash = setup.pricing?.table;
    const t = hash === undefined ? undefined : await table(hash);
    const settings = setup.model?.settings as { service_tier?: unknown; cache_ttl?: unknown } | undefined;
    const tier = settings?.service_tier;
    const window = typeof settings?.cache_ttl === "string" ? ttlMinutes(settings.cache_ttl) : undefined;
    const c = costOf(
      { ...tokensOf(usage), default_cache_minutes: window },
      t === undefined ? undefined : findModel(t, model),
      typeof tier === "string" ? tier : undefined,
    );
    return { usd: c.unknown ? 0 : c.usd, requests: 1, unpriced: c.unknown ? 1 : 0 };
  };

  for (const [i, e] of entries.entries()) {
    if (e.$tag === "branch_start" && e.context === "fresh") setup = emptySetup();
    else if (e.$tag === "agent_setup") setup = applyChange(setup, e);
    if (e.$tag === "assistant") out.set(i, { spend: await spendOf(e.model, e.usage), model: e.model });
    else if (e.$tag === "compaction" && e.usage !== undefined)
      out.set(i, {
        spend: await spendOf(e.model ?? setup.model?.resolved ?? setup.model?.id ?? "", e.usage),
        model: e.model ?? setup.model?.id,
      });
    else if (e.$tag === "interrupted" && e.usage !== undefined)
      out.set(i, { spend: await spendOf(setup.model?.resolved ?? setup.model?.id ?? "", e.usage), model: setup.model?.id });
    else if ((e.$tag === "subagent_result" || e.$tag === "fork_merge") && e.spend !== undefined) out.set(i, { spend: e.spend });
  }
  return out;
}

/** A resolver over the providers' current tables and, for tables pinned earlier, the blobs they were stored in. */
export function priceResolver(current: Iterable<PriceTable>, readBlob?: (hash: string) => Promise<Uint8Array | undefined>): PriceResolver {
  const known = new Map<string, PriceTable>();
  for (const t of current) known.set(tableHash(t), t);
  return {
    async table(hash) {
      const hit = known.get(hash);
      if (hit !== undefined) return hit;
      const bytes = await readBlob?.(hash);
      const parsed = bytes === undefined ? undefined : parseTable(bytes);
      // A blob is only trusted if its bytes hash to the name it was looked up by.
      if (parsed !== undefined && tableHash(parsed) === hash) known.set(hash, parsed);
      return known.get(hash);
    },
  };
}
