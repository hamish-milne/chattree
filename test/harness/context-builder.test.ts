import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildContext, contextProblems, type ModelContext } from "../../harness/context-builder.ts";
import type { ChatEntry } from "../../harness/entries.ts";

let n = 0;
const id = (): string => `01ARZ3NDEKTSV4RRFFQ69G${String(++n).padStart(4, "0")}`.slice(0, 26).padEnd(26, "0");
const user = (text: string): ChatEntry => ({ $tag: "user", id: id(), content: [{ $tag: "text", text }] });
type Blocks = Extract<ChatEntry, { $tag: "assistant" }>["blocks"];
const say = (blocks: Blocks | string, over: Partial<Extract<ChatEntry, { $tag: "assistant" }>> = {}): ChatEntry => ({
  $tag: "assistant",
  id: id(),
  provider: "anthropic",
  model: "sonnet",
  stop_reason: "end_turn",
  blocks: typeof blocks === "string" ? [{ $tag: "text", text: blocks }] : blocks,
  ...over,
});
const call = (call_id: string, name = "run"): Blocks[number] => ({ $tag: "tool_call", call_id, name, args: { x: 1 } });
const result = (call_id: string, content = "ok", is_error = false): ChatEntry => ({ $tag: "tool_result", id: id(), call_id, is_error, content });
const think = (provider = "anthropic"): Blocks[number] => ({ $tag: "reasoning", provider, payload: { signature: "SIG==" }, visible: "hmm" });
const target = { provider: "anthropic", model: "sonnet" };
const build = (entries: ChatEntry[], over: Partial<Parameters<typeof buildContext>[1]> = {}) => buildContext(entries, { system: "sys", target, ...over });
const roles = (c: ModelContext): string[] => c.turns.map((t) => t.role);
const header: ChatEntry = { $tag: "header", format: "chatlog", major: 1, minor: 2 };
const setup: ChatEntry = { $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: { provider: "anthropic", id: "sonnet" } };
const ok = (c: ModelContext): ModelContext => {
  assert.deepEqual(contextProblems(c), []);
  return c;
};

describe("rendering", () => {
  test("a normal exchange; the header and setup entries are not shown", async () => {
    const c = ok(await build([header, setup, user("hi"), say([call("c1")], { stop_reason: "tool_use" }), result("c1", "done"), say("all done")], { instructions: "be brief", tools: [{ name: "run", description: "d", input_schema: {} }] }));
    assert.deepEqual(roles(c), ["user", "assistant", "tool_results", "assistant"]);
    assert.equal(c.system, "sys");
    assert.equal(c.instructions, "be brief");
    assert.equal(c.tools.length, 1);
    const t = c.turns[2];
    assert.ok(t?.role === "tool_results" && t.results[0]?.content === "done" && t.results[0].truncated === false);
    assert.deepEqual(c.turns[1], { role: "assistant", provider: "anthropic", model: "sonnet", blocks: [{ type: "tool_call", call_id: "c1", name: "run", args: { x: 1 } }] });
  });

  test("a fork's marker is invisible; a subagent's brief is its first message", async () => {
    const fork: ChatEntry = { $tag: "branch_start", id: id(), kind: "fork", from: { branch: "main", commit: "abc" }, context: "inherit" };
    assert.deepEqual(roles(ok(await build([user("a"), say("b"), fork, user("c")]))), ["user", "assistant", "user"]);
    const sub: ChatEntry = { $tag: "branch_start", id: id(), kind: "subagent", from: { branch: "main", commit: "abc" }, context: "fresh", brief: "find the bug", call_id: "c9" };
    const c = ok(await build([user("parent stuff"), say("more"), sub, setup, say("working")]));
    assert.deepEqual(c.turns[0], { role: "user", parts: [{ type: "text", text: "find the bug" }] });
    assert.equal(c.turns.length, 2, "nothing from before the marker");
  });

  test("a compaction stands for what it replaced, and merges with the user message after it", async () => {
    const [a, b, c1] = [user("old 1"), say("old 2"), user("old 3")];
    const comp: ChatEntry = { $tag: "compaction", id: id(), replaces: { from: (a as { id: string }).id, to: (c1 as { id: string }).id }, summary: "we did things" };
    const ctx = ok(await build([a, b, c1, say("recent"), comp, user("next")]));
    const flat = JSON.stringify(ctx.turns);
    assert.ok(!flat.includes("old 1") && flat.includes("we did things"));
    assert.deepEqual(roles(ctx), ["user", "assistant", "user"]);
    assert.equal((ctx.turns[0] as { parts: unknown[] }).parts.length, 1);
    assert.deepEqual(roles(ok(await build([a, b, c1, comp, user("next")]))), ["user"], "summary and next message are one user turn");
  });

  test("interrupted: text is kept, a half-received call is a note, an empty one adds nothing", async () => {
    const i1: ChatEntry = { $tag: "interrupted", id: id(), by: "user", partial: [{ $tag: "text", text: "Let me" }, { $tag: "tool_call", call_id: "c1", name: "write", args: {}, args_raw: '{"pa' }] };
    const c = ok(await build([user("go"), i1, user("sorry"), { $tag: "interrupted", id: id(), by: "error", partial: [] }]));
    assert.deepEqual(roles(c), ["user", "assistant", "user"]);
    const a = c.turns[1];
    assert.ok(a?.role === "assistant" && a.blocks.every((b) => b.type === "text") && a.blocks.length === 2);
    assert.match(JSON.stringify(a), /cut off/);
  });

  test("subagent and fork results", async () => {
    const files = { changed: ["a.md"], added: ["b.md"], discarded: ["c.md"] };
    const sr: ChatEntry = { $tag: "subagent_result", id: id(), call_id: "c1", branch: "sub/x", tip: "abc", summary: "found it", files };
    const c = ok(await build([user("go"), say([call("c1", "subagent")], { stop_reason: "tool_use" }), sr]));
    const r = c.turns[2];
    assert.ok(r?.role === "tool_results" && /found it\n\[Files: added: b.md; changed: a.md; not kept \(conflicted\): c.md\]/.test(r.results[0]?.content ?? ""));
    const orphan = ok(await build([user("go"), say("x"), sr]));
    assert.deepEqual(roles(orphan), ["user", "assistant", "user"], "no matching call: shown as text");
    assert.match(JSON.stringify(orphan.turns[2]), /subagent finished/);
    const fm: ChatEntry = { $tag: "fork_merge", id: id(), branch: "fork/x", tip: "abc", summary: "decided on B", files: { changed: [], added: [], discarded: [] }, merge: { policy: "trunk", base: "abc", conflicts: [] } };
    assert.match(JSON.stringify(ok(await build([user("a"), say("b"), fm])).turns[2]), /side conversation.*decided on B/);
  });
});

