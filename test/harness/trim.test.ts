import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContext, type ModelContext } from "../../harness/context-builder.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { atTurnStart, summaryRange } from "../../harness/compaction.ts";
import { planTrim, trimRules } from "../../harness/trim.ts";

let n = 0;
const id = (): string => `01ARZ3NDEKTSV4RRFFQ69G${String(++n).padStart(4, "0")}`.slice(0, 26).padEnd(26, "0");
const idOf = (e: ChatEntry): string => (e as { id: string }).id;
const user = (text: string): ChatEntry => ({ $tag: "user", id: id(), content: [{ $tag: "text", text }] });
type Blocks = Extract<ChatEntry, { $tag: "assistant" }>["blocks"];
const say = (blocks: Blocks | string): ChatEntry => ({ $tag: "assistant", id: id(), provider: "anthropic", model: "sonnet", stop_reason: "end_turn", blocks: typeof blocks === "string" ? [{ $tag: "text", text: blocks }] : blocks });
const call = (call_id: string, args: Record<string, unknown> = { path: "a.txt", content: "x".repeat(3000) }): Blocks[number] => ({ $tag: "tool_call", call_id, name: "write", args, args_raw: JSON.stringify(args) });
const think = (): Blocks[number] => ({ $tag: "reasoning", provider: "anthropic", payload: { signature: "S" }, visible: "a long thought ".repeat(50) });
const result = (call_id: string, content: string): ChatEntry => ({ $tag: "tool_result", id: id(), call_id, is_error: false, content });
const trim = (upto: ChatEntry, rule: Extract<ChatEntry, { $tag: "trim" }>["rule"]): ChatEntry => ({ $tag: "trim", id: id(), upto: idOf(upto), rule, by: "user" });
const build = (entries: ChatEntry[]): Promise<ModelContext> => buildContext(entries, { system: "s", target: { provider: "anthropic", model: "sonnet" } });
const flat = (c: ModelContext): string => JSON.stringify(c.turns);

const big = "output line\n".repeat(400);
const history = (): ChatEntry[] => {
  const [u1, a1, r1, u2, a2] = [user("first question"), say([think(), { $tag: "text", text: "I will write it" }, call("c1")]), result("c1", big), user("second question"), say("the answer")];
  return [u1, a1, r1, u2, a2];
};

describe("trim", () => {
  test("it leaves out big output, big arguments and reasoning before `upto`, and nothing the user or the model said", async () => {
    const h = history();
    const c = await build([...h, trim(h[3] as ChatEntry, { tool_results: 1024, tool_args: 1024, reasoning: true }), user("third")]);
    const s = flat(c);
    assert.ok(!s.includes("output line"), "the output is gone");
    assert.match(s, /of output of this call were left out/);
    assert.ok(!s.includes("xxxxxxxx"), "the long argument is gone");
    assert.match(s, /left out to save context/);
    assert.ok(!s.includes("a long thought"), "the reasoning is gone");
    for (const kept of ["first question", "I will write it", "second question", "the answer", '"path":"a.txt"']) assert.ok(s.includes(kept), kept);
    assert.ok(!s.includes("args_raw"), "the raw argument string would show the text again");
  });

  test("entries after `upto` stay whole, and a part the rule does not name stays whole", async () => {
    const h = history();
    const later = [result("c2", big)];
    const c = await build([h[0] as ChatEntry, say([call("c2")]), ...later, trim(later[0] as ChatEntry, { reasoning: true }), user("next")]);
    assert.ok(flat(c).includes("output line"), "tool_results was not named");
    const after = await build([h[0] as ChatEntry, say([call("c3")]), trim(h[0] as ChatEntry, { tool_results: 10 }), result("c3", big)]);
    assert.ok(after.turns.length > 0 && flat(after).includes("output line"), "a result after the trim is shown whole");
  });

  test("small output under the size stays; trims add up with the smaller size and any reasoning", () => {
    const h = history();
    const t1 = trim(h[2] as ChatEntry, { tool_results: 100000 });
    const t2 = trim(h[4] as ChatEntry, { tool_results: 1000, reasoning: true });
    const rules = trimRules([...h, t1, t2]);
    assert.deepEqual(rules[2], { tool_results: 1000, reasoning: true });
    assert.deepEqual(rules[3], { tool_results: 1000, reasoning: true });
    assert.equal(rules[5], undefined, "a trim covers entries before it, not itself");
  });

  test("a trim naming an unknown entry, or one after it, does nothing", async () => {
    const h = history();
    const ghost: ChatEntry = { $tag: "trim", id: id(), upto: "01ARZ3NDEKTSV4RRFFQ69GGHOST", rule: { tool_results: 0 }, by: "user" };
    assert.ok(flat(await build([...h, ghost])).includes("output line"));
    const early = trim(h[0] as ChatEntry, { tool_results: 0 });
    const t2: ChatEntry = { ...early, upto: idOf(h[4] as ChatEntry) } as ChatEntry;
    assert.ok(flat(await build([t2, ...h])).includes("output line"), "its upto comes after it");
  });
});

