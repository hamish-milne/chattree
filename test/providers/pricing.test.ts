import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANTHROPIC_PRICES, OPENAI_PRICES } from "../../providers/pricing-data.ts";
import { cacheWriteRate, costOf, effectiveTable, emptyTable, findModel, parseTable, priceTable, tableBytes, tableHash, ttlMinutes, type PriceTable } from "../../providers/pricing.ts";

const table = (models: PriceTable["models"]): PriceTable => ({ ...emptyTable(), as_of: "2026-10-25", source: "test", models });
const M = 1_000_000;

describe("costOf", () => {
  const price = {
    rates: { standard: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }, flex: { input: 1, output: 5 } },
    long_context: { above_tokens: 100_000, rates: { standard: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } } },
  };

  test("every meter, in dollars per million tokens", () => {
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M / 2, cache_read_tokens: M, cache_write_tokens: M }, { rates: price.rates }), { usd: 2 + 5 + 0.2 + 2.5, unknown: false });
    assert.deepEqual(costOf({ input_tokens: 0, output_tokens: 0 }, price), { usd: 0, unknown: false });
  });

  test("a meter with tokens but no price makes the cost unknown, not cheaper", () => {
    const c = costOf({ input_tokens: M, output_tokens: 0, cache_read_tokens: 5 }, { rates: { standard: { input: 2, output: 10 } } });
    assert.equal(c.unknown, true);
    assert.equal(costOf({ input_tokens: M, output_tokens: 0, cache_read_tokens: 0 }, { rates: { standard: { input: 2 } } }).unknown, false, "meters with no tokens need no price");
    assert.deepEqual(costOf({ input_tokens: 1, output_tokens: 1 }, undefined), { usd: 0, unknown: true });
  });

  test("free is explicit zero", () => {
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M }, { free: true }), { usd: 0, unknown: false });
  });

  test("tiers: standard (also named default or auto) is the base, a named tier its own, an unlisted one is unknown", () => {
    const t = { input_tokens: 50_000, output_tokens: 50_000 };
    for (const tier of [undefined, "standard", "default", "auto"]) assert.equal(costOf(t, price, tier).usd, 0.6);
    assert.equal(costOf(t, price, "flex").usd, 0.3);
    assert.equal(costOf(t, price, "priority").unknown, true);
    assert.equal(costOf(t, { rates: { flex: { input: 1, output: 1 } } }).unknown, true, "no standard tier, none asked for: unknown rather than a guess");
  });

  test("the long-context band counts the whole prompt: input, cache read and write; a tier missing from the band is unknown", () => {
    assert.equal(costOf({ input_tokens: 100_000, output_tokens: 0 }, price).usd, 0.2, "at the threshold is not above it");
    assert.equal(costOf({ input_tokens: 100_001, output_tokens: 0 }, price).usd, (100_001 * 4) / M);
    assert.equal(costOf({ input_tokens: 10, output_tokens: 0, cache_read_tokens: 100_000 }, price).usd, (10 * 4 + 100_000 * 0.4) / M);
    assert.equal(costOf({ input_tokens: 100_001, output_tokens: 0 }, price, "flex").unknown, true);
  });

  test("cache writes by lifetime: each window at its own rate; the rest at the shortest; an unpriced window is unknown", () => {
    const p = { rates: { standard: { input: 1, output: 1, cache_write: { 30: 12.5, 720: 25 } } } };
    const w = (total: number, by?: Record<string, number>) => costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: total, ...(by === undefined ? {} : { cache_write_by_minutes: by }) }, p);
    assert.equal(w(M, { "30": M }).usd, 12.5);
    assert.equal(w(M, { "720": M }).usd, 25);
    assert.equal(w(2 * M, { "30": M, "720": M }).usd, 37.5);
    assert.equal(w(M).usd, 12.5, "no breakdown and none asked for: the shortest lifetime, which is the default");
    const asked = (total: number, minutes: number, by?: Record<string, number>) => costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: total, default_cache_minutes: minutes, ...(by === undefined ? {} : { cache_write_by_minutes: by }) }, p);
    assert.equal(asked(M, 720).usd, 25, "no breakdown: the lifetime the request asked for");
    assert.equal(asked(2 * M, 720, { "30": M }).usd, 12.5 + 25, "what the breakdown leaves out is the requested lifetime");
    assert.equal(asked(M, 60).unknown, true, "a requested lifetime the table does not price");
    assert.equal(w(2 * M, { "720": M }).usd, 25 + 12.5, "the part the breakdown does not cover is the default lifetime");
    assert.equal(w(M, { "60": M }).unknown, true, "a lifetime the table does not price");
    assert.equal(w(0).usd, 0);
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: M }, { rates: { standard: { input: 1 } } }).unknown, true);
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: M, cache_write_by_minutes: { "30": M } }, { rates: { standard: { cache_write: 3 } } }).usd, 3, "a single rate ignores the lifetime");
  });
});

test("lifetimes as the providers write them", () => {
  assert.deepEqual(["5m", "30m", "1h", "12h", "24h"].map(ttlMinutes), [5, 30, 60, 720, 1440]);
  for (const bad of ["", "m", "0m", "1d", "1.5h", "30"]) assert.equal(ttlMinutes(bad), undefined, bad);
  assert.equal(cacheWriteRate({ 30: 1, 720: 2 }, 720), 2);
  assert.equal(cacheWriteRate({ 30: 1, 720: 2 }), 1);
  assert.equal(cacheWriteRate(3, 720), 3);
  assert.equal(cacheWriteRate({ 30: 1 }, 5), undefined);
  assert.equal(cacheWriteRate(undefined), undefined);
});