describe("reasoning", () => {
  const withThinking = [user("q"), say([think(), { $tag: "text", text: "a" }]), user("q2")];
  test("kept for the model that produced it, verbatim", async () => {
    const t = (await build(withThinking)).turns[1];
    assert.ok(t?.role === "assistant" && t.blocks[0]?.type === "reasoning" && t.blocks[0].payload?.["signature"] === "SIG==");
  });
  test("dropped for another model, another provider, or a block tagged for another provider", async () => {
    for (const tgt of [{ provider: "anthropic", model: "opus" }, { provider: "openai", model: "sonnet" }]) {
      const t = (await build(withThinking, { target: tgt })).turns[1];
      assert.ok(t?.role === "assistant" && t.blocks.length === 1 && t.blocks[0]?.type === "text");
    }
    const odd = [user("q"), say([think("openai"), { $tag: "text", text: "a" }]), user("q2")];
    assert.equal(((await build(odd)).turns[1] as { blocks: unknown[] }).blocks.length, 1);
  });
  test("a turn that was only reasoning disappears", async () => {
    const c = ok(await build([user("q"), say([think()]), user("q2")], { target: { provider: "openai", model: "x" } }));
    assert.deepEqual(roles(c), ["user"]);
  });
});

describe("pairing", () => {
  test("a call with no result gets an error result, in the same turn as any results that did arrive", async () => {
    const c = ok(await build([user("go"), say([call("a"), call("b")], { stop_reason: "tool_use" }), result("a", "fine"), user("hello?")]));
    assert.deepEqual(roles(c), ["user", "assistant", "tool_results", "user"]);
    const r = c.turns[2];
    assert.ok(r?.role === "tool_results" && r.results.map((x) => [x.call_id, x.is_error]).join() === "a,false,b,true");
    assert.match(r.results[1]?.content ?? "", /did not run/);
  });
  test("a call at the end of the conversation is answered too", async () => {
    const c = ok(await build([user("go"), say([call("a")], { stop_reason: "tool_use" })]));
    assert.deepEqual(roles(c), ["user", "assistant", "tool_results"]);
  });
  test("a result with no call is dropped; a duplicate result is dropped", async () => {
    const c = ok(await build([user("go"), result("ghost"), say([call("a")], { stop_reason: "tool_use" }), result("a"), result("a", "again")]));
    assert.deepEqual(roles(c), ["user", "assistant", "tool_results"]);
    assert.equal((c.turns[2] as { results: unknown[] }).results.length, 1);
  });
  test("results spread over several entries are one turn", async () => {
    const c = ok(await build([user("go"), say([call("a"), call("b")], { stop_reason: "tool_use" }), result("b"), result("a")]));
    assert.deepEqual(roles(c), ["user", "assistant", "tool_results"]);
  });
});