describe("planTrim", () => {
  test("ends before the last entries kept whole, counts what is saved, and does not count it twice", () => {
    const h = history();
    const rule = { tool_results: 1024, tool_args: 1024, reasoning: true };
    const plan = planTrim(h, 2, rule);
    assert.ok(plan !== undefined && plan.upto === idOf(h[2] as ChatEntry), "the last two entries (a user message and a reply) are kept");
    assert.ok(plan.bytes > 4000);
    assert.equal(planTrim([...h, trim(h[2] as ChatEntry, rule)], 2, rule), undefined, "already trimmed");
    assert.equal(planTrim(h, 100, rule), undefined, "everything is recent");
  });

  test("a smaller output than the size is not worth a trim", () => {
    const h = [user("q"), say([call("c1", { x: 1 })]), result("c1", "short"), user("q2"), say("a")];
    assert.equal(planTrim(h, 1, { tool_results: 1024, tool_args: 1024 }), undefined);
  });
});

describe("summaryRange", () => {
  test("stops before the last entries kept and before the open turn, and starts at the first entry or an earlier summary", () => {
    const h = history(); // user, assistant+call, result, user, assistant
    const r = summaryRange([...h, user("third")], 2);
    assert.deepEqual(r && [r.from, r.to], [idOf(h[0] as ChatEntry), idOf(h[3] as ChatEntry)]);
    assert.equal(summaryRange(h, 100), undefined, "everything is recent");
    assert.equal(summaryRange([user("a"), say("b")], 0), undefined, "an open turn is never summarised");
  });

  test("never ends between a call and its result", () => {
    const [u, a, r2, u2] = [user("q"), say([call("c1")]), result("c1", "out"), user("q2")];
    const range = summaryRange([u, a, r2, say("done"), u2, say("x")], 3);
    assert.ok(range === undefined || range.to !== idOf(a), "the call is not the last of the range");
  });

  test("a turn starts when the last content entry is a user message, not in a tool loop", () => {
    const h = history();
    assert.equal(atTurnStart([...h, user("next")]), true);
    assert.equal(atTurnStart(h), false);
    assert.equal(atTurnStart([user("q"), say([call("c1")]), result("c1", "o")]), false);
  });
});

describe("summaryRange with earlier summaries", () => {
  const [u1, a1, u2, a2] = [user("q1"), say("r1"), user("q2"), say("r2")];
  const comp1: ChatEntry = { $tag: "compaction", id: id(), replaces: { from: idOf(u1), to: idOf(a1) }, summary: "S1 ".repeat(20) };
  const [u3, a3, u4, a4, u5] = [user("q3"), say("r3"), user("q4"), say("r4"), user("q5")];
  const all = [u1, a1, u2, a2, comp1, u3, a3, u4, a4, u5];

  test("while the summaries fit the budget, the new one covers only what came after them", () => {
    const r = summaryRange(all, 2, 10_000);
    assert.deepEqual(r && [r.from, r.to, r.merges], [idOf(u2), idOf(u4), false]);
  });

  test("beyond the budget it takes the earlier summaries in and covers everything", () => {
    const r = summaryRange(all, 2, 10);
    assert.deepEqual(r && [r.from, r.to, r.merges], [idOf(comp1), idOf(u4), true]);
    assert.equal(summaryRange(all, 2)?.merges, false, "no budget given: they stay");
  });

  test("with nothing but the summary before the kept entries there is nothing to do", () => {
    assert.equal(summaryRange([u1, a1, comp1, u2], 1, 10_000), undefined);
  });


  test("the text a summary is written from starts at its range, without the summaries above it", async () => {
    const whole = flat(await build(all));
    const part = flat(await buildContext(all, { system: "s", target: { provider: "anthropic", model: "sonnet" }, from: idOf(u2), upTo: idOf(u4) }));
    assert.ok(whole.includes("S1 S1") && !part.includes("S1 S1"));
    assert.ok(part.includes("q2") && part.includes("q4") && !part.includes("q5"));
  });
});
