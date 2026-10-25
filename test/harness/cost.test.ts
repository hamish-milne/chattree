import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { CONFIG_FILE, Conversation, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { costIncrease, estimateRequest } from "../../harness/estimate.ts";
import { computeLedger, priceResolver, tokensOf, usageRecord } from "../../harness/ledger.ts";
import { checkLimits, LimitExceeded } from "../../harness/limits.ts";
import { envSource } from "../../harness/secrets.ts";
import { ChangeNotAllowed } from "../../harness/setup.ts";
import { prepareContext } from "../../harness/request.ts";
import { defaultRegistry } from "../../providers/index.ts";
import { emptyTable, tableHash, type PriceTable } from "../../providers/pricing.ts";
import { OPENAI_PRICES } from "../../providers/pricing-data.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const M = 1_000_000;
const KEY = "sk-proj-COST-TEST-KEY";

// ---- ledger on hand-written entries ------------------------------------------------------------------------------

const cheap: PriceTable = { ...emptyTable(), as_of: "2026-10-25", source: "t", models: { m: { rates: { standard: { input: 1, output: 2, cache_read: 0.1 } } } } };
const dear: PriceTable = { ...cheap, models: { m: { rates: { standard: { input: 10, output: 20, cache_read: 1 } } } } };
const resolver = priceResolver([cheap, dear]);
let n = 0;
const id = (): string => `01J${String(++n).padStart(23, "0")}`;
const setup = (table: PriceTable | undefined, reason: "user" | "subagent" = "user"): ChatEntry => ({ $tag: "agent_setup", id: id(), reason, model: { provider: "p", id: "m" }, ...(table === undefined ? {} : { pricing: { table: tableHash(table) } }) }) as ChatEntry;
const user = (): ChatEntry => ({ $tag: "user", id: id(), content: [{ $tag: "text", text: "hi" }] }) as ChatEntry;
const reply = (usage: Record<string, number> | undefined, model = "m"): ChatEntry => ({ $tag: "assistant", id: id(), provider: "p", model, blocks: [{ $tag: "text", text: "x" }], stop_reason: "end_turn", ...(usage === undefined ? {} : { usage }) }) as ChatEntry;

describe("ledger", () => {
  test("usage is priced under the table in force at that entry, so a later pin does not reprice history", async () => {
    const l = await computeLedger([setup(cheap), user(), reply({ input_tokens: M, output_tokens: M, cache_read_tokens: M }), setup(dear), user(), reply({ input_tokens: M, output_tokens: 0 })], resolver);
    assert.equal(l.conversation.usd, 1 + 2 + 0.1 + 10);
    assert.equal(l.conversation.requests, 2);
    assert.equal(l.turn.usd, 10, "the turn is everything since the last user message");
    assert.deepEqual(Object.keys(l.byModel), ["m"]);
  });

  test("unknown is counted as unknown, never as zero: no pin, an unpinned table, an unlisted model, no usage", async () => {
    const l = await computeLedger([setup(undefined), user(), reply({ input_tokens: M, output_tokens: 1 }), setup({ ...cheap, source: "gone" }), reply({ input_tokens: M, output_tokens: 1 }), setup(cheap), reply({ input_tokens: M, output_tokens: 1 }, "other"), reply({ input_tokens: M, output_tokens: 0 })], resolver);
    assert.equal(l.conversation.requests, 4);
    assert.equal(l.conversation.unpriced, 3);
    assert.equal(l.conversation.usd, 1);
  });

  test("a turn includes tool-loop requests; interrupted usage and merged spend count; a fresh branch starts with no setup", async () => {
    const entries: ChatEntry[] = [
      setup(cheap),
      user(),
      reply({ input_tokens: M, output_tokens: 0 }),
      { $tag: "interrupted", id: id(), by: "user", partial: [], usage: { input_tokens: M, output_tokens: 0 } } as ChatEntry,
      { $tag: "subagent_result", id: id(), call_id: "c", branch: "b", tip: "t", summary: "s", files: { changed: [], added: [], discarded: [] }, spend: { usd: 0.5, requests: 3, unpriced: 1 } } as ChatEntry,
    ];
    const l = await computeLedger(entries, resolver);
    assert.deepEqual(l.turn, { usd: 2.5, requests: 5, unpriced: 1 });
    const fresh = await computeLedger([setup(cheap), user(), reply({ input_tokens: M, output_tokens: 0 }), { $tag: "branch_start", id: id(), kind: "subagent", from: { branch: "main", commit: "c" }, context: "fresh" } as ChatEntry, reply({ input_tokens: M, output_tokens: 0 })], resolver);
    assert.deepEqual([fresh.conversation.usd, fresh.conversation.unpriced], [1, 1], "the child's first reply had no setup of its own");
  });

  test("from: counts only a branch's own entries but still prices them under earlier setups", async () => {
    const entries = [setup(cheap), user(), reply({ input_tokens: M, output_tokens: 0 }), reply({ input_tokens: M, output_tokens: 0 })];
    assert.equal((await computeLedger(entries, resolver, { from: 3 })).conversation.usd, 1);
  });

  test("a stored table is only trusted if its bytes hash to the name asked for", async () => {
    const r = priceResolver([], async () => new TextEncoder().encode(JSON.stringify(dear)));
    assert.equal(await r.table(tableHash(cheap)), undefined);
    assert.ok(await r.table(tableHash(dear)));
  });
});

// ---- estimate and limits ---------------------------------------------------------------------------------------

const ctx = (text = "hello"): Parameters<typeof estimateRequest>[0] => ({ system: "sys", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text }] }], tools: [], cacheHints: [] });
const ledger = (usd = 0, requests = 0, turn = { usd: 0, requests: 0, unpriced: 0 }) => ({ conversation: { usd, requests, unpriced: 0 }, turn, byModel: {} });

