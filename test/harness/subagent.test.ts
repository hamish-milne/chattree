import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type DiffEntry, type MergeTreeResult } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { CHAT_FILE, Conversation, ConversationError, summarizeMerge, type NewEntry } from "../../harness/conversation.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { faultyHost } from "../support/hosts.ts";
import { tempDir } from "../support/tmp.ts";
import { slow, slowOptions } from "../support/slow.ts";

const host = nodeHost();
const dec = new TextDecoder();

const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({
  $tag: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  blocks: [{ $tag: "text", text }],
  stop_reason: "end_turn",
});

async function put(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    if (content === null) await rm(full, { recursive: true, force: true });
    else {
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  }
}

const read = async (dir: string, name: string): Promise<string | undefined> => readFile(join(dir, name), "utf8").catch(() => undefined);

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h = host): Promise<{ dir: string; convo: Conversation }> {
  const dir = join(await tempDir(), "conv");
  const convo = await Conversation.create(h, dir, opts);
  await put(dir, { "shared.txt": "shared\n", "notes.md": "line 1\nline 2\nline 3\n", "src/lib.ts": "export const x = 1;\n" });
  await convo.append(user("start the project"));
  return { dir, convo };
}

const resultOf = async (convo: Conversation) => {
  const last = (await convo.readEntries()).at(-1);
  assert.ok(last?.ok && last.value.$tag === "subagent_result", "last entry is a subagent_result");
  return last.value;
};

describe("spawnSubagent", () => {
  test("branches from the current state with a fresh-context marker and the brief", async () => {
    const { dir, convo } = await fresh();
    const before = await convo.readTranscript();
    const head = await convo.git.head();
    const { branch, start, conversation, from } = await convo.spawnSubagent({ brief: "Find every caller of tokenize().", callId: "toolu_01" });
    assert.match(branch, /^sub\/[0-9A-Z]{26}$/);
    assert.equal(from, head, "no pending changes, so no snapshot commit");
    assert.ok(conversation !== undefined);
    assert.equal(conversation.dir, join(`${dir}.branches`, encodeURIComponent(branch)));

    const entries = await conversation.readEntries();
    const marker = entries.at(-1);
    assert.ok(marker?.ok && marker.value.$tag === "branch_start");
    assert.deepEqual(marker.value, {
      $tag: "branch_start",
      id: start.id,
      kind: "subagent",
      from: { branch: "main", commit: head },
      context: "fresh",
      brief: "Find every caller of tokenize().",
      call_id: "toolu_01",
    });
    assert.equal(entries.length, 3, "header, the parent's user entry, and the marker");
    assert.deepEqual(await convo.readTranscript(), before, "the parent's transcript is unchanged");
    assert.equal((await conversation.git.log(branch, { maxCount: 1 }))[0]?.subject, "branch_start: subagent");
    await assertHistoryInvariants(conversation);
  });

  test("the subagent sees the parent's pending workspace changes, which are snapshotted first", async () => {
    const { dir, convo } = await fresh();
    await put(dir, { "notes.md": "line 1\nedited by parent\nline 3\n", "scratch/new.txt": "new\n" });
    const sub = await convo.spawnSubagent({ brief: "b", callId: "c" });
    assert.equal(await read((sub.conversation as Conversation).dir, "notes.md"), "line 1\nedited by parent\nline 3\n");
    assert.equal(await read((sub.conversation as Conversation).dir, "scratch/new.txt"), "new\n");
    const [snap, entryCommit] = await convo.git.log("HEAD", { maxCount: 2 });
    assert.deepEqual(snap?.trailers["Chattree-Snapshot"], ["true"]);
    assert.equal(snap?.subject, "workspace snapshot");
    assert.equal(snap?.hash, sub.from);
    assert.equal(entryCommit?.trailers["Chattree-Kind"]?.[0], "user");
    assert.equal(await convo.git.isClean(), true);
    assert.deepEqual((await convo.index()).map((r) => r.tag), ["header", "user"], "a snapshot is not an entry");
    await assertHistoryInvariants(convo);
    await convo.append(reply("parent carries on after a snapshot"));
  });

  test("a long brief is stored as a blob inside the new branch, not left in the parent's worktree", async () => {
    const { convo } = await fresh({ pipeline: { threshold: 100 } });
    const brief = "very long instructions\n".repeat(50);
    const { conversation } = await convo.spawnSubagent({ brief, callId: "c" });
    assert.ok(conversation !== undefined);
    const marker = (await conversation.readEntries()).at(-1);
    assert.ok(marker?.ok && marker.value.$tag === "branch_start");
    const ref = marker.value.brief as unknown as { $tag: string; sha256: string };
    assert.equal(ref.$tag, "blob");
    assert.equal(dec.decode(await conversation.store.get(ref.sha256)), brief);
    assert.equal(await convo.store.get(ref.sha256), undefined);
    assert.equal(await convo.git.isClean(), true);
  });

  test("from an earlier entry, with a chosen name; errors for bad names", async () => {
    const { convo } = await fresh();
    const first = await convo.index();
    await convo.append(reply("later"));
    const sub = await convo.spawnSubagent({ brief: "b", callId: "c", name: "helper", from: first.at(-1)?.id as string });
    assert.equal(sub.branch, "helper");
    assert.equal(sub.from, first.at(-1)?.commit);
    await assert.rejects(convo.spawnSubagent({ brief: "b", callId: "c", name: "helper" }), /already exists/);
    await assert.rejects(convo.spawnSubagent({ brief: "b", callId: "c", name: "bad name" }), ConversationError);
  });
});

