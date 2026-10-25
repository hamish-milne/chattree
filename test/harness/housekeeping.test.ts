import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Host, HostProcess } from "../../src/index.ts";
import { CatFileSession } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const bytes = (n: number, seed: number): Uint8Array => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 251);

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h: Host = host) {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(h, dir, opts) };
}
const treeFiles = async (c: Conversation, rev = "HEAD", under = ""): Promise<string[]> => (await c.git.text(["ls-tree", "-r", "--name-only", rev, ...(under === "" ? [] : ["--", under])])).split("\n").filter(Boolean);

describe("gcBlobs", () => {
  test("removes unreferenced blobs, tracked or not, and keeps every referenced one", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("keep me: ".concat("k".repeat(9000)))); // referenced blob
    const kept = await treeFiles(convo, "HEAD", "blobs");
    assert.equal(kept.length, 1);

    // a blob left behind by a failed append, later swept into a commit by the next append
    const swept = await convo.store.put(bytes(5000, 1));
    await convo.append(user("next"));
    assert.ok((await treeFiles(convo, "HEAD", "blobs")).length === 2, "the orphan was committed");
    // and one that is still untracked
    await convo.store.put(bytes(7000, 2));
    // and unrelated pending work that GC must leave alone
    await writeFile(join(dir, "work.txt"), "in progress\n");

    const dry = await convo.gcBlobs({ dryRun: true });
    assert.deepEqual([dry.untracked.length, dry.tracked.length, dry.commit], [1, 1, undefined]);
    assert.deepEqual(dry.tracked.map((o) => o.bytes), [5000]);
    assert.equal((await treeFiles(convo, "HEAD", "blobs")).length, 2, "a dry run changes nothing");

    const head = await convo.git.head();
    const r = await convo.gcBlobs();
    assert.equal(r.untracked.length, 1);
    assert.equal(r.tracked.length, 1);
    assert.deepEqual(await treeFiles(convo, "HEAD", "blobs"), kept);
    assert.ok(!(await exists(join(dir, "blobs", swept.slice(0, 2), swept.slice(2)))));
    const log = await convo.git.log("HEAD", { maxCount: 1 });
    assert.equal(log[0]?.hash, r.commit);
    assert.deepEqual(log[0]?.parents, [head]);
    assert.equal(log[0]?.trailers["Chattree-Gc"]?.[0], "true");
    assert.ok(!(await treeFiles(convo)).includes("work.txt"), "unrelated pending work was not committed");
    assert.equal(await exists(join(dir, "work.txt")), true);
    assert.equal((await convo.gcBlobs()).commit, undefined, "nothing left to collect");

    // history is intact: the old commit still has the orphan, the new tip verifies, and the conversation carries on
    assert.equal((await treeFiles(convo, head!, "blobs")).length, 2);
    await convo.append(user("after gc"));
    assert.deepEqual(await verifyHistory(convo, { deep: true }), []);
    await assertHistoryInvariants(convo);
  });

  test("a conversation with no orphans is untouched", async () => {
    const { convo } = await fresh();
    await convo.append(user("x".repeat(9000)));
    const head = await convo.git.head();
    assert.deepEqual(await convo.gcBlobs(), { untracked: [], tracked: [], commit: undefined });
    assert.equal(await convo.git.head(), head);
  });
});

describe("worktrees", () => {
  async function withSubagents() {
    const { dir, convo } = await fresh();
    await convo.append(user("start"));
    const a = await convo.spawnSubagent({ brief: "a", callId: "a", name: "sub/a" });
    const b = await convo.spawnSubagent({ brief: "b", callId: "b", name: "sub/b" });
    await writeFile(join(a.conversation!.dir, "a.txt"), "a\n");
    await a.conversation!.append(user("working a"));
    await writeFile(join(b.conversation!.dir, "b.txt"), "b\n");
    await b.conversation!.append(user("working b"));
    return { dir, convo, a, b };
  }
  const trees = async (c: Conversation) => (await c.git.worktrees()).map((w) => w.branch);

  test("finishing with removeWorktree leaves the branch and its history but not the directory", async () => {
    const { convo, a } = await withSubagents();
    const out = await convo.finishSubagent(a.conversation!, { summary: "ok", callId: "a", removeWorktree: true });
    assert.equal(await exists(a.conversation!.dir), false);
    assert.ok(!(await trees(convo)).includes("refs/heads/sub/a"));
    assert.ok((await convo.listBranches()).some((b) => b.name === "sub/a"));
    assert.equal(await convo.git.readFileAt(out.childTip, "a.txt").then((x) => x && new TextDecoder().decode(x)), "a\n");
    assert.deepEqual(await verifyHistory(convo, { rev: "sub/a", deep: true }), []);
    assert.equal(await exists(join(convo.dir, "a.txt")), true, "its work is in the trunk");
  });

  test("removeWorktree refuses unmerged or dirty worktrees unless forced, and never the one in use", async () => {
    const { convo, a, b } = await withSubagents();
    await assert.rejects(convo.removeWorktree("sub/b"), /not merged/);
    await assert.rejects(a.conversation!.removeWorktree(a.branch), ConversationError);
    assert.equal(await convo.removeWorktree("sub/nonexistent"), undefined);
    await convo.finishSubagent(a.conversation!, { summary: "ok", callId: "a" });
    await writeFile(join(a.conversation!.dir, "scratch.txt"), "uncommitted\n");
    await assert.rejects(convo.removeWorktree("sub/a"), /uncommitted or untracked/);
    assert.equal(await exists(a.conversation!.dir), true);
    assert.equal(await convo.removeWorktree("sub/a", { force: true }), a.conversation!.dir);
    assert.equal(await exists(a.conversation!.dir), false);
    assert.equal(await convo.removeWorktree("sub/b", { force: true }), b.conversation!.dir, "force also removes an unmerged one");
  });

  test("pruneWorktrees removes what is merged and clean and says why it kept the rest", async () => {
    const { convo, a, b } = await withSubagents();
    const c = await convo.spawnSubagent({ brief: "c", callId: "c", name: "sub/c" });
    await c.conversation!.append(user("working c"));
    await convo.finishSubagent(a.conversation!, { summary: "a", callId: "a" });
    await convo.finishSubagent(c.conversation!, { summary: "c", callId: "c" });
    await writeFile(join(c.conversation!.dir, "leftover.txt"), "x\n");
    const r = await convo.pruneWorktrees();
    assert.deepEqual(r.removed.map((x) => x.branch), ["sub/a"]);
    assert.deepEqual(r.kept.map((x) => x.branch).sort(), ["sub/b", "sub/c"]);
    assert.match(r.kept.find((x) => x.branch === "sub/b")!.reason, /not merged/);
    assert.match(r.kept.find((x) => x.branch === "sub/c")!.reason, /uncommitted/);
    assert.equal(await exists(b.conversation!.dir), true);
    assert.equal(await exists(a.conversation!.dir), false);
  });
});

