import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Host } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import { parseCachedIndex } from "../../harness/index-cache.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { faultyHost } from "../support/hosts.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "m", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });
const batch = (n: number, big = false): NewEntry[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? user(`q${i}${big && i === 2 ? "x".repeat(9000) : ""}`) : reply(`a${i}`)));

function counting(inner: Host): Host & { execs: Record<string, number>; total(): number } {
  const execs: Record<string, number> = {};
  return {
    ...inner,
    execs,
    total: () => Object.values(execs).reduce((a, b) => a + b, 0),
    exec: (p, a, o) => {
      const k = a.find((x, i) => !x.startsWith("-") && !(a[i - 1] === "-c")) ?? "?";
      execs[k] = (execs[k] ?? 0) + 1;
      return inner.exec(p, a, o);
    },
  };
}

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h: Host = host) {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(h, dir, opts) };
}

describe("appendMany", () => {
  test("is equivalent to appending one by one, with a constant number of git processes", async () => {
    const opts = { now: () => 1_700_000_000_000, fixedDates: true };
    const a = await fresh(opts);
    const h = counting(host);
    const b = await fresh(opts, h);
    const entries = batch(30, true);
    for (const e of entries) await a.convo.append({ ...e });
    const before = h.total();
    const out = await b.convo.appendMany(entries.map((e) => ({ ...e })));
    const used = h.total() - before;
    assert.equal(out.length, 30);
    assert.ok(used <= 8, `used ${used} git processes for 30 entries`);

    const strip = (t: Uint8Array) => new TextDecoder().decode(t).replace(/id: "?[0-9A-Z]{26}"?/g, "id: X");
    assert.equal(strip(await b.convo.readTranscript()), strip(await a.convo.readTranscript()), "same transcript apart from ids");
    const [la, lb] = [await a.convo.git.log("HEAD", { firstParent: true }), await b.convo.git.log("HEAD", { firstParent: true })];
    assert.equal(la.length, lb.length);
    for (const [i, c] of lb.entries()) {
      assert.equal(c.subject, la[i]?.subject);
      assert.deepEqual(Object.keys(c.trailers).sort(), Object.keys(la[i]?.trailers ?? {}).sort());
      assert.equal(c.authorName, la[i]?.authorName);
    }
    assert.deepEqual(await verifyHistory(b.convo, { deep: true }), []);
    await assertHistoryInvariants(b.convo);
    assert.equal(await b.convo.git.isClean(), true, "index and working tree agree with HEAD");
    assert.deepEqual((await b.convo.index()).map((r) => r.id), [undefined, ...out.map((o) => o.id)]);
  });

  test("the conversation carries on normally afterwards, in this handle and after reopening", async () => {
    const { dir, convo } = await fresh();
    await convo.appendMany(batch(5));
    const next = await convo.append(user("after"));
    assert.equal(next.offset, convo.size);
    const reopened = await Conversation.open(host, dir);
    await reopened.appendMany(batch(3));
    await reopened.append(reply("done"));
    assert.deepEqual(await verifyHistory(reopened, { deep: true }), []);
    assert.equal((await reopened.index()).length, 1 + 5 + 1 + 3 + 1);
  });

  test("blobs arrive with the first entry that refers to them", async () => {
    const { convo } = await fresh();
    const out = await convo.appendMany([user("small"), user("y".repeat(10_000)), user("z".repeat(10_000))]);
    const blobsAt = async (commit: string) => (await convo.git.text(["ls-tree", "-r", "--name-only", commit, "--", "blobs"])).split("\n").filter(Boolean).length;
    assert.deepEqual([await blobsAt(out[0]!.commit), await blobsAt(out[1]!.commit), await blobsAt(out[2]!.commit)], [0, 1, 2]);
    assert.deepEqual(await verifyHistory(convo, { deep: true }), []);
  });

  test("pending workspace changes are committed first as a snapshot, not mixed into entries", async () => {
    const { dir, convo } = await fresh();
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export {};\n");
    const out = await convo.appendMany(batch(2));
    const files = async (c: string) => (await convo.git.text(["ls-tree", "-r", "--name-only", c])).split("\n");
    const log = await convo.git.log("HEAD", { firstParent: true });
    assert.equal(log[2]?.trailers["Chattree-Snapshot"]?.[0], "true");
    assert.ok((await files(log[2]!.hash)).includes("src/a.ts"));
    assert.ok(out.every((o) => o.commit !== log[2]!.hash));
    assert.equal(await convo.git.isClean(), true);
    assert.deepEqual(await verifyHistory(convo, { deep: true }), []);
  });

  test("an invalid entry anywhere leaves everything untouched", async () => {
    const { convo } = await fresh();
    const size = convo.size;
    const head = await convo.git.head();
    await assert.rejects(convo.appendMany([user("fine"), { $tag: "compaction" } as unknown as NewEntry]));
    assert.equal(convo.size, size);
    assert.equal(await convo.git.head(), head);
    assert.deepEqual(await convo.appendMany([]), []);
    await convo.append(user("still works"));
  });

  test("crash sweep: every failure point leaves a history that opens and verifies, with all or some entries", async () => {
    const probe = faultyHost(host, Infinity);
    const p = await fresh({}, probe);
    probe.arm(Infinity);
    const base = probe.ops;
    await p.convo.appendMany(batch(4, true));
    const total = probe.ops - base;
    assert.ok(total >= 3);
    for (let k = 1; k <= total; k++) {
      const h = faultyHost(host, Infinity);
      const { dir, convo } = await fresh({}, h);
      h.arm(k);
      await assert.rejects(convo.appendMany(batch(4, true)), (e) => e instanceof Error && /injected fault/.test(e.message));
      const now = Date.now() + 120_000;
      const reopened = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(reopened);
      assert.deepEqual((await verifyHistory(reopened, { deep: true })).filter((x) => x.severity === "error"), [], `sweep ${k}: ${h.log.join(" | ")}`);
      const n = (await reopened.index()).length - 1;
      assert.ok(n === 0 || n === 4, `sweep ${k}: ${n} entries survived (all or none expected, as write-ahead is one append)`);
      await reopened.append(user("next"));
    }
  });
});

