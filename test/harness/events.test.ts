import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { CONFIG_FILE, Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import { contextEntries } from "../../harness/context.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { faultyHost } from "../support/hosts.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "m", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });

const CONFIG = "# my agent\nversion: 1\nmodel:\n  provider: anthropic # the provider\n  model: claude-sonnet-5-5\n";

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h = host) {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(h, dir, opts) };
}

const tags = async (c: Conversation) => (await c.readEntries()).map((e) => (e.ok ? e.value.$tag : "?"));
const ids = async (c: Conversation) => (await c.index()).map((r) => r.id);

describe("interrupt", () => {
  test("records the partial turn", async () => {
    const { convo } = await fresh();
    await convo.append(user("hi"));
    await convo.interrupt({ by: "user", partial: [{ $tag: "text", text: "Let me" }] });
    await convo.interrupt({ by: "error", error: "connection reset" });
    const last = (await convo.readEntries()).slice(-2).map((e) => (e.ok ? e.value : undefined));
    assert.deepEqual(last.map((v) => v?.$tag), ["interrupted", "interrupted"]);
    assert.deepEqual((last[0] as { partial: unknown }).partial, [{ $tag: "text", text: "Let me" }]);
    assert.equal((last[1] as { error?: string }).error, "connection reset");
    await assertHistoryInvariants(convo);
  });
});

describe("compact", () => {
  async function chat() {
    const { convo } = await fresh();
    for (const t of ["a", "b", "c", "d"]) {
      await convo.append(user(t));
      await convo.append(reply(`re ${t}`));
    }
    return { convo, ids: await ids(convo) };
  }

  test("records a compaction over a visible range and the context uses it", async () => {
    const { convo, ids: id } = await chat();
    const at = await convo.compact({ from: id[1] as string, to: id[4] as string, summary: "early talk", model: "m" });
    const values = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const ctx = contextEntries(values);
    assert.ok(ctx.some((e) => e.$tag === "compaction" && "id" in e && e.id === at.id));
    assert.ok(!ctx.some((e) => "id" in e && e.id === id[2]), "replaced entries are hidden");
    assert.ok(ctx.some((e) => "id" in e && e.id === id[5]), "later entries stay");
  });

  test("a later compaction may contain an earlier summary whole", async () => {
    const { convo, ids: id } = await chat();
    const first = await convo.compact({ from: id[1] as string, to: id[2] as string, summary: "one" });
    await convo.compact({ from: first.id, to: id[6] as string, summary: "two" });
    assert.ok((await tags(convo)).filter((t) => t === "compaction").length === 2);
  });

  test("rejects ranges that are not visible, reversed or unknown", async () => {
    const { convo, ids: id } = await chat();
    await convo.compact({ from: id[1] as string, to: id[4] as string, summary: "s" });
    const before = (await convo.index()).length;
    for (const [from, to] of [
      [id[2], id[6]], // starts inside compacted range
      [id[1], id[3]], // ends inside compacted range
      [id[6], id[5]], // reversed
      ["01ARZ3NDEKTSV4RRFFQ69G5FAV", id[6]], // unknown
    ] as [string, string][]) {
      await assert.rejects(convo.compact({ from, to, summary: "x" }), ConversationError);
    }
    assert.equal((await convo.index()).length, before, "nothing was recorded");
    await assertHistoryInvariants(convo);
  });
});