describe("finishSubagent", () => {
  test("merges non-conflicting work from both sides and records the result as a merge commit", async () => {
    const { dir, convo } = await fresh();
    const { conversation: child, branch } = await convo.spawnSubagent({ brief: "write the docs", callId: "toolu_09" });
    assert.ok(child !== undefined);
    await put(child.dir, { "docs/guide.md": "guide\n", "src/lib.ts": "export const x = 2;\n", "shared.txt": null });
    await child.append(reply("docs written"));
    await put(child.dir, { "docs/api.md": "api\n" });
    const last = await child.append(reply("api docs"));

    await put(dir, { "other.txt": "parent work\n" });
    await convo.append(reply("parent in the meantime"));
    const parentBefore = await convo.index();

    const out = await convo.finishSubagent(child, { summary: "Docs are in docs/.", callId: "toolu_09" });
    assert.equal(out.childTip, last.commit);
    assert.deepEqual(out.report.added, ["docs/api.md", "docs/guide.md"]);
    assert.deepEqual(out.report.changed, ["shared.txt", "src/lib.ts"]);
    assert.deepEqual(out.report.discarded, []);
    assert.deepEqual(out.report.conflicts, []);

    // files from both sides
    assert.equal(await read(dir, "docs/guide.md"), "guide\n");
    assert.equal(await read(dir, "docs/api.md"), "api\n");
    assert.equal(await read(dir, "src/lib.ts"), "export const x = 2;\n");
    assert.equal(await read(dir, "shared.txt"), undefined, "the child's deletion landed");
    assert.equal(await read(dir, "other.txt"), "parent work\n");
    assert.equal(await convo.git.isClean(), true);

    // the result entry
    const value = await resultOf(convo);
    assert.deepEqual(value, {
      $tag: "subagent_result",
      id: out.entry.id,
      call_id: "toolu_09",
      branch,
      tip: last.commit,
      summary: "Docs are in docs/.",
      files: { changed: ["shared.txt", "src/lib.ts"], added: ["docs/api.md", "docs/guide.md"], discarded: [] },
      merge: { policy: "trunk", base: out.report.base, conflicts: [] },
    });

    // the commit: a merge of the parent's tip and the child's tip, carrying the usual trailers
    const [m] = await convo.git.log("HEAD", { maxCount: 1 });
    assert.equal(m?.hash, out.entry.commit);
    assert.deepEqual(m?.parents, [parentBefore.at(-1)?.commit, last.commit]);
    assert.equal(m?.subject, `subagent_result: ${branch}`);
    assert.deepEqual(m?.trailers["Chattree-Kind"], ["subagent_result"]);
    assert.deepEqual(m?.trailers["Chattree-Entry"], [out.entry.id]);
    assert.deepEqual(m?.trailers["Chattree-Offset"], [String(convo.size)]);
    assert.equal(await convo.git.isAncestor(last.commit, "HEAD"), true);

    // the parent's transcript holds no child entries; the child's branch is kept
    const tags = (await convo.readEntries()).map((e) => (e.ok ? e.tag : "?"));
    assert.deepEqual(tags, ["header", "user", "assistant", "subagent_result"]);
    assert.equal((await convo.listBranches()).some((b) => b.name === branch), true);
    assert.equal((await convo.index()).at(-1)?.id, out.entry.id);
    await assertHistoryInvariants(convo);
    await convo.append(reply("and on"));
    await assertHistoryInvariants(convo);
  });

  test("conflicts take the parent's version and are reported exactly", async () => {
    const { dir, convo } = await fresh();
    await put(dir, { "modified-both.txt": "a\nb\nc\n", "child-deletes.txt": "x\n", "parent-deletes.txt": "y\n", "kind/inner": "1\n", keep: "k\n" });
    await convo.append(reply("more files"));
    const { conversation: child, branch } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    assert.ok(child !== undefined);

    await put(child.dir, { "modified-both.txt": "a\nB-child\nc\n", "child-deletes.txt": null, "parent-deletes.txt": "child edit\n", "child-new.txt": "n\n", kind: null });
    await put(child.dir, { kind: "now a file\n" });
    await child.append(reply("child done"));

    await put(dir, { "modified-both.txt": "a\nB-parent\nc\n", "child-deletes.txt": "parent edit\n", "parent-deletes.txt": null, "parent-new.txt": "p\n", "kind/other": "2\n" });
    await convo.append(reply("parent done"));

    const out = await convo.finishSubagent(child, { summary: "done", callId: "c" });

    assert.equal(await read(dir, "modified-both.txt"), "a\nB-parent\nc\n");
    assert.equal(await read(dir, "child-deletes.txt"), "parent edit\n");
    assert.equal(await read(dir, "parent-deletes.txt"), undefined, "the parent deleted it, so it stays deleted");
    assert.equal(await read(dir, "kind/inner"), undefined, "the child's deletion inside the directory landed");
    assert.equal(await read(dir, "kind/other"), "2\n", "the parent's directory survives");
    assert.equal(await read(dir, "child-new.txt"), "n\n", "non-conflicting child work still lands");
    assert.equal(await read(dir, "parent-new.txt"), "p\n");
    assert.equal(await read(dir, "keep"), "k\n");
    assert.deepEqual((await convo.git.status()), []);

    assert.deepEqual(out.report.discarded, ["child-deletes.txt", "kind", "modified-both.txt", "parent-deletes.txt"]);
    assert.deepEqual(out.report.added, ["child-new.txt"]);
    assert.deepEqual(out.report.changed, ["kind/inner"]);
    assert.deepEqual(out.report.conflicts, [
      { path: "child-deletes.txt", kind: "modify/delete" },
      { path: "kind", kind: "file/directory" },
      { path: "modified-both.txt", kind: "content" },
      { path: "parent-deletes.txt", kind: "modify/delete" },
    ]);
    const value = await resultOf(convo);
    assert.deepEqual(value.files.discarded, out.report.discarded);
    assert.deepEqual(value.merge?.conflicts, out.report.conflicts);
    assert.equal(value.branch, branch);
    await assertHistoryInvariants(convo);
  });

  test("the parent's uncommitted changes are kept, and win over the child's edits to the same file", async () => {
    const { dir, convo } = await fresh();
    const { conversation: child } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    assert.ok(child !== undefined);
    await put(child.dir, { "notes.md": "child version\n", "child-only.txt": "c\n" });
    await child.append(reply("done"));
    await put(dir, { "notes.md": "uncommitted parent edit\n", "parent-only.txt": "p\n" });

    const out = await convo.finishSubagent(child, { summary: "s", callId: "c" });
    assert.equal(await read(dir, "notes.md"), "uncommitted parent edit\n");
    assert.equal(await read(dir, "parent-only.txt"), "p\n");
    assert.equal(await read(dir, "child-only.txt"), "c\n");
    assert.deepEqual(out.report.discarded, ["notes.md"]);
    assert.equal(await convo.git.isClean(), true, "nothing is left uncommitted");
    assert.ok((await convo.git.log("HEAD", { maxCount: 5 })).some((c) => c.subject === "workspace snapshot"));
  });

  test("changes the child left uncommitted are included when finishing with its handle, not with its name", async () => {
    const { convo } = await fresh();
    const a = await convo.spawnSubagent({ brief: "a", callId: "ca" });
    const b = await convo.spawnSubagent({ brief: "b", callId: "cb" });
    await put((a.conversation as Conversation).dir, { "from-a.txt": "a\n" });
    await put((b.conversation as Conversation).dir, { "from-b.txt": "b\n" });
    const outA = await convo.finishSubagent(a.conversation as Conversation, { summary: "a", callId: "ca" });
    const outB = await convo.finishSubagent(b.branch, { summary: "b", callId: "cb" });
    assert.deepEqual(outA.report.added, ["from-a.txt"]);
    assert.deepEqual(outB.report.added, [], "the branch's last commit had no files; its working tree changes were not committed");
  });

  test("several subagents can be finished one after another", async () => {
    const { dir, convo } = await fresh();
    const subs = await Promise.all([0, 1, 2].map((i) => convo.spawnSubagent({ brief: `task ${i}`, callId: `c${i}` })));
    for (const [i, s] of subs.entries()) {
      await put((s.conversation as Conversation).dir, { [`out/${i}.txt`]: `result ${i}\n` });
      await (s.conversation as Conversation).append(reply(`done ${i}`));
    }
    for (const [i, s] of subs.entries()) {
      const out = await convo.finishSubagent(s.conversation as Conversation, { summary: `s${i}`, callId: `c${i}` });
      assert.deepEqual(out.report.added, [`out/${i}.txt`]);
    }
    for (let i = 0; i < 3; i++) assert.equal(await read(dir, `out/${i}.txt`), `result ${i}\n`);
    assert.deepEqual((await convo.readEntries()).slice(-3).map((e) => (e.ok && e.value.$tag === "subagent_result" ? e.value.call_id : "?")), ["c0", "c1", "c2"]);
    await assertHistoryInvariants(convo);
  });

  test("a long summary becomes a blob in the merge commit", async () => {
    const { dir, convo } = await fresh({ pipeline: { threshold: 100 } });
    const { conversation: child } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    await (child as Conversation).append(reply("done"));
    const summary = "detailed findings\n".repeat(40);
    await convo.finishSubagent(child as Conversation, { summary, callId: "c" });
    const value = await resultOf(convo);
    const ref = value.summary as unknown as { $tag: string; sha256: string };
    assert.equal(ref.$tag, "blob");
    assert.equal(dec.decode(await convo.store.get(ref.sha256)), summary);
    assert.equal(await convo.git.isClean(), true);
    void dir;
  });

  test("the child's own transcript and blobs do not appear in the report", async () => {
    const { convo } = await fresh({ pipeline: { threshold: 100 } });
    const { conversation: child } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    await (child as Conversation).append({ $tag: "tool_result", call_id: "x", is_error: false, content: "output\n".repeat(100) });
    const out = await convo.finishSubagent(child as Conversation, { summary: "s", callId: "c" });
    assert.deepEqual([out.report.changed, out.report.added, out.report.discarded], [[], [], []]);
  });

  test("errors: itself, an unknown branch, merging twice", async () => {
    const { convo } = await fresh();
    const { conversation: child, branch } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    await (child as Conversation).append(reply("x"));
    await assert.rejects(convo.finishSubagent("main", { summary: "s", callId: "c" }), /itself/);
    await assert.rejects(convo.finishSubagent("nope", { summary: "s", callId: "c" }), /no such branch/);
    await convo.finishSubagent(child as Conversation, { summary: "s", callId: "c" });
    await assert.rejects(convo.finishSubagent(branch, { summary: "s", callId: "c" }), /already merged/);
    await assertHistoryInvariants(convo);
  });

  test("a handle that fell behind another writer still merges", async () => {
    const { dir, convo } = await fresh();
    const { conversation: child } = await convo.spawnSubagent({ brief: "b", callId: "c" });
    await (child as Conversation).append(reply("x"));
    const other = await Conversation.open(host, dir);
    await other.append(user("someone else appended"));
    await convo.finishSubagent(child as Conversation, { summary: "s", callId: "c" });
    await assertHistoryInvariants(convo);
  });
});