describe("events", () => {
  test("describe what happened, in order, once committed", async () => {
    const seen: ConversationEvent[] = [];
    const { dir, convo } = await fresh({ onEvent: (e) => void seen.push(e) });
    await convo.flushEvents();
    assert.deepEqual(seen.map((e) => e.type), ["entry"], "the header");
    seen.length = 0;

    await convo.append(user("hi"));
    await writeFile(join(dir, "w.txt"), "w\n");
    await convo.snapshot();
    const sub = await convo.spawnSubagent({ brief: "b", callId: "c1" });
    await writeFile(join(sub.conversation!.dir, "s.txt"), "s\n");
    await sub.conversation!.append(user("child"));
    const out = await convo.finishSubagent(sub.conversation!, { summary: "ok", callId: "c1" });
    await convo.flushEvents();

    assert.deepEqual(
      seen.map((e) => `${e.type}:${e.branch}`),
      ["entry:main", "snapshot:main", "entry:" + sub.branch, "branch:" + sub.branch, "entry:" + sub.branch, "entry:main", "merge:main"],
    );
    const entry = seen.find((e) => e.type === "entry" && e.value.$tag === "subagent_result");
    assert.ok(entry?.type === "entry" && entry.entry.commit === out.entry.commit);
    const merge = seen.find((e) => e.type === "merge");
    assert.ok(merge?.type === "merge" && merge.kind === "subagent" && merge.child === sub.branch && merge.report.added.includes("s.txt"));
    const branch = seen.find((e) => e.type === "branch");
    assert.ok(branch?.type === "branch" && branch.kind === "subagent" && branch.parent === "main");
  });

  test("a failing or slow handler never fails or delays the operation, and the error handler hears of it", async () => {
    const errors: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { convo } = await fresh({
      onEvent: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        await gate;
      },
      onEventError: (e) => void errors.push(e),
    });
    await convo.append(user("one")); // handler is stuck on the gate; append still completes
    await convo.append(user("two"));
    release();
    await convo.flushEvents();
    assert.equal(errors.length, 1);
    assert.equal(calls, 3);
  });

  test("open reports what it recovered", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("kept"));
    // an uncommitted complete entry and a torn one
    const file = join(dir, "chat.yml");
    const fs = await import("node:fs");
    fs.appendFileSync(file, '- !user\n  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"\n  content:\n  - !text\n    text: orphan\n\n- !user\n  id: "01ARZ');
    const seen: ConversationEvent[] = [];
    const reopened = await Conversation.open(host, dir, { onEvent: (e) => void seen.push(e) });
    await reopened.flushEvents();
    assert.deepEqual(seen.map((e) => e.type), ["recovery", "entry"]);
    const [r, e] = seen;
    assert.ok(r?.type === "recovery" && r.report.truncatedBytes > 0 && r.report.recovered.length === 1);
    assert.ok(e?.type === "entry" && e.recovered === true && e.value.$tag === "user" && e.entry.id === "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  test("handles for other branches inherit the handler", async () => {
    const seen: string[] = [];
    const { convo } = await fresh({ onEvent: (e) => void seen.push(`${e.type}:${e.branch}`) });
    const f = await convo.fork();
    await f.conversation!.append(user("in the fork"));
    await f.conversation!.flushEvents();
    assert.ok(seen.includes(`entry:${f.branch}`));
    assert.equal(seen.filter((s) => s === `entry:${f.branch}`).length, 2, "branch_start and the new message");
  });
});