describe("configuration", () => {
  test("create({config}) writes the file and records it", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    assert.equal(await readFile(join(dir, CONFIG_FILE), "utf8"), CONFIG);
    assert.ok((await tags(convo)).includes("config_changed"));
    const s = await convo.configStatus();
    assert.equal(s.inSync, true);
    assert.equal(s.current, s.recorded);
  });

  test("a conversation without a config is in sync", async () => {
    const { convo } = await fresh();
    assert.equal((await convo.configStatus()).inSync, true);
    assert.equal(await convo.readConfig(), undefined);
  });

  test("changeConfig keeps comments, records old and new hashes", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    const before = await convo.configStatus();
    const r = await convo.changeConfig((doc) => doc.setIn(["model", "model"], "claude-opus-5-5"));
    assert.equal(r.changed, true);
    const text = await readFile(join(dir, CONFIG_FILE), "utf8");
    assert.match(text, /# my agent/);
    assert.match(text, /# the provider/);
    assert.match(text, /claude-opus-5-5/);
    const last = (await convo.readEntries()).at(-1);
    assert.ok(last?.ok && last.value.$tag === "config_changed");
    assert.equal(last.value.old, before.recorded);
    assert.equal(last.value.new, r.hash);
    assert.equal((await convo.configStatus()).inSync, true);
    await assertHistoryInvariants(convo);
  });

  test("a comment-only edit changes the file but records nothing", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    const n = (await convo.index()).length;
    const r = await convo.setConfigText(CONFIG.replace("# my agent", "# renamed"));
    assert.equal(r.changed, false);
    assert.equal(r.entry, undefined);
    assert.match(await readFile(join(dir, CONFIG_FILE), "utf8"), /# renamed/);
    assert.equal((await convo.index()).length, n);
  });

  test("an edit made by hand shows as drift and is recorded by setConfigText", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    const edited = CONFIG.replace("claude-sonnet-5-5", "claude-haiku-5-5");
    await writeFile(join(dir, CONFIG_FILE), edited);
    const s = await convo.configStatus();
    assert.equal(s.inSync, false);
    assert.notEqual(s.current, s.recorded);
    const r = await convo.setConfigText(edited);
    assert.equal(r.changed, true);
    assert.equal((await convo.configStatus()).inSync, true);
  });

  test("a hand edit that breaks the file is reported, not hidden", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    await writeFile(join(dir, CONFIG_FILE), "version: 2\n");
    const s = await convo.configStatus();
    assert.equal(s.current, undefined);
    assert.equal(s.inSync, false);
    assert.ok(s.issues.length > 0);
  });

  test("invalid configuration is rejected and nothing changes", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    const n = (await convo.index()).length;
    await assert.rejects(convo.setConfigText("version: 1\nmodel: {}\n"), ConversationError);
    await assert.rejects(convo.changeConfig((doc) => doc.setIn(["model", "provider"], "nope")), ConversationError);
    assert.equal(await readFile(join(dir, CONFIG_FILE), "utf8"), CONFIG);
    assert.equal((await convo.index()).length, n);
    await assert.rejects(Conversation.create(host, join(await tempDir(), "x"), { config: "garbage: [" }), ConversationError);
  });

  test("branches carry their own record: a fork sees the config of its fork point", async () => {
    const { convo } = await fresh({ config: CONFIG });
    await convo.append(user("hi"));
    const fork = await convo.fork();
    await fork.conversation?.changeConfig((doc) => doc.setIn(["model", "model"], "other"));
    assert.equal((await convo.configStatus()).inSync, true);
    assert.equal((await fork.conversation?.configStatus())?.inSync, true);
    assert.notEqual((await convo.configStatus()).recorded, (await fork.conversation?.configStatus())?.recorded);
  });

  test("crash sweep: a failure anywhere leaves a recoverable, consistent conversation", async () => {
    // Count the mutating operations of one change, then fail at each in turn.
    const probe = faultyHost(host, Infinity);
    const p = await fresh({ config: CONFIG }, probe);
    probe.arm(Infinity);
    const base = probe.ops;
    await p.convo.changeConfig((doc) => doc.setIn(["model", "model"], "x"));
    const total = probe.ops - base;
    assert.ok(total > 0);
    for (let k = 1; k <= total; k++) {
      const h = faultyHost(host, Infinity);
      const { dir, convo } = await fresh({ config: CONFIG }, h);
      h.arm(k);
      await assert.rejects(convo.changeConfig((doc) => doc.setIn(["model", "model"], "x")), (e) => e instanceof Error && /injected fault/.test(e.message));
      const now = Date.now() + 120_000;
      const reopened = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(reopened);
      // Whatever happened, the next change works and the record catches up with the file.
      await reopened.setConfigText(await readFile(join(dir, CONFIG_FILE), "utf8"));
      assert.equal((await reopened.configStatus()).inSync, true, `sweep ${k}`);
    }
  });
});
