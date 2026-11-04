import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type NewEntry } from "../../harness/conversation.ts";
import { openEntry, search } from "../../harness/search.ts";
import { searchTool } from "../../harness/search-tool.ts";
import type { Tool, ToolOutput } from "../../harness/tools.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });
const result = (id: string, content: string): NewEntry => ({ $tag: "tool_result", call_id: id, is_error: false, content });

async function world() {
  const dir = join(await tempDir(), "conv");
  const main = await Conversation.create(host, dir);
  const first = await main.append(user("please look at the zebra parser"));
  const second = await main.append(reply("the zebra parser lives in src/zebra.ts"));
  const child = (await main.spawnSubagent({ brief: "check the giraffe module", callId: "toolu_1", name: "sub/giraffe" })).conversation as Conversation;
  await child.append(reply("the giraffe module has a bug"));
  const sibling = (await main.spawnSubagent({ brief: "check the okapi module", callId: "toolu_2", name: "sub/okapi" })).conversation as Conversation;
  await sibling.append(reply("okapi is fine, ask about the zebra"));
  const tool = searchTool({ convo: main }) as Tool;
  const run = async (thread: string, args: Record<string, unknown>): Promise<ToolOutput> => (await tool.execute(args, { thread, callId: "c", signal: new AbortController().signal, workspace: dir, host })) as ToolOutput;
  return { dir, main, child, sibling, first, second, tool, run };
}

describe("search", () => {
  test("what the model already sees is left out; include_visible brings it back", async () => {
    const w = await world();
    const none = await search(w.main, "main", { query: "zebra" });
    assert.equal(none.hits.length, 0, "both entries are in the context");
    const all = await search(w.main, "main", { query: "zebra", includeVisible: true });
    assert.deepEqual(all.hits.map((h) => h.ref).sort(), [`main:${w.first.id}`, `main:${w.second.id}`].sort());
  });

  test("entries compacted away are found", async () => {
    const w = await world();
    await w.main.compact({ from: w.first.id, to: w.second.id, summary: "we discussed a parser" });
    const found = await search(w.main, "main", { query: "zebra parser" });
    assert.equal(found.hits.length, 2);
    assert.match(found.hits[0]?.excerpt ?? "", /zebra/);
  });

  test("a trimmed tool result is found, one that is whole is not; large results stored as blobs are searched", async () => {
    const dir = join(await tempDir(), "conv");
    const c = await Conversation.create(host, dir);
    await c.append(user("go"));
    const big = await c.append(result("a", `${"filler line\n".repeat(20000)}the needle is here\n`));
    const small = await c.append(result("b", "a small needle"));
    await c.append(reply("done"));
    assert.equal((await search(c, "main", { query: "needle" })).hits.length, 0, "everything is whole");
    await c.trim({ upto: big.id, rule: { tool_results: 2048 }, by: "user" });
    const r = await search(c, "main", { query: "needle" });
    assert.deepEqual(r.hits.map((h) => h.ref), [`main:${big.id}`], "only the trimmed one: the small result is still shown to the model");
    assert.equal(r.hits[0]?.kind, "tool result");
    assert.ok(small.id !== big.id);
  });

  test("words must all occur, phrases as written; regex is a pattern; unsafe patterns are refused", async () => {
    const w = await world();
    const q = (query: string, regex = false) => search(w.main, "main", { query, regex, includeVisible: true });
    assert.equal((await q("zebra parser")).hits.length, 2);
    assert.equal((await q("zebra giraffe")).hits.length, 0);
    assert.equal((await q('"parser lives"')).hits.length, 1);
    assert.equal((await q('"lives parser"')).hits.length, 0);
    assert.equal((await q("zeb[r]a\\.ts", true)).hits.length, 1);
    assert.equal((await q("zebra.ts", true)).hits.length, 1, "in a pattern the dot is any character");
    await assert.rejects(() => q("(a+)+$", true), /repeats a group/);
    await assert.rejects(() => q("(", true), /not a regular expression/);
    await assert.rejects(() => q("   "), /empty/);
  });

  test("scope: thread is its own, family adds parent, children and siblings, project everything; closest first, shared entries once", async () => {
    const w = await world();
    const other = (await w.child.fork()).conversation as Conversation;
    await other.append(reply("an unrelated zebra thought"));
    const by = async (thread: string, scope: "thread" | "family" | "project") => search(w.main, thread, { query: "zebra", scope, includeVisible: true });

    // From the first sibling: its own history includes main's shared entries (inherited, but fresh context only holds the brief).
    const own = await by("sub/okapi", "thread");
    assert.ok(own.hits.every((h) => h.thread === "sub/okapi" || h.thread === "main"), "its own history, with what it inherited under the first thread that has it");
    const family = await by("sub/okapi", "family");
    const threads = new Set(family.hits.map((h) => h.thread));
    assert.ok(threads.has("main") && threads.has("sub/okapi"));
    assert.ok(!threads.has(other.branch), "a fork of okapi's sibling is not kin of okapi");
    const project = await by("sub/okapi", "project");
    assert.ok(new Set(project.hits.map((h) => h.thread)).has(other.branch));
    const ids = project.hits.map((h) => h.ref.split(":")[1]);
    assert.equal(new Set(ids).size, ids.length, "an entry several threads share is reported once");
    // Closest first: the asker's own thread, then its parent.
    const order = project.hits.map((h) => h.relation);
    assert.ok(order.indexOf("self") <= order.indexOf("parent") || !order.includes("self"));
    assert.ok(order.indexOf("parent") < order.indexOf("other"));

    const fromMain = await by("main", "family");
    assert.ok(fromMain.hits.some((h) => h.relation === "child" || h.relation === "self"));
    assert.ok(fromMain.hits.some((h) => h.thread === "sub/okapi" && h.relation === "child"));
  });

  test("a hit's reference opens the entry, and bad references say why", async () => {
    const w = await world();
    const hit = (await search(w.main, "sub/giraffe", { query: "giraffe module has", includeVisible: true })).hits[0];
    assert.ok(hit !== undefined);
    const opened = await openEntry(w.main, hit.ref);
    assert.ok("text" in opened && opened.text.includes("the giraffe module has a bug"));
    const prefix = await openEntry(w.main, `${hit.ref.slice(0, hit.ref.indexOf(":") + 25)}`);
    assert.ok("text" in prefix, "a prefix of the id is enough when it is unique");
    assert.ok("error" in (await openEntry(w.main, "nonsense")));
    assert.match(("error" in (await openEntry(w.main, `nope:${w.first.id}`)) ? (await openEntry(w.main, `nope:${w.first.id}`) as { error: string }).error : ""), /no thread nope/);
    assert.match((await openEntry(w.main, `main:ZZZZZZZZZZ`) as { error: string }).error, /no entry/);
  });
});