describe("usage records", () => {
  test("flat names round-trip, including the per-lifetime cache writes", () => {
    const u = { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 10, reasoning_tokens: 1, cache_write_by_minutes: { "30": 4, "720": 6 } };
    const rec = usageRecord(u);
    assert.deepEqual(rec, { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 10, reasoning_tokens: 1, cache_write_tokens_30m: 4, cache_write_tokens_720m: 6 });
    assert.deepEqual(tokensOf(rec).cache_write_by_minutes, { "30": 4, "720": 6 });
    assert.equal(tokensOf(usageRecord({ input_tokens: 1, output_tokens: 1 })).cache_write_by_minutes, undefined);
  });

  test("the ledger prices a response's cache writes by lifetime", async () => {
    const t: PriceTable = { ...cheap, models: { m: { rates: { standard: { input: 1, output: 1, cache_write: { 5: 2, 60: 4 } } } } } };
    const l = await computeLedger([setup(t), user(), reply({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 2 * M, cache_write_tokens_5m: M, cache_write_tokens_60m: M })], priceResolver([t]));
    assert.equal(l.conversation.usd, 6);
  });
});

describe("cache lifetime in costs", () => {
  const t: PriceTable = { ...cheap, models: { m: { rates: { standard: { input: 1, output: 1, cache_write: { 30: 1.25, 720: 2.5 } } } } } };
  const withTtl = (ttl: string | undefined): ChatEntry => ({ $tag: "agent_setup", id: id(), reason: "user", model: { provider: "p", id: "m", settings: ttl === undefined ? { max_output_tokens: 1 } : { max_output_tokens: 1, cache_ttl: ttl } }, pricing: { table: tableHash(t) } }) as ChatEntry;
  const write = reply({ input_tokens: 0, output_tokens: 0, cache_write_tokens: M });

  test("writes with no stated lifetime are priced at the setting's lifetime, else the shortest", async () => {
    assert.equal((await computeLedger([withTtl("12h"), user(), write], priceResolver([t]))).conversation.usd, 2.5);
    assert.equal((await computeLedger([withTtl("30m"), user(), write], priceResolver([t]))).conversation.usd, 1.25);
    assert.equal((await computeLedger([withTtl(undefined), user(), write], priceResolver([t]))).conversation.usd, 1.25);
    assert.equal((await computeLedger([withTtl("1h"), user(), write], priceResolver([t]))).conversation.unpriced, 1, "a lifetime the table does not price is unknown");
  });

  test("the estimate prices the prompt at the cache-write rate when that is dearer than input", () => {
    const c = ctx("x".repeat(3000));
    const plain = estimateRequest(c, { id: "m", settings: { max_output_tokens: 0 } }, t);
    const long = estimateRequest(c, { id: "m", settings: { max_output_tokens: 0, cache_ttl: "12h" } }, t);
    assert.equal(plain.usd, (plain.inputTokens * 1.25) / M);
    assert.equal(long.usd, (long.inputTokens * 2.5) / M);
    const cheapWrite: PriceTable = { ...t, models: { m: { rates: { standard: { input: 1, output: 1, cache_write: 0.5 } } } } };
    assert.equal(estimateRequest(c, { id: "m", settings: { max_output_tokens: 0 } }, cheapWrite).usd, (plain.inputTokens * 1) / M);
  });
});