describe("summarizeMerge", () => {
  const merge = (conflictedPaths: string[], messages: { paths: string[]; type: string }[]): MergeTreeResult => ({
    tree: "t",
    clean: conflictedPaths.length === 0,
    conflictedPaths,
    messages: messages.map((m) => ({ ...m, message: "" })),
  });
  const change = (status: string, path: string): DiffEntry => ({ status, path });

  test("sorts, splits added from changed, and ignores the transcript and blobs", () => {
    const r = summarizeMerge([change("M", "b"), change("A", "a"), change("D", "c"), change("M", CHAT_FILE), change("A", "blobs/ab/cd"), change("T", "d")], merge([], []));
    assert.deepEqual(r, { changed: ["b", "c", "d"], added: ["a"], discarded: [], conflicts: [] });
  });

  test("a conflicted path is discarded whatever the kind, and conflicts are listed once per kind", () => {
    const r = summarizeMerge(
      [change("M", "f"), change("A", "g"), change("M", "ok")],
      merge(["f", "g~side", CHAT_FILE], [
        { paths: ["f"], type: "Auto-merging" },
        { paths: ["f"], type: "CONFLICT (contents)" },
        { paths: ["g~side", "g"], type: "CONFLICT (file/directory)" },
        { paths: [CHAT_FILE], type: "CONFLICT (contents)" },
      ]),
    );
    assert.deepEqual(r.discarded, ["f", "g"]);
    assert.deepEqual(r.changed, ["ok"]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.conflicts, [{ path: "f", kind: "content" }, { path: "g", kind: "file/directory" }]);
  });
});