describe("the search tool", () => {
  test("keys: this thread needs current, anything wider or another thread's entry needs other; other covers both", async () => {
    const w = await world();
    const ctx = { thread: "main", workspace: w.dir, host };
    assert.deepEqual(await w.tool.allowKeys?.({ query: "x" }, ctx), ["current"]);
    assert.deepEqual(await w.tool.allowKeys?.({ query: "x", scope: "family" }, ctx), ["other"]);
    assert.deepEqual(await w.tool.allowKeys?.({ entry: "sub/giraffe:01ABCDEF" }, ctx), ["other"]);
    assert.deepEqual(await w.tool.allowKeys?.({ entry: "main:01ABCDEF" }, ctx), ["current"]);
    assert.deepEqual(await w.tool.covers?.(["current"], { query: "x" }, ctx), ["current"]);
    assert.equal(await w.tool.covers?.(["current"], { query: "x", scope: "project" }, ctx), undefined);
    assert.deepEqual(await w.tool.covers?.(["other"], { query: "x" }, ctx), ["other"]);
    assert.equal(w.tool.validateKey?.("bogus") === undefined, false);
  });

  test("a search returns references and notes what is left out; an entry argument reads one", async () => {
    const w = await world();
    const none = await w.run("main", { query: "zebra" });
    assert.match(none.content, /No matches/);
    assert.match(none.content, /include_visible/);
    const found = await w.run("main", { query: "zebra", include_visible: true });
    assert.match(found.content, /2 matches in 1 thread/);
    const ref = /(main:[0-9A-Z]{26})/.exec(found.content)?.[1];
    assert.ok(ref !== undefined);
    assert.match((await w.run("main", { entry: ref })).content, /zebra/);
    const wide = await w.run("main", { query: "okapi", scope: "family", include_visible: true });
    assert.match(wide.content, /sub\/okapi:[0-9A-Z]{26}/);
    assert.equal((await w.run("main", { query: "(a+)+", regex: true })).is_error, true);
    assert.equal((await w.run("main", {})).is_error, true);
  });
});