describe("index cache", () => {
  async function grown(n: number) {
    const { dir, convo } = await fresh();
    await convo.appendMany(batch(n));
    await convo.flushIndex();
    return { dir, convo };
  }

  test("a cold open reads the index from the cache and only walks history newer than it", async () => {
    const { dir, convo } = await grown(20);
    const expected = await convo.index();
    const h = counting(host);
    const again = await Conversation.open(h, dir);
    const before = h.execs["log"] ?? 0;
    assert.deepEqual(await again.index(), expected);
    assert.equal((h.execs["log"] ?? 0) - before, 0, "no git log at all when the cache is current");

    await convo.append(user("more"));
    const second = await Conversation.open(h, dir);
    const idx = await second.index();
    assert.equal(idx.length, expected.length + 1);
    assert.equal((h.execs["log"] ?? 0) - before, 1, "one small log for the new entry only");
  });

  test("a damaged, foreign or stale cache is ignored and the index is still right", async () => {
    const { dir, convo } = await grown(6);
    const expected = await convo.index();
    const file = join(await convo.git.commonDir(), "chattree", "index", "main.json");
    for (const bad of ["not json", '{"v":2}', JSON.stringify({ v: 1, tip: "a".repeat(40), refs: [] }), JSON.stringify({ v: 1, tip: expected.at(-1)!.commit, refs: [[null, "header", "b".repeat(40), 5], [null, "user", "c".repeat(40), 3]] })]) {
      await writeFile(file, bad);
      const c = await Conversation.open(host, dir);
      assert.deepEqual(await c.index(), expected, bad.slice(0, 30));
    }
    await rmFile(file);
    assert.deepEqual(await (await Conversation.open(host, dir)).index(), expected);
  });

  test("indexCache: false keeps nothing on disk", async () => {
    const { dir, convo } = await fresh({ indexCache: false });
    await convo.appendMany(batch(3));
    await convo.flushIndex();
    const exists = await readFile(join(await convo.git.commonDir(), "chattree", "index", "main.json")).then(() => true, () => false);
    assert.equal(exists, false);
    assert.equal((await (await Conversation.open(host, dir, { indexCache: false })).index()).length, 4);
  });

  test("a custom cache can be supplied", async () => {
    const store = new Map<string, unknown>();
    const cache = { load: async (b: string) => store.get(b) as never, save: async (b: string, i: unknown) => void store.set(b, i) };
    const { convo } = await fresh({ indexCache: cache });
    await convo.append(user("x"));
    await convo.flushIndex();
    assert.ok(store.has("main"));
  });

  test("parseCachedIndex rejects anything that is not strictly increasing, well-formed data", () => {
    const ok = JSON.stringify({ v: 1, tip: "a".repeat(40), refs: [[null, "header", "b".repeat(40), 10], ["x", "user", "c".repeat(40), 20]] });
    assert.equal(parseCachedIndex(ok)?.refs.length, 2);
    assert.equal(parseCachedIndex(ok.replace("20", "10")), undefined);
    assert.equal(parseCachedIndex(ok.replace('"user"', "5")), undefined);
    assert.equal(parseCachedIndex(ok.replace("c".repeat(40), "zz")), undefined);
    assert.equal(parseCachedIndex(""), undefined);
  });
});

describe("cost of an append", () => {
  test("uses two git processes in steady state: stage and commit", async () => {
    const h = counting(host);
    const { convo } = await fresh({}, h);
    await convo.append(user("warm up"));
    const before = h.total();
    for (let i = 0; i < 10; i++) await convo.append(user(`m${i}`));
    assert.equal((h.total() - before) / 10, 2, JSON.stringify(h.execs));
  });
});

async function rmFile(p: string): Promise<void> {
  await (await import("node:fs/promises")).rm(p, { force: true });
}
