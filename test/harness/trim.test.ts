import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContext, type ModelContext } from "../../harness/context-builder.ts";
import type { ChatEntry } from "../../harness/entries.ts";
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
