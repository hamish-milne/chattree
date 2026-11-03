import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { ChangeNotAllowed, Conversation, type NewEntry } from "../../harness/conversation.ts";
import { pinDefinition } from "../../harness/definitions.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { prepareContext } from "../../harness/request.ts";
import { foldSetup, pendingAppends, prefixLags } from "../../harness/setup.ts";
import { foldTip } from "../../harness/tip.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", settings: { max_output_tokens: 8000 } };
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string, blocks?: Extract<NewEntry, { $tag: "assistant" }>["blocks"]): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", blocks: blocks ?? [{ $tag: "text", text }], stop_reason: blocks === undefined ? "end_turn" : "tool_use" });
const texts = (turns: { role: string; parts?: { type: string; text?: string }[] }[]): string[] => turns.map((t) => `${t.role}:${(t.parts ?? []).map((p) => p.text ?? "").join("|")}`);

async function fresh(instructions = "v1") {
  const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
  const pin = (text: string) => pinDefinition("instructions", text, { store: "blob", blobs: convo.store });
  await convo.setupChange({ model: sonnet, instructions: await pin(instructions) });
  return { convo, pin };
}
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

describe("the prefix lags an appended change", () => {
  test("an instructions change is appended: the prefix keeps its text, the model is told where it was made", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    const entry = await convo.setupChange({ instructions: await pin("v2") }); // no flags: nothing is lost
    assert.equal(entry?.tag, "agent_setup");
    assert.equal(((await entries(convo)).at(-1) as { apply?: string }).apply, "append");
    await convo.append(user("again"));
    const { context, setup } = await prepareContext(convo, { system: "s", cost: false });
    assert.equal(context.instructions, "v1", "the cached prefix is untouched");
    assert.equal(prefixLags(setup), true);
    assert.deepEqual(texts(context.turns as never), ["user:hi", "assistant:", "user:[Your instructions were updated. From now on follow the text below, which replaces any earlier instructions]\nv2|again"]);
  });

  test("an update made while a tool call is open waits for its result", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("go"));
    await convo.append(reply("", [{ $tag: "tool_call", call_id: "c1", name: "run", args: {} }]));
    await convo.setupChange({ instructions: await pin("v2") }, { allow: ["mid_loop"] });
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "done" });
    const { context } = await prepareContext(convo, { system: "s", cost: false });
    assert.deepEqual(context.turns.map((t) => t.role), ["user", "assistant", "tool_results", "user"]);
  });

  test("a rebuild folds the change into the prefix and drops the update", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await convo.setupChange({ instructions: await pin("v2") });
    await assert.rejects(convo.rebuildPrefix(), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("cache_break"));
    assert.equal(prefixLags((await convo.setup())), true, "a refused rebuild changes nothing");
    await convo.rebuildPrefix({ allow: ["cache_break", "instructions_changed"] });
    const { context, setup } = await prepareContext(convo, { system: "s", cost: false });
    assert.equal(context.instructions, "v2");
    assert.equal(prefixLags(setup), false);
    assert.deepEqual(texts(context.turns as never), ["user:hi", "assistant:"]);
    assert.equal(await convo.rebuildPrefix(), undefined, "nothing left to fold in");
  });

  test("a change that loses the cache anyway rewrites the prefix for free", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await convo.setupChange({ instructions: await pin("v2") });
    await convo.setupChange({ model: { provider: "anthropic", id: "claude-haiku-5-5" } }, { allow: ["model_changed", "cache_break"] });
    const { context } = await prepareContext(convo, { system: "s", cost: false });
    assert.equal(context.instructions, "v2");
    assert.deepEqual(texts(context.turns as never), ["user:hi", "assistant:"]);
    // ...and one that does not, leaves it lagging
    const other = await fresh("v1");
    await other.convo.append(user("hi"));
    await other.convo.append(reply("hello"));
    await other.convo.setupChange({ instructions: await other.pin("v2") });
    await other.convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 9000 } } });
    assert.equal(prefixLags(await other.convo.setup()), true);
  });

  test("a compaction folds appended changes into the prefix", async () => {
    const { convo, pin } = await fresh("v1");
    const a = await convo.append(user("one"));
    await convo.append(reply("two"));
    const b = await convo.append(user("three"));
    await convo.setupChange({ instructions: await pin("v2") });
    await convo.append({ $tag: "compaction", replaces: { from: a.id, to: b.id }, summary: "we talked" });
    const { context, setup } = await prepareContext(convo, { system: "s", cost: false });
    assert.equal(context.instructions, "v2");
    assert.equal(prefixLags(setup), false);
    assert.ok(!JSON.stringify(context.turns).includes("were updated"));
    assert.deepEqual(pendingAppends(await entries(convo)), []);
  });

  test("a second update shows both, in order", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await convo.setupChange({ instructions: await pin("v2") });
    await convo.append(user("x"));
    await convo.append(reply("y"));
    await convo.setupChange({ instructions: await pin("v3") });
    await convo.append(user("z"));
    const { context } = await prepareContext(convo, { system: "s", cost: false });
    const flat = JSON.stringify(context.turns);
    assert.ok(flat.indexOf("v2") < flat.indexOf("v3"));
    assert.equal(context.instructions, "v1");
  });

  test("a fork inherits the lag; entries from before 2.4 (no mark) still rewrite the prefix", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await convo.setupChange({ instructions: await pin("v2") });
    const fork = await convo.fork();
    assert.equal(prefixLags((await fork.conversation?.setup()) as never), true);
    const e = (apply: object): ChatEntry => ({ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: sonnet, instructions: { hash: "a1".repeat(32), store: "blob" }, ...apply }) as ChatEntry;
    assert.equal(prefixLags(foldSetup([e({})])), false);
    assert.equal(prefixLags(foldSetup([e({ apply: "append" })])), true, "an append with nothing before it is a lag against an empty prefix");
  });
});