describe("estimate", () => {
  test("pessimistic: input at the plain rate, all of max output used; unknown stays unknown", () => {
    const e = estimateRequest(ctx("x".repeat(30_000)), { id: "m", settings: { max_output_tokens: 1000 } }, cheap, { context_window: 12_000 });
    assert.ok(e.inputTokens >= 10_000);
    assert.equal(e.usd, (e.inputTokens * 1 + 1000 * 2) / M);
    assert.equal(e.contextWindow, 12_000);
    assert.equal(estimateRequest(ctx(), { id: "nope", settings: { max_output_tokens: 1 } }, cheap).usd, undefined);
    assert.equal(estimateRequest(ctx(), { id: "m", settings: { max_output_tokens: 1 } }, undefined).usd, undefined);
    assert.equal(estimateRequest(ctx(), { id: "x", settings: { max_output_tokens: 1 } }, { ...cheap, models: { x: { free: true } } }).usd, 0);
  });

  test("costIncrease: says what switching does at this size, only when it matters", () => {
    const a = { price: { rates: { standard: { input: 0.1, output: 0.5 } } } };
    const b = { price: { rates: { standard: { input: 10, output: 50 } } } };
    const c = costIncrease({ tokens: 100_000, maxOutputTokens: 8000, from: a, to: b });
    assert.equal(c?.kind, "cost_increase");
    assert.match(c?.message ?? "", /about \$0\.0\d+ now and about \$\d+\.\d+ after \(\d+x\)/);
    assert.equal(costIncrease({ tokens: 100, maxOutputTokens: 1, from: a, to: b }), undefined, "under a cent");
    assert.equal(costIncrease({ tokens: 100_000, maxOutputTokens: 8000, from: b, to: a }), undefined, "cheaper");
    assert.match(costIncrease({ tokens: 1, maxOutputTokens: 1, from: a, to: { price: undefined } })?.message ?? "", /unknown/);
    assert.match(costIncrease({ tokens: 100_000, maxOutputTokens: 8000, from: { price: { free: true } }, to: b })?.message ?? "", /about \$0\.000 now/);
  });
});