describe("cleaning up after a crash", () => {
  test("open removes temporary files that would otherwise be committed, and leaves recent or foreign files alone", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("hi"));
    const common = await convo.git.commonDir();
    const old = new Date(Date.now() - 3_600_000);
    const debris = [
      join(dir, "chat.yml.tmp-0123456789ab"),
      join(dir, "harness.yml.tmp-aabbccddeeff"),
      join(dir, "blobs", "ab", "cdef.tmp-0011223344ff"),
      join(common, "chattree", "tmp", "index-123e4567-e89b-12d3-a456-426614174000"),
      join(common, "chattree", "locks", "main.lock.stale-0a1b2c3d"),
    ];
    const recentIndex = join(common, "chattree", "tmp", "index-223e4567-e89b-12d3-a456-426614174000");
    const foreign = [join(dir, "notes.tmp-zzz"), join(dir, "report.tmp-0123456789ab.txt")];
    for (const p of [...debris, recentIndex, ...foreign]) {
      await mkdir(join(p, ".."), { recursive: true });
      await writeFile(p, "x");
    }
    for (const p of debris.slice(3)) await utimes(p, old, old);

    const reopened = await Conversation.open(host, dir);
    assert.equal(reopened.recovery.cleaned.length, 5, reopened.recovery.cleaned.join(", "));
    for (const p of debris) assert.equal(await exists(p), false, p);
    assert.equal(await exists(recentIndex), true, "a recent temporary index might belong to a running process");
    for (const p of foreign) assert.equal(await exists(p), true, "files that are not ours are never touched");

    await reopened.append(user("after"));
    assert.ok(!(await treeFiles(reopened)).some((f) => /\.tmp-[0-9a-f]{12}$/.test(f)), "no debris was committed");
  });

  test("a clean repository reports nothing cleaned", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("x"));
    assert.deepEqual((await Conversation.open(host, dir)).recovery.cleaned, []);
  });
});

describe("processes", () => {
  test("close() ends every cat-file process the handle started, and later requests fail", async () => {
    const exits: Promise<unknown>[] = [];
    let spawned = 0;
    const counting: Host = {
      ...host,
      spawn: async (p, a, o) => {
        const proc = await host.spawn!(p, a, o);
        spawned++;
        exits.push(proc.exit);
        return proc;
      },
    };
    const { convo } = await fresh({}, counting);
    await convo.append(user("x"));
    const sessions = [await convo.git.catFile(), await convo.git.catFile(), await convo.git.catFile()];
    assert.equal(spawned, 3);
    assert.ok((await sessions[0]!.read("HEAD:chat.yml")) !== undefined);
    await convo.close();
    await Promise.all(exits); // every process has ended
    for (const s of sessions) await assert.rejects(s.read("HEAD:chat.yml"), /closed/);
    await convo.close(); // idempotent
    // the handle itself still works and can start new sessions
    const again = await convo.git.catFile();
    assert.ok((await again.read("HEAD:chat.yml")) !== undefined);
    await convo[Symbol.asyncDispose]();
  });

  test("a process that ignores end-of-input is killed", async () => {
    let killed = false;
    let resolveExit!: (v: { exitCode: number; stderr: Uint8Array }) => void;
    const proc: HostProcess = {
      write: async () => undefined,
      closeInput: async () => undefined, // ignored by this "git"
      output: (async function* () {})(),
      kill: () => {
        killed = true;
        resolveExit({ exitCode: 137, stderr: new Uint8Array() });
      },
      exit: new Promise((r) => (resolveExit = r)),
    };
    const s = new CatFileSession(proc, { killAfterMs: 30 });
    await s.close();
    assert.equal(killed, true);
  });

  test("a process that exits on its own is not killed", async () => {
    let killed = false;
    const proc: HostProcess = {
      write: async () => undefined,
      closeInput: async () => undefined,
      output: (async function* () {})(),
      kill: () => void (killed = true),
      exit: Promise.resolve({ exitCode: 0, stderr: new Uint8Array() }),
    };
    await new CatFileSession(proc, { killAfterMs: 30 }).close();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(killed, false);
  });
});