describe(slow("crash during spawn and finish"), slowOptions, () => {
  async function sweep(name: string, setup: (c: Conversation) => Promise<unknown>, act: (c: Conversation, ctx: unknown) => Promise<unknown>): Promise<void> {
    const probeHost = faultyHost(host, Infinity);
    const probe = await fresh({}, probeHost);
    const probeCtx = await setup(probe.convo);
    probeHost.arm(Infinity);
    const base = probeHost.ops;
    await act(probe.convo, probeCtx);
    const total = probeHost.ops - base;
    assert.ok(total >= 5, `${name}: expected several operations, saw ${total}`);

    for (let k = 1; k <= total; k++) {
      const h = faultyHost(host, Infinity);
      const { dir, convo } = await fresh({}, h);
      const ctx = await setup(convo);
      const before = (await convo.readEntries()).length;
      h.arm(k);
      await assert.rejects(act(convo, ctx), (e) => e instanceof Error && /injected fault/.test(e.message), `${name}: operation ${k}/${total} should fail`);
      const trail = h.log.join(" | ");

      const now = Date.now() + 120_000;
      const restarted = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(restarted);
      const after = (await restarted.readEntries()).length;
      assert.ok(after === before || after === before + 1, `${name} @${k}/${total}: ${before} -> ${after} (${trail})`);
      const stray = (await restarted.git.status()).filter((s) => s.path === CHAT_FILE);
      assert.deepEqual(stray, [], `${name} @${k}/${total}: transcript must be committed (${trail})`);
      await restarted.append(user("life goes on"));
      await assertHistoryInvariants(restarted);
    }
  }

  test("spawning a subagent", async () => {
    await sweep("spawn", async (c) => void (await put(c.dir, { "pending.txt": "p\n" })), (c) => c.spawnSubagent({ brief: "b", callId: "c" }));
  });

  test("finishing a subagent", async () => {
    await sweep(
      "finish",
      async (c) => {
        const s = await c.spawnSubagent({ brief: "b", callId: "c" });
        const child = s.conversation as Conversation;
        await put(child.dir, { "child.txt": "c\n" });
        await child.append(reply("done"));
        await put(c.dir, { "parent.txt": "p\n" });
        return child;
      },
      (c, child) => c.finishSubagent(child as Conversation, { summary: "s", callId: "c" }),
    );
  });
});