describe("limits", () => {
  const est = (usd: number | undefined, extra = {}) => ({ inputTokens: 1000, maxOutputTokens: 100, usd, contextWindow: undefined, longContextAt: undefined, ...extra });

  test("each money limit is checked against what the request would bring it to", () => {
    const r = checkLimits({ limits: { max_request_usd: 0.5, max_turn_usd: 2, max_conversation_usd: 10 }, ledger: ledger(9.8, 4, { usd: 1.9, requests: 2, unpriced: 0 }), estimate: est(0.6) });
    assert.deepEqual(r.violations.map((v) => v.limit), ["max_request_usd", "max_turn_usd", "max_conversation_usd"]);
    assert.match(r.violations[0]?.message ?? "", /this request would reach \$0\.60, over the limit of \$0\.50/);
  });

  test("warn_at warns before the limit and stays quiet far from it", () => {
    const near = checkLimits({ limits: { max_conversation_usd: 10, warn_at: 0.9 }, ledger: ledger(9.5), estimate: est(0.1) });
    assert.deepEqual([near.violations.length, near.warnings.map((w) => w.kind)], [0, ["near_limit"]]);
    assert.equal(checkLimits({ limits: { max_conversation_usd: 10 }, ledger: ledger(1), estimate: est(0.1) }).warnings.length, 0);
  });

  test("requests per turn", () => {
    const l = { limits: { max_requests_per_turn: 3 }, estimate: est(0) };
    assert.equal(checkLimits({ ...l, ledger: ledger(0, 0, { usd: 0, requests: 3, unpriced: 0 }) }).violations[0]?.limit, "max_requests_per_turn");
    assert.equal(checkLimits({ ...l, ledger: ledger(0, 0, { usd: 0, requests: 1, unpriced: 0 }) }).violations.length, 0);
  });

  test("an unknown price warns by default and blocks on request; a limit with no price says it cannot be enforced", () => {
    const warn = checkLimits({ limits: { max_request_usd: 1 }, ledger: ledger(), estimate: est(undefined) });
    assert.deepEqual([warn.violations.length, warn.warnings[0]?.kind], [0, "unknown_price"]);
    assert.match(warn.warnings[0]?.message ?? "", /cannot be enforced/);
    assert.equal(checkLimits({ limits: { unknown_price: "block" }, ledger: ledger(), estimate: est(undefined) }).violations[0]?.limit, "unknown_price");
  });

  test("history without prices, the context window and the long-context cliff are warned about", () => {
    const l = { ...ledger(), conversation: { usd: 1, requests: 2, unpriced: 2 } };
    const r = checkLimits({ limits: {}, ledger: l, estimate: est(0, { inputTokens: 95_000, contextWindow: 100_000, longContextAt: 100_000 }) });
    assert.deepEqual(r.warnings.map((w) => w.kind).sort(), ["context_window", "long_context", "unpriced_history"]);
  });
});

// ---- through a conversation -----------------------------------------------------------------------------------------

const CONFIG = `providers:
  gpt:
    $tag: openai
    api_key_env: OPENAI_API_KEY
    pricing: { models: { flat-model: { rates: { standard: { input: 0.1, output: 0.5, cache_read: 0.01 } } } } }
  local:
    $tag: openai
    base_url: http://localhost:11434/v1
    pricing: { free: true }
limits:
  max_request_usd: 1
  max_conversation_usd: 5
`;
const opts = () => ({ providers: { registry: defaultRegistry(), secrets: envSource({ OPENAI_API_KEY: KEY }) } });
const MODEL = { provider: "gpt", id: "flat-model", settings: { max_output_tokens: 1000 } };
const say = (usage: Record<string, number>, model = "flat-model"): Extract<NewEntry, { $tag: "assistant" }> => ({ $tag: "assistant", provider: "gpt", model, blocks: [{ $tag: "text", text: "ok" }], stop_reason: "end_turn", usage });
const hi: NewEntry = { $tag: "user", content: [{ $tag: "text", text: "hi" }] };

async function fresh(config = CONFIG) {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, { ...opts(), config });
  await convo.setupChange({ model: MODEL });
  return { dir, convo };
}

