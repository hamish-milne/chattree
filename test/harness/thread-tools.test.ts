import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { threadTools } from "../../harness/thread-tools.ts";
import { foldTip } from "../../harness/tip.ts";
import { ToolRegistry, type Tool, type ToolOutput } from "../../harness/tools.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });

async function world(siblings = false) {
  const dir = join(await tempDir(), "conv");
  const main = await Conversation.create(host, dir);
  await main.append(user("the shared history"));
  const a = await main.append(reply("shared answer"));
  const one = (await main.spawnSubagent({ brief: "do part one", callId: "toolu_1", name: "sub/one" })).conversation as Conversation;
  const two = (await main.spawnSubagent({ brief: "do part two", callId: "toolu_2", name: "sub/two" })).conversation as Conversation;
  const [read, send] = threadTools({ convo: main, siblings }) as [Tool, Tool];
  const call = async (tool: Tool, thread: string, args: Record<string, unknown>): Promise<ToolOutput> => (await tool.execute(args, { thread, callId: "c1", signal: new AbortController().signal, workspace: dir, host })) as ToolOutput;
  const entriesOf = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  return { main, one, two, a, call: { read: (t: string, args: Record<string, unknown>) => call(read, t, args), send: (t: string, args: Record<string, unknown>) => call(send, t, args) }, entriesOf };
}

describe("thread_read", () => {
  test("a parent reads the child's own entries, not the history the child started from", async () => {
    const w = await world();
    await w.one.append(reply("I looked at the parser"));
    await w.one.append({ $tag: "tool_result", call_id: "x", is_error: false, content: "file listing" });
    const out = await w.call.read("main", { thread: "sub/one" });
    assert.ok(out.is_error !== true, out.content);
    assert.match(out.content, /sub\/one \(your child\)/);
    assert.match(out.content, /assistant: I looked at the parser/);
    assert.match(out.content, /result: file listing/);
    assert.doesNotMatch(out.content, /shared answer/, "the inherited history is not shown");
    assert.doesNotMatch(out.content, /the shared history/);
  });

  test("since reads on from where the last read stopped, and says when there is nothing new", async () => {
    const w = await world();
    await w.one.append(reply("first"));
    const first = await w.call.read("main", { thread: "sub/one" });
    const n = /Entries \d+-(\d+) of/.exec(first.content)?.[1];
    assert.ok(n !== undefined);
    assert.match((await w.call.read("main", { thread: "sub/one", since: Number(n) })).content, /Nothing new/);
    await w.one.append(reply("second"));
    const next = await w.call.read("main", { thread: "sub/one", since: Number(n) });
    assert.match(next.content, /assistant: second/);
    assert.doesNotMatch(next.content, /first/);
  });

  test("a child reads its parent by the name parent", async () => {
    const w = await world();
    await w.main.append(reply("the parent moved on"));
    const out = await w.call.read("sub/one", { thread: "parent" });
    assert.match(out.content, /main \(your parent\)/);
    assert.match(out.content, /the parent moved on/);
  });

  test("long output is cut to a bounded size, oldest first", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await w.one.append({ $tag: "tool_result", call_id: `c${i}`, is_error: false, content: `${i}:${"x".repeat(3000)}` });
    const out = await w.call.read("main", { thread: "sub/one", last: 30, full: true });
    assert.ok(out.content.length < 20_000, `${out.content.length}`);
    assert.match(out.content, /older entries were left out/);
    assert.match(out.content, /29:x/);
  });
});

describe("thread_send", () => {
  test("the message lands on the receiver's branch as a queued user entry from the sender, and wakes an idle thread", async () => {
    const w = await world();
    await w.one.append(reply("done for now"));
    const out = await w.call.send("main", { thread: "sub/one", message: "also check the lexer" });
    assert.ok(out.is_error !== true, out.content);
    const there = await w.entriesOf(await Conversation.open(host, w.one.dir));
    const last = there.at(-1);
    assert.ok(last?.$tag === "user");
    assert.equal(last.from, "main");
    assert.equal(last.queued, true);
    assert.deepEqual(last.content, [{ $tag: "text", text: "[Message from thread main]\nalso check the lexer" }]);
    const state = await foldTip({ entries: there, registry: new ToolRegistry(), allow: async () => undefined, nowMs: Date.now(), ctx: { workspace: w.one.dir, host } });
    assert.deepEqual([state.kind, state.kind === "ready" ? state.cause : undefined], ["ready", "human"], "a pump runs a thread that was waiting");
  });

  test("a child writes to its parent without ending, and the parent's own transcript has it", async () => {
    const w = await world();
    const out = await w.call.send("sub/one", { thread: "parent", message: "found the cause: the tokenizer" });
    assert.ok(out.is_error !== true, out.content);
    const mine = await w.entriesOf(await Conversation.open(host, w.main.dir));
    const last = mine.at(-1);
    assert.ok(last?.$tag === "user" && last.from === "sub/one");
    const child = await w.entriesOf(await Conversation.open(host, w.one.dir));
    assert.ok(child.every((e) => e.$tag !== "subagent_result"), "the child did not hand back");
  });

  test("strangers, itself and an empty message are refused; siblings only with the setting", async () => {
    const w = await world();
    assert.match((await w.call.send("main", { thread: "main", message: "hi" })).content, /this thread/);
    assert.match((await w.call.send("main", { thread: "nope", message: "hi" })).content, /no thread nope/);
    assert.match((await w.call.send("main", { thread: "sub/one", message: "  " })).content, /must not be empty/);
    assert.match((await w.call.send("main", { thread: "parent", message: "hi" })).content, /no parent/);
    const refused = await w.call.send("sub/one", { thread: "sub/two", message: "hello sibling" });
    assert.equal(refused.is_error, true);
    assert.match(refused.content, /threads\.siblings/);
    assert.match((await w.call.read("sub/one", { thread: "sub/two" })).content, /threads\.siblings/);

    const open = await world(true);
    const ok = await open.call.send("sub/one", { thread: "sub/two", message: "hello sibling" });
    assert.ok(ok.is_error !== true, ok.content);
    assert.match((await open.call.read("sub/one", { thread: "sub/two" })).content, /sibling/);
  });

  test("a thread that is not kin cannot be reached: a fork of a fork is not a sibling's child", async () => {
    const w = await world();
    const f = (await w.one.fork()).conversation as Conversation;
    // main -> one -> f. main is not f's parent, and f is not main's child.
    assert.match((await w.call.read("main", { thread: f.branch })).content, /not your parent or a thread you started/);
    assert.match((await w.call.send(f.branch, { thread: "main", message: "hi" })).content, /not your parent or a thread you started/);
    assert.ok((await w.call.read("sub/one", { thread: f.branch })).is_error !== true, "one started f");
    assert.ok((await w.call.read(f.branch, { thread: "parent" })).content.includes("sub/one"));
  });
});