describe("blobs and hints", () => {
  const ref = { $tag: "blob" as const, sha256: "ab".repeat(32), bytes: 5 };
  const entries: ChatEntry[] = [user("go"), say([call("a")], { stop_reason: "tool_use" }), { $tag: "tool_result", id: id(), call_id: "a", is_error: false, content: ref, truncated: true }, say([{ $tag: "reasoning", provider: "anthropic", visible: ref }, { $tag: "text", text: ref }])];
  test("large texts are read in; without a reader it is an error", async () => {
    const c = ok(await build(entries, { readText: async (r) => `blob:${r.sha256.slice(0, 2)}` }));
    const r = c.turns[2];
    assert.ok(r?.role === "tool_results" && r.results[0]?.content === "blob:ab" && r.results[0].truncated === true);
    const a = c.turns[3];
    assert.ok(a?.role === "assistant" && a.blocks.map((b) => (b.type === "text" ? b.text : b.type === "reasoning" ? b.visible : "")).join() === "blob:ab,blob:ab");
    await assert.rejects(build(entries), /readText/);
  });
  test("cache hints: the end of the previous exchange and the last turn", async () => {
    assert.deepEqual((await build([])).cacheHints, []);
    assert.deepEqual((await build([user("a")])).cacheHints, [0]);
    assert.deepEqual((await build([user("a"), say("b"), user("c")])).cacheHints, [1, 2]);
    assert.deepEqual((await build([user("a"), say("b"), user("c"), say("d"), user("e")])).cacheHints, [3, 4]);
  });
});

describe("golden", () => {
  test("a rich conversation renders as recorded (CHATTREE_UPDATE_GOLDEN=1 rewrites the file)", async () => {
    n = 0;
    const [u1, a1] = [user("Fix the tokenizer."), say([think(), { $tag: "text", text: "Looking." }, call("t1", "read"), call("t2", "read")], { stop_reason: "tool_use" })];
    const comp: ChatEntry = { $tag: "compaction", id: id(), replaces: { from: (u1 as { id: string }).id, to: (a1 as { id: string }).id }, summary: "User wants the tokenizer fixed; two files were read." };
    const entries: ChatEntry[] = [
      header, setup, u1, a1, result("t1", "file one"), result("t2", "boom", true), say("Found it."), comp, user("Now add tests."),
      say([call("t3", "subagent")], { stop_reason: "tool_use" }),
      { $tag: "subagent_result", id: id(), call_id: "t3", branch: "sub/1", tip: "abc", summary: "Tests written.", files: { changed: [], added: ["t.test.ts"], discarded: [] } },
      { $tag: "interrupted", id: id(), by: "user", partial: [{ $tag: "text", text: "Great, I will" }, { $tag: "tool_call", call_id: "t4", name: "write", args: {} }] },
      user("Never mind, stop."),
    ];
    const ctx = await build(entries, { instructions: "Be brief.", tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }] });
    assert.deepEqual(contextProblems(ctx), []);
    const path = fileURLToPath(new URL("./golden/context-rich.json", import.meta.url));
    const text = JSON.stringify(ctx, null, 2) + "\n";
    if (process.env["CHATTREE_UPDATE_GOLDEN"] === "1") await writeFile(path, text);
    assert.equal(text, await readFile(path, "utf8"));
  });
});

describe("contextProblems", () => {
  test("flags what providers reject", () => {
    const bad: ModelContext = {
      system: "",
      instructions: undefined,
      tools: [],
      cacheHints: [],
      turns: [
        { role: "user", parts: [{ type: "text", text: "a" }] },
        { role: "user", parts: [{ type: "text", text: "b" }] },
        { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "x", name: "n", args: {} }] },
        { role: "user", parts: [{ type: "text", text: "c" }] },
        { role: "tool_results", results: [{ call_id: "y", is_error: false, content: "", truncated: false }] },
      ],
    };
    const p = contextProblems(bad).join("\n");
    assert.match(p, /consecutive user/);
    assert.match(p, /user turn while tool calls are unanswered/);
    assert.match(p, /result for y has no call/);
  });
});