describe("before the first request", () => {
  test("a change goes straight into the prefix: nothing is cached, so nothing is appended", async () => {
    const { convo, pin } = await fresh("v1");
    await convo.setupChange({ instructions: await pin("v2") });
    await convo.append(user("hi"));
    const { context, setup } = await prepareContext(convo, { system: "s", cost: false });
    assert.equal(context.instructions, "v2");
    assert.equal(prefixLags(setup), false);
    assert.deepEqual(texts(context.turns as never), ["user:hi"]);
  });
});

describe("injections", () => {
  test("are shown after the results that close the turn, and again, identically, on every later request", async () => {
    const { convo } = await fresh();
    await convo.append(user("go"));
    await convo.append(reply("", [{ $tag: "tool_call", call_id: "c1", name: "run", args: {} }]));
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "done" });
    await convo.inject("usage", "80% of the budget is spent");
    const first = (await prepareContext(convo, { system: "s", cost: false })).context;
    assert.deepEqual(first.turns.map((t) => t.role), ["user", "assistant", "tool_results", "user"]);
    assert.match(JSON.stringify(first.turns.at(-1)), /\[Note from the harness\]\\n80% of the budget is spent/);
    await convo.append(reply("ok"));
    await convo.append(user("next"));
    const later = (await prepareContext(convo, { system: "s", cost: false })).context;
    assert.deepEqual(JSON.stringify(later.turns.slice(0, first.turns.length)), JSON.stringify(first.turns), "the prefix of the context does not change");
  });

  test("do not change what the thread is waiting for, and survive verification", async () => {
    const { convo } = await fresh();
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await convo.inject("nudge", "remember the style guide");
    const all = await entries(convo);
    assert.deepEqual(await foldTip({ entries: all, lease: undefined, now: 0 } as never), { kind: "awaiting_user" });
    assert.deepEqual((await verifyHistory(convo, { deep: true })).map((p) => `${p.severity}:${p.code}`), []);
  });
});