describe("prepareContext with costs", () => {
  test("an unpinned agent is refused; pinning stores the table; then the request carries an estimate and the ledger", async () => {
    const { convo } = await fresh();
    await convo.append(hi);
    await assert.rejects(prepareContext(convo, { system: "s" }), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("pricing_changed") && /pinPricing/.test(e.message));
    await convo.pinPricing();
    const p = await prepareContext(convo, { system: "s" });
    assert.ok(p.estimate !== undefined && p.estimate.usd !== undefined && p.estimate.usd > 0);
    assert.equal(p.ledger?.conversation.usd, 0);
    assert.deepEqual(p.warnings, []);
    const pinned = (await convo.setup()).pricing?.table as string;
    assert.equal(pinned, tableHash(convo.priceTable("gpt") as PriceTable));
    assert.ok(await convo.store.get(pinned), "the table is stored as a blob");
    await assertHistoryInvariants(convo);
  });

  test("spend is derived from usage and the pinned table, and survives reopening", async () => {
    const { dir, convo } = await fresh();
    await convo.pinPricing();
    await convo.append(hi);
    await convo.appendResponse(say({ input_tokens: M, output_tokens: 100_000, cache_read_tokens: 2 * M }));
    assert.ok(Math.abs((await convo.ledger()).conversation.usd - 0.17) < 1e-9);
    const again = await Conversation.open(host, dir, opts());
    assert.ok(Math.abs((await again.ledger()).turn.usd - 0.17) < 1e-9);
    assert.equal((await prepareContext(again, { system: "s" })).ledger?.conversation.requests, 1);
  });

  test("a price change is a pricing_changed until the new table is pinned (or the host allows it)", async () => {
    const { dir, convo } = await fresh();
    await convo.pinPricing();
    await convo.append(hi);
    await writeFile(join(dir, CONFIG_FILE), CONFIG.replace("local:", "gpt2:").replace("input: 0.1, output: 0.5", "input: 0.2, output: 1"));
    const changed = await Conversation.open(host, dir, opts());
    await assert.rejects(prepareContext(changed, { system: "s" }), (e) => e instanceof ChangeNotAllowed && /not the one this agent is pinned to/.test(e.message));
    await prepareContext(changed, { system: "s", allowDrift: ["pricing_changed"] });
    await changed.pinPricing();
    await prepareContext(changed, { system: "s" });
    assert.equal(tableHash((changed.priceTable("gpt") as PriceTable)), (await changed.setup()).pricing?.table);
    // history keeps the cost it had under the table it was pinned to
    assert.ok((await changed.ledger()).conversation.requests === 0);
  });

  test("limits stop a request that would break them, with the figures", async () => {
    const { convo } = await fresh();
    await convo.pinPricing();
    await convo.append(hi);
    await convo.appendResponse(say({ input_tokens: 90 * M, output_tokens: 0 }, "flat-model")); // $9
    await assert.rejects(prepareContext(convo, { system: "s" }), (e) => e instanceof LimitExceeded && e.violations.map((v) => v.limit).join() === "max_conversation_usd" && /over the limit of \$5\.00/.test(e.message));
    await prepareContext(convo, { system: "s", cost: false });
  });

  test("an unknown model warns; a free local provider costs nothing", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: { ...MODEL, id: "mystery" } }, { allow: ["model_changed", "cache_break", "cost_increase", "capability_loss", "reasoning_dropped", "context_overflow"] });
    await convo.pinPricing();
    await convo.append(hi);
    const p = await prepareContext(convo, { system: "s" });
    assert.ok(p.warnings.some((w) => w.kind === "unknown_price" && /cannot be enforced/.test(w.message)));
    assert.equal(p.estimate?.usd, undefined);

    const { convo: local } = await fresh();
    await local.setupChange({ model: { provider: "local", id: "gemma4:12b", settings: { max_output_tokens: 512 } } }, { allow: ["model_changed", "provider_changed", "cache_break", "cost_increase", "capability_loss", "reasoning_dropped", "context_overflow"] });
    await local.pinPricing();
    await local.append(hi);
    const q = await prepareContext(local, { system: "s" });
    assert.equal(q.estimate?.usd, 0);
    assert.deepEqual(q.warnings, []);
  });

  test("without providers nothing is checked (the earlier behaviour)", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "plain"));
    await convo.setupChange({ model: { provider: "main", id: "x" } });
    const p = await prepareContext(convo, { system: "s" });
    assert.equal(p.estimate, undefined);
    assert.deepEqual(p.warnings, []);
  });
});

