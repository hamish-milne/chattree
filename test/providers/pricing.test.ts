import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANTHROPIC_PRICES, OPENAI_PRICES } from "../../providers/pricing-data.ts";
import { costOf, effectiveTable, emptyTable, findModel, parseTable, priceTable, tableBytes, tableHash, type PriceTable } from "../../providers/pricing.ts";

const table = (models: PriceTable["models"]): PriceTable => ({ ...emptyTable(), as_of: "2026-10-25", source: "test", models });
const M = 1_000_000;

describe("costOf", () => {
  const price = { rates: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }, tiers: { flex: { input: 1, output: 5 } }, long_context: { above_tokens: 100_000, rates: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } } };

  test("every meter, in dollars per million tokens", () => {
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M / 2, cache_read_tokens: M, cache_write_tokens: M }, { rates: price.rates }), { usd: 2 + 5 + 0.2 + 2.5, unknown: false });
    assert.deepEqual(costOf({ input_tokens: 0, output_tokens: 0 }, price), { usd: 0, unknown: false });
  });

  test("a meter with tokens but no price makes the cost unknown, not cheaper", () => {
    const c = costOf({ input_tokens: M, output_tokens: 0, cache_read_tokens: 5 }, { rates: { input: 2, output: 10 } });
    assert.equal(c.unknown, true);
    assert.equal(costOf({ input_tokens: M, output_tokens: 0, cache_read_tokens: 0 }, { rates: { input: 2 } }).unknown, false, "meters with no tokens need no price");
    assert.deepEqual(costOf({ input_tokens: 1, output_tokens: 1 }, undefined), { usd: 0, unknown: true });
  });

  test("free is explicit zero", () => {
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M }, { free: true }), { usd: 0, unknown: false });
  });

  test("tiers: standard names use the base rates, a named tier its own, an unlisted one is unknown", () => {
    const t = { input_tokens: 50_000, output_tokens: 50_000 };
    for (const tier of [undefined, "standard", "default", "auto"]) assert.equal(costOf(t, price, tier).usd, 0.6);
    assert.equal(costOf(t, price, "flex").usd, 0.3);
    assert.equal(costOf(t, price, "priority").unknown, true);
  });

  test("the long-context band counts the whole prompt: input, cache read and write", () => {
    assert.equal(costOf({ input_tokens: 100_000, output_tokens: 0 }, price).usd, 0.2, "at the threshold is not above it");
    assert.equal(costOf({ input_tokens: 100_001, output_tokens: 0 }, price).usd, (100_001 * 4) / M);
    assert.equal(costOf({ input_tokens: 10, output_tokens: 0, cache_read_tokens: 100_000 }, price).usd, (10 * 4 + 100_000 * 0.4) / M);
  });
});

describe("tables", () => {
  test("a dated id finds the entry it extends; the longest wins; * is the fallback; near misses do not match", () => {
    const t = table({ "gpt-5": { free: true }, "gpt-5.4": { rates: { input: 1 } }, "*": { rates: { input: 9 } } });
    assert.equal(findModel(t, "gpt-5.4-2026-03-05")?.rates?.input, 1);
    assert.equal(findModel(t, "gpt-5-20260301")?.free, true);
    assert.equal(findModel(t, "gpt-5.4-mini")?.rates?.input, 9, "-mini is another model, not a dated one");
    assert.equal(findModel(table({}), "x"), undefined);
  });

  test("overrides replace a model whole; free covers everything not listed", () => {
    const base = table({ a: { rates: { input: 1, output: 2 } }, b: { rates: { input: 3 } } });
    const e = effectiveTable(base, { models: { a: { rates: { input: 5 } } } });
    assert.deepEqual(e.models["a"], { rates: { input: 5 } });
    assert.equal(e.models["b"], base.models["b"]);
    assert.match(e.source, /overrides/);
    const free = effectiveTable(base, { free: true });
    assert.equal(findModel(free, "anything")?.free, true);
    assert.equal(findModel(free, "a")?.rates?.input, 1, "a listed model keeps its price");
    assert.equal(effectiveTable(base, undefined), base);
    assert.deepEqual(effectiveTable(undefined, undefined).models, {});
  });

  test("the hash is of canonical bytes: key order does not matter, content does", () => {
    const a = table({ x: { rates: { input: 1, output: 2 } }, y: { free: true } });
    const b = { ...a, models: { y: { free: true as const }, x: { rates: { output: 2, input: 1 } } } };
    assert.equal(tableHash(a), tableHash(b));
    assert.notEqual(tableHash(a), tableHash(table({ x: { rates: { input: 1, output: 3 } }, y: { free: true } })));
    assert.match(tableHash(a), /^[0-9a-f]{64}$/);
    assert.deepEqual(parseTable(tableBytes(a)), a);
  });

  test("a malformed table is refused", () => {
    assert.equal(parseTable(new TextEncoder().encode("{")), undefined);
    assert.equal(parseTable(new TextEncoder().encode(JSON.stringify({ version: 1 }))), undefined);
    assert.equal(priceTable.safeParse({ ...emptyTable(), models: { m: { rates: { input: -1 } } } }).success, false);
    assert.equal(priceTable.safeParse({ ...emptyTable(), models: { m: { rates: { inptu: 1 } } } }).success, false);
  });

  test("the bundled tables are well formed and say where they came from", () => {
    for (const t of [ANTHROPIC_PRICES, OPENAI_PRICES]) {
      assert.ok(priceTable.safeParse(t).success);
      assert.match(t.source, /^https:\/\//);
      assert.ok(Object.keys(t.models).length > 0);
    }
    assert.deepEqual(costOf({ input_tokens: M, output_tokens: M, cache_read_tokens: M }, findModel(OPENAI_PRICES, "gpt-6-luna")), { usd: 0.1 + 0.5 + 0.01, unknown: false });
  });
});