describe("tables", () => {
  test("a dated id finds the entry it extends; the longest wins; * is the fallback; near misses do not match", () => {
    const t = table({ "gpt-5": { free: true }, "gpt-5.4": { rates: { standard: { input: 1 } } }, "*": { rates: { standard: { input: 9 } } } });
    assert.equal(findModel(t, "gpt-5.4-2026-03-05")?.rates?.["standard"]?.input, 1);
    assert.equal(findModel(t, "gpt-5-20260301")?.free, true);
    assert.equal(findModel(t, "gpt-5.4-mini")?.rates?.["standard"]?.input, 9, "-mini is another model, not a dated one");
    assert.equal(findModel(table({}), "x"), undefined);
  });

  test("overrides replace a model whole; free covers everything not listed", () => {
    const base = table({ a: { rates: { standard: { input: 1, output: 2 } } }, b: { rates: { standard: { input: 3 } } } });
    const e = effectiveTable(base, { models: { a: { rates: { standard: { input: 5 } } } } });
    assert.deepEqual(e.models["a"], { rates: { standard: { input: 5 } } });
    assert.equal(e.models["b"], base.models["b"]);
    assert.match(e.source, /overrides/);
    const free = effectiveTable(base, { free: true });
    assert.equal(findModel(free, "anything")?.free, true);
    assert.equal(findModel(free, "a")?.rates?.["standard"]?.input, 1, "a listed model keeps its price");
    assert.equal(effectiveTable(base, undefined), base);
    assert.deepEqual(effectiveTable(undefined, undefined).models, {});
  });

  test("the hash is of canonical bytes: key order does not matter, content does", () => {
    const a = table({ x: { rates: { standard: { input: 1, output: 2 } } }, y: { free: true } });
    const b = { ...a, models: { y: { free: true as const }, x: { rates: { standard: { output: 2, input: 1 } } } } };
    assert.equal(tableHash(a), tableHash(b));
    assert.notEqual(tableHash(a), tableHash(table({ x: { rates: { standard: { input: 1, output: 3 } } }, y: { free: true } })));
    assert.match(tableHash(a), /^[0-9a-f]{64}$/);
    assert.deepEqual(parseTable(tableBytes(a)), a);
  });

  test("cache lifetimes must be whole minutes", () => {
    const t = (cache_write: unknown) => priceTable.safeParse({ ...emptyTable(), models: { m: { rates: { standard: { cache_write } } } } }).success;
    assert.equal(t({ 30: 1, 720: 2 }), true);
    assert.equal(t(1), true);
    assert.equal(t({ "0": 1 }), false);
    assert.equal(t({ half: 1 }), false);
    assert.equal(t({ 30: -1 }), false);
  });

  test("a malformed table is refused", () => {
    assert.equal(parseTable(new TextEncoder().encode("{")), undefined);
    assert.equal(parseTable(new TextEncoder().encode(JSON.stringify({ version: 1 }))), undefined);
    assert.equal(priceTable.safeParse({ ...emptyTable(), models: { m: { rates: { standard: { input: -1 } } } } }).success, false);
    assert.equal(priceTable.safeParse({ ...emptyTable(), models: { m: { rates: { standard: { inptu: 1 } } } } }).success, false);
  });

  test("the bundled tables are well formed and say where they came from", () => {
    for (const t of [ANTHROPIC_PRICES, OPENAI_PRICES]) {
      assert.ok(priceTable.safeParse(t).success);
      assert.match(t.source, /^https:\/\//);
      assert.ok(Object.keys(t.models).length > 0);
    }
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M, cache_read_tokens: M }, findModel(OPENAI_PRICES, "gpt-6-luna")), { usd: 0.1 + 0.5 + 0.01, unknown: false });
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: M, cache_write_by_minutes: { "60": M } }, findModel(ANTHROPIC_PRICES, "claude-sonnet-5-5")).usd, 4);
    assert.equal(costOf({ input_tokens: 0, output_tokens: 0, cache_write_tokens: M }, findModel(ANTHROPIC_PRICES, "claude-sonnet-5-5")).usd, 2.5, "the default lifetime is the 5-minute one");
    assert.equal(costOf({ input_tokens: M, output_tokens: 0 }, findModel(OPENAI_PRICES, "gpt-6-luna"), "ultrafast").unknown, true, "gpt-6-luna has no ultrafast price");
    const w12 = { input_tokens: 0, output_tokens: 0, cache_write_tokens: M, cache_write_by_minutes: { "720": M } };
    assert.equal(costOf(w12, findModel(OPENAI_PRICES, "gpt-6-astra")).usd, 25);
    assert.equal(costOf(w12, findModel(OPENAI_PRICES, "gpt-6-astra"), "fast").usd, 50);
    assert.equal(costOf({ input_tokens: M, output_tokens: M }, findModel(OPENAI_PRICES, "gpt-5.3-codex")).usd, 1.75 + 14);
    for (const [model, price] of Object.entries(OPENAI_PRICES.models)) for (const [tier, r] of Object.entries(price.rates ?? {})) {
      const w = r.cache_write;
      if (typeof w === "object" && r.input !== undefined) assert.deepEqual([w[30] === r.input * 1.25, w[720] === r.input * 2.5], [true, true], `${model} ${tier}: writes are 1.25x and 2.5x input`);
    }
  });
});