describe("merges and interruptions carry cost", () => {
  test("a subagent's spend is rolled up in its result, under the table it pinned; interrupted usage counts", async () => {
    const { convo } = await fresh();
    await convo.pinPricing();
    await convo.append(hi);
    await convo.appendResponse(say({ input_tokens: M, output_tokens: 0 }));
    const sub = await convo.spawnSubagent({ brief: "do it", callId: "c1" });
    const child = sub.conversation as Conversation;
    await child.setupChange({ model: MODEL });
    await child.pinPricing();
    await child.append(hi);
    await child.appendResponse(say({ input_tokens: 2 * M, output_tokens: 0 }));
    await child.appendResponse(say({ input_tokens: 0, output_tokens: M }));
    assert.ok(Math.abs((await child.ledger()).conversation.usd - (0.1 + 0.2 + 0.5)) < 1e-9, "the child's ledger includes what it inherited");
    await convo.finishSubagent(child, { callId: "c1", summary: "done" });
    const result = (await convo.readEntries()).map((e) => (e.ok ? e.value : undefined)).find((e) => e?.$tag === "subagent_result");
    assert.deepEqual((result as { spend: unknown }).spend, { usd: 0.2 + 0.5, requests: 2, unpriced: 0 });
    assert.ok(Math.abs((await convo.ledger()).conversation.usd - (0.1 + 0.7)) < 1e-9);
    await convo.interrupt({ by: "error", error: "reset", usage: { input_tokens: M, output_tokens: 0 } });
    assert.ok(Math.abs((await convo.ledger()).conversation.usd - (0.1 + 0.7 + 0.1)) < 1e-9);
    await assertHistoryInvariants(convo);
  });

  test("a fork's spend is rolled up once and only what is new on a second merge", async () => {
    const { convo } = await fresh();
    await convo.pinPricing();
    await convo.append(hi);
    const fork = (await convo.fork(undefined, { name: "side" })).conversation as Conversation;
    await fork.append(hi);
    await fork.appendResponse(say({ input_tokens: M, output_tokens: 0 }));
    await convo.mergeFork(fork, { summary: "one" });
    await fork.appendResponse(say({ input_tokens: 3 * M, output_tokens: 0 }));
    await convo.mergeFork(fork, { summary: "two" });
    const spends = (await convo.readEntries()).flatMap((e) => (e.ok && e.value.$tag === "fork_merge" ? [e.value.spend?.usd] : []));
    assert.deepEqual(spends.map((x) => Math.round((x ?? 0) * 1000) / 1000), [0.1, 0.3]);
  });

  test("without providers, merges carry no spend", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "p"));
    await convo.append(hi);
    const sub = await convo.spawnSubagent({ brief: "b", callId: "c" });
    await (sub.conversation as Conversation).append(hi);
    await convo.finishSubagent(sub.conversation as Conversation, { callId: "c", summary: "s" });
    const r = (await convo.readEntries()).map((e) => (e.ok ? e.value : undefined)).find((e) => e?.$tag === "subagent_result");
    assert.equal((r as { spend?: unknown }).spend, undefined);
  });
});

test("the bundled OpenAI prices cover the tier names the setting uses", () => {
  assert.ok(OPENAI_PRICES.models["gpt-6-luna"]?.rates?.["flex"]);
});
