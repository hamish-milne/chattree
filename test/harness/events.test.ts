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

const CONFIG = "# my agent\nproviders:\n  main:\n    $tag: anthropic # the provider\n    api_key_env: ANTHROPIC_API_KEY\n";

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
  test("create({config}) writes the file with the header commit", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    assert.equal(await readFile(join(dir, CONFIG_FILE), "utf8"), CONFIG);
    assert.deepEqual(await tags(convo), ["header"]);
    assert.equal(await convo.git.isClean(), true, "the file is committed, not left in the working tree");
    const r = await convo.readConfig();
    assert.ok(r?.ok && r.value.providers["main"]?.$tag === "anthropic");
  });

  test("a conversation without a config has none", async () => {
    const { convo } = await fresh();
    assert.equal(await convo.readConfig(), undefined);
  });

  test("an edit is an ordinary workspace change: committed by snapshot, history is git's", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    await convo.append(user("hi"));
    await writeFile(join(dir, CONFIG_FILE), CONFIG.replace("ANTHROPIC_API_KEY", "OTHER_KEY"));
    assert.ok(await convo.snapshot());
    const old = await convo.git.text(["show", "HEAD~1:" + CONFIG_FILE]);
    assert.match(old, /ANTHROPIC_API_KEY/);
    assert.deepEqual(await tags(convo), ["header", "user"], "no entry records it");
  });

  test("a hand edit that breaks the file is reported by readConfig", async () => {
    const { dir, convo } = await fresh({ config: CONFIG });
    await writeFile(join(dir, CONFIG_FILE), "limits: {warn_at: 7}\n");
    const r = await convo.readConfig();
    assert.ok(r !== undefined && !r.ok && r.issues.length > 0);
  });

  test("invalid configuration is rejected by create and leaves nothing behind", async () => {
    const dir = join(await tempDir(), "x");
    await assert.rejects(Conversation.create(host, dir, { config: "garbage: [" }), ConversationError);
    await assert.rejects(Conversation.create(host, dir, { config: "model: {}\n" }), ConversationError);
  });
});
