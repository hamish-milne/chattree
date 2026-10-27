import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type ExecOptions, type Host } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { CHAT_FILE, Conversation, ConversationError, type EntryRef, type NewEntry } from "../../harness/conversation.ts";
import { ULID_RE } from "../../harness/ulid.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { faultyHost } from "../support/hosts.ts";
import { tempDir } from "../support/tmp.ts";
import { slow, slowOptions } from "../support/slow.ts";

const host = nodeHost();

const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({
  $tag: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  blocks: [{ $tag: "text", text }],
  stop_reason: "end_turn",
});

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h: Host = host): Promise<{ dir: string; convo: Conversation }> {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(h, dir, opts) };
}

/** header, then u1 a1 u2 a2 */
async function talk(convo: Conversation): Promise<string[]> {
  const ids: string[] = [];
  for (const e of [user("first question"), reply("first answer"), user("second question"), reply("second answer")]) ids.push((await convo.append(e)).id);
  return ids;
}

const texts = (entries: Awaited<ReturnType<Conversation["readEntries"]>>): string[] =>
  entries.map((e) => {
    assert.ok(e.ok, JSON.stringify(e.ok ? "" : e.issues));
    const v = e.value;
    if (v.$tag === "user" || v.$tag === "assistant") return (v.$tag === "user" ? v.content : v.blocks).map((b) => ("text" in b ? String(b.text) : b.$tag)).join("|");
    return `<${v.$tag}>`;
  });

describe("entry index", () => {
  test("lists every entry with its commit and offset, oldest first", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const index = await convo.index();
    assert.deepEqual(index.map((r) => r.tag), ["header", "user", "assistant", "user", "assistant"]);
    assert.deepEqual(index.map((r) => r.id), [undefined, ...ids]);
    const log = (await convo.git.log("HEAD")).reverse();
    assert.deepEqual(index.map((r) => r.commit), log.map((l) => l.hash));
    assert.equal(index.at(-1)?.offset, convo.size);
    assert.ok(index.every((r, i) => i === 0 || r.offset > (index[i - 1] as EntryRef).offset));
  });

  test("a handle opened later computes the same index", async () => {
    const { dir, convo } = await fresh();
    await talk(convo);
    const later = await Conversation.open(host, dir);
    assert.deepEqual(await later.index(), await convo.index());
  });

  test("appending extends a built index without another git log", async () => {
    const calls: string[][] = [];
    const counting: Host = { ...host, exec: (p, a: readonly string[], o: ExecOptions) => (calls.push([...a]), host.exec(p, a, o)) };
    const { convo } = await fresh({}, counting);
    await talk(convo);
    await convo.index();
    calls.length = 0;
    const r = await convo.append(user("one more"));
    const index = await convo.index();
    assert.equal(index.at(-1)?.id, r.id);
    assert.equal(index.at(-1)?.commit, r.commit);
    assert.equal(calls.filter((a) => a.includes("log")).length, 0, "no log command was needed");
  });

  test("an index that went stale because another handle appended is extended, not rebuilt wrongly", async () => {
    const { dir, convo } = await fresh();
    await talk(convo);
    const before = await convo.index();
    const other = await Conversation.open(host, dir);
    const r = await other.append(user("from elsewhere"));
    const reopened = await Conversation.open(host, dir);
    assert.equal((await reopened.index()).at(-1)?.id, r.id);
    assert.equal(before.length + 1, (await reopened.index()).length);
  });

  test("findEntry and unknown ids", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    assert.equal((await convo.findEntry(ids[1] as string))?.tag, "assistant");
    assert.equal(await convo.findEntry("01K8ZQ3M0A5G2W7Y9C4T1R6B8D"), undefined);
  });

  test("an empty repository has an empty index", async () => {
    const { convo } = await fresh();
    assert.equal((await convo.index()).length, 1);
  });
});

describe("reading history", () => {
  test("entries up to a ref equal the entries at that commit, and the prefix bytes match git", async () => {
    const { convo } = await fresh();
    await talk(convo);
    for (const ref of await convo.index()) {
      const fast = await convo.readEntriesUpTo(ref);
      const slow = await convo.readEntriesAt(ref.commit);
      assert.deepEqual(fast, slow);
      const bytes = await convo.git.readFileAt(ref.commit, CHAT_FILE);
      assert.equal(bytes?.length, ref.offset);
    }
  });

  test("readEntriesAt works for branch names and for a past commit while the tip has moved on", async () => {
    const { convo } = await fresh();
    await talk(convo);
    const second = (await convo.index())[2] as EntryRef;
    await convo.append(user("later"));
    assert.deepEqual(texts(await convo.readEntriesAt(second.commit)), ["<header>", "first question", "first answer"]);
    assert.equal((await convo.readEntriesAt("main")).length, 6);
    await assert.rejects(convo.readEntriesAt("no-such-rev"));
  });
});

describe("fork", () => {
  test("branches from an earlier entry with a branch_start marker, leaving the original untouched", async () => {
    const { dir, convo } = await fresh();
    const ids = await talk(convo);
    const mainBefore = await convo.readTranscript();
    const forkAt = (await convo.index())[2] as EntryRef; // first answer

    const { branch, start, from, conversation } = await convo.fork(ids[1] as string);
    assert.match(branch, /^fork\/[0-9A-Z]{26}$/);
    assert.equal(from, forkAt.commit);
    assert.ok(conversation !== undefined);
    assert.equal(conversation.branch, branch);
    assert.equal(conversation.dir, `${dir}.branches/${encodeURIComponent(branch)}`);
    assert.equal(await conversation.git.currentBranch(), branch);

    const entries = await conversation.readEntries();
    assert.deepEqual(texts(entries), ["<header>", "first question", "first answer", "<branch_start>"]);
    const marker = entries.at(-1);
    assert.ok(marker?.ok && marker.value.$tag === "branch_start");
    assert.deepEqual(marker.value, { $tag: "branch_start", id: start.id, kind: "fork", from: { branch: "main", commit: forkAt.commit }, context: "inherit" });
    assert.match(start.id, ULID_RE);

    // the start commit sits directly on the fork point and carries the usual trailers
    const [c] = await conversation.git.log(branch, { maxCount: 1 });
    assert.equal(c?.hash, start.commit);
    assert.deepEqual(c?.parents, [forkAt.commit]);
    assert.equal(c?.subject, "branch_start: fork");
    assert.deepEqual(c?.trailers["Chattree-Entry"], [start.id]);
    assert.deepEqual(c?.trailers["Chattree-Offset"], [String(start.offset)]);

    assert.deepEqual(await convo.readTranscript(), mainBefore, "the original branch is unchanged");
    assert.equal(await convo.git.currentBranch(), "main");
    assert.equal(await convo.git.isClean(), true);
    assert.equal(await conversation.git.isClean(), true);
    await assertHistoryInvariants(conversation);
    await assertHistoryInvariants(convo);
  });

  test("the two branches then grow independently", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const { conversation } = await convo.fork(ids[1] as string);
    assert.ok(conversation !== undefined);
    await conversation.append(user("a different second question"));
    await conversation.append(reply("a different answer"));
    await convo.append(user("main goes on"));

    assert.deepEqual(texts(await convo.readEntries()), ["<header>", "first question", "first answer", "second question", "second answer", "main goes on"]);
    assert.deepEqual(texts(await conversation.readEntries()), ["<header>", "first question", "first answer", "<branch_start>", "a different second question", "a different answer"]);
    await assertHistoryInvariants(conversation);
    await assertHistoryInvariants(convo);
    // the shared prefix is the same commits
    const a = (await convo.index()).slice(0, 3).map((r) => r.commit);
    const b = (await conversation.index()).slice(0, 3).map((r) => r.commit);
    assert.deepEqual(a, b);
  });

  test("a fork's index includes the history it was forked from, and it can be forked again", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const { conversation: child } = await convo.fork(ids[1] as string);
    assert.ok(child !== undefined);
    const r = await child.append(user("child question"));
    const index = await child.index();
    assert.deepEqual(index.map((x) => x.tag), ["header", "user", "assistant", "branch_start", "user"]);
    assert.equal(index.at(-1)?.id, r.id);

    const { conversation: grandchild } = await child.fork(ids[0] as string, { name: "deep/er" });
    assert.ok(grandchild !== undefined);
    assert.deepEqual(texts(await grandchild.readEntries()), ["<header>", "first question", "<branch_start>"]);
    const marker = (await grandchild.readEntries()).at(-1);
    assert.ok(marker?.ok && marker.value.$tag === "branch_start");
    assert.equal(marker.value.from.branch, child.branch);
    await assertHistoryInvariants(grandchild);
  });

  test("forking at the tip, by ref, and with a chosen name", async () => {
    const { convo } = await fresh();
    await talk(convo);
    const tip = await convo.fork(undefined, { name: "tip" });
    assert.deepEqual(texts(await (tip.conversation as Conversation).readEntries()).slice(-2), ["second answer", "<branch_start>"]);
    const ref = (await convo.index())[1] as EntryRef;
    const byRef = await convo.fork(ref, { name: "by-ref" });
    assert.equal(byRef.from, ref.commit);
    assert.equal(byRef.conversation?.branch, "by-ref");
  });

  test("the workspace files are those of the fork point", async () => {
    const { dir, convo } = await fresh();
    await writeFile(join(dir, "notes.md"), "version one\n");
    const a = await convo.append(user("write notes"));
    await writeFile(join(dir, "notes.md"), "version two\n");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "later.ts"), "later\n");
    await convo.append(reply("edited"));

    const { conversation } = await convo.fork(a.id);
    assert.ok(conversation !== undefined);
    assert.equal(await readFile(join(conversation.dir, "notes.md"), "utf8"), "version one\n");
    assert.equal((await conversation.git.status()).length, 0);
    await assert.rejects(readFile(join(conversation.dir, "src", "later.ts")));
    await writeFile(join(conversation.dir, "notes.md"), "fork edit\n");
    await conversation.append(user("in the fork"));
    assert.equal(await readFile(join(dir, "notes.md"), "utf8"), "version two\n", "the main worktree is not affected");
  });

  test("without checkout the branch exists but has no worktree, and can be opened later", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const r = await convo.fork(ids[0] as string, { checkout: false, name: "later" });
    assert.equal(r.conversation, undefined);
    const info = (await convo.listBranches()).find((b) => b.name === "later");
    assert.equal(info?.worktree, undefined);
    assert.equal(info?.tip, r.start.commit);
    const opened = await convo.openBranch("later");
    assert.equal(opened.branch, "later");
    assert.deepEqual(texts(await opened.readEntries()), ["<header>", "first question", "<branch_start>"]);
    assert.equal((await convo.listBranches()).find((b) => b.name === "later")?.worktree, opened.dir);
    assert.equal((await convo.openBranch("later")).dir, opened.dir, "opening again reuses the worktree");
  });

  test("listBranches shows every branch, its tip and where it is checked out", async () => {
    const { dir, convo } = await fresh();
    const ids = await talk(convo);
    const a = await convo.fork(ids[0] as string, { name: "a" });
    await convo.fork(ids[1] as string, { name: "b", checkout: false });
    const list = (await convo.listBranches()).sort((x, y) => x.name.localeCompare(y.name));
    assert.deepEqual(list.map((b) => [b.name, b.worktree]), [["a", a.conversation?.dir], ["b", undefined], ["main", dir]]);
    assert.equal(list[2]?.tip, (await convo.index()).at(-1)?.commit);
  });

  test("errors: unknown entry, bad or existing branch name, a worktree path that is taken", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    await assert.rejects(convo.fork("01K8ZQ3M0A5G2W7Y9C4T1R6B8D"), /no such entry/);
    await assert.rejects(convo.fork(ids[0] as string, { name: "bad name" }), ConversationError);
    await assert.rejects(convo.fork(ids[0] as string, { name: "-x" }), ConversationError);
    await assert.rejects(convo.fork(ids[0] as string, { name: "main" }), /already exists/);
    await convo.fork(ids[0] as string, { name: "once" });
    await assert.rejects(convo.fork(ids[0] as string, { name: "once" }), /already exists/);
    await assert.rejects(convo.openBranch("nope"), /no such branch/);

    const taken = join(await tempDir(), "taken");
    await mkdir(taken);
    await writeFile(join(taken, "file"), "x");
    const branchesBefore = (await convo.listBranches()).length;
    const r = convo.fork(ids[0] as string, { name: "blocked", worktree: taken });
    await assert.rejects(r);
    // the branch itself was created (it is a complete, valid branch); only the checkout failed
    assert.equal((await convo.listBranches()).length, branchesBefore + 1);
    const reopened = await convo.openBranch("blocked");
    assert.deepEqual(texts(await reopened.readEntries()).at(-1), "<branch_start>");
  });

  test("several forks at once all succeed and are distinct", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => convo.fork(ids[i % 4] as string)));
    assert.equal(new Set(results.map((r) => r.branch)).size, 4);
    for (const r of results) await assertHistoryInvariants(r.conversation as Conversation);
  });

  test("a fork can be appended to while its parent's branch lock is held", async () => {
    const { convo } = await fresh({ lock: { timeoutMs: 0 } });
    const ids = await talk(convo);
    const { conversation } = await convo.fork(ids[0] as string);
    const { acquireLock } = await import("../../src/index.ts");
    const held = await acquireLock(host.fs, join(convo.dir, ".git", "chattree", "locks", "main.lock"), { timeoutMs: 0 });
    try {
      await conversation?.append(user("independent"));
      await assert.rejects(convo.append(user("blocked")));
    } finally {
      await held.release();
    }
  });

  test("a deleted worktree directory is recovered by pruning, then opening again", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const { conversation, branch } = await convo.fork(ids[0] as string);
    await rm((conversation as Conversation).dir, { recursive: true });
    await convo.git.pruneWorktrees();
    const reopened = await convo.openBranch(branch);
    assert.deepEqual(texts(await reopened.readEntries()), ["<header>", "first question", "<branch_start>"]);
  });
});

describe("mergeFork", () => {
  const files = async (dir: string, names: Record<string, string | null>): Promise<void> => {
    for (const [name, content] of Object.entries(names)) {
      const full = join(dir, name);
      if (content === null) await rm(full, { recursive: true, force: true });
      else {
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content);
      }
    }
  };

  test("merges the fork back and records what was discussed and what changed", async () => {
    const { dir, convo } = await fresh();
    await files(dir, { "plan.md": "plan\n", "shared.md": "a\nb\nc\n" });
    const ids = await talk(convo);
    const parentTipBefore = (await convo.index()).at(-1);
    const { conversation: fork, branch, from } = await convo.fork(ids[1] as string);
    assert.ok(fork !== undefined);

    await files(fork.dir, { "plan.md": "plan, revised in the fork\n", "idea.md": "a new idea\n", "shared.md": "a\nB-fork\nc\n" });
    await fork.append(user("what if we tried something else?"));
    const last = await fork.append(reply("then we decided to revise the plan"));
    await files(dir, { "shared.md": "a\nB-trunk\nc\n" });
    await convo.append(user("meanwhile on the trunk"));

    const out = await convo.mergeFork(fork, { summary: "Revised the plan; added idea.md." });
    assert.deepEqual(out.report.added, ["idea.md"]);
    assert.deepEqual(out.report.changed, ["plan.md"]);
    assert.deepEqual(out.report.discarded, ["shared.md"]);
    assert.deepEqual(out.report.conflicts, [{ path: "shared.md", kind: "content" }]);
    assert.equal(await readFile(join(dir, "plan.md"), "utf8"), "plan, revised in the fork\n");
    assert.equal(await readFile(join(dir, "idea.md"), "utf8"), "a new idea\n");
    assert.equal(await readFile(join(dir, "shared.md"), "utf8"), "a\nB-trunk\nc\n");

    const entry = (await convo.readEntries()).at(-1);
    assert.ok(entry?.ok && entry.value.$tag === "fork_merge");
    assert.deepEqual(entry.value, {
      $tag: "fork_merge",
      id: out.entry.id,
      branch,
      tip: last.commit,
      summary: "Revised the plan; added idea.md.",
      files: { changed: ["plan.md"], added: ["idea.md"], discarded: ["shared.md"] },
      merge: { policy: "trunk", base: from, conflicts: [{ path: "shared.md", kind: "content" }] },
    });
    const [m] = await convo.git.log("HEAD", { maxCount: 1 });
    assert.equal(m?.subject, `fork_merge: ${branch}`);
    assert.deepEqual(m?.trailers["Chattree-Kind"], ["fork_merge"]);
    assert.equal(m?.parents.length, 2);
    assert.equal(m?.parents[1], last.commit);
    assert.notEqual(parentTipBefore?.commit, m?.hash);

    const tags = (await convo.readEntries()).map((e) => (e.ok ? e.tag : "?"));
    assert.deepEqual(tags, ["header", "user", "assistant", "user", "assistant", "user", "fork_merge"]);
    assert.equal((await convo.index()).at(-1)?.tag, "fork_merge");
    await assertHistoryInvariants(convo);
  });

  test("a fork can be merged again after it moves on, and the second report covers only what is new", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const { conversation: fork } = await convo.fork(ids[1] as string);
    assert.ok(fork !== undefined);
    await files(fork.dir, { "one.txt": "1\n" });
    await fork.append(user("first piece"));
    const first = await convo.mergeFork(fork, { summary: "first" });
    assert.deepEqual(first.report.added, ["one.txt"]);
    await assert.rejects(convo.mergeFork(fork, { summary: "again" }), /already merged/);

    await files(fork.dir, { "two.txt": "2\n" });
    await fork.append(user("second piece"));
    const second = await convo.mergeFork(fork, { summary: "second" });
    assert.deepEqual(second.report.added, ["two.txt"], "one.txt was merged before");
    assert.equal(second.report.base, first.childTip);
    await assertHistoryInvariants(convo);
  });

  test("a fork can be merged by name, and conflicting entries stay out of the trunk's transcript", async () => {
    const { convo } = await fresh();
    const ids = await talk(convo);
    const { conversation: fork, branch } = await convo.fork(ids[0] as string);
    await (fork as Conversation).append(user("only in the fork"));
    await convo.mergeFork(branch, { summary: "nothing much" });
    const texts = (await convo.readEntries()).map((e) => (e.ok && e.value.$tag === "user" ? (e.value.content[0] as { text: string }).text : e.ok ? e.tag : "?"));
    assert.ok(!texts.includes("only in the fork"));
    assert.equal(texts.at(-1), "fork_merge");
  });
});

describe(slow("crash during a fork"), slowOptions, () => {
  test("at every step the repository is valid and the new branch either exists complete or not at all", async () => {
    const probeHost = faultyHost(host, Infinity);
    const probe = await fresh({}, probeHost);
    const ids = await talk(probe.convo);
    probeHost.arm(Infinity);
    const base = probeHost.ops;
    await probe.convo.fork(ids[1] as string, { name: "x" });
    const total = probeHost.ops - base;
    assert.ok(total >= 5, `expected several operations, saw ${total}`);

    for (let k = 1; k <= total; k++) {
      const h = faultyHost(host, Infinity);
      const { dir, convo } = await fresh({}, h);
      const fids = await talk(convo);
      h.arm(k);
      await assert.rejects(convo.fork(fids[1] as string, { name: "x" }), (e) => e instanceof Error && /injected fault/.test(e.message));
      const trail = h.log.join(" | ");

      const now = Date.now() + 120_000;
      const restarted = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(restarted);
      const branches = (await restarted.listBranches()).map((b) => b.name).sort();
      assert.ok(branches.length === 1 || branches.length === 2, `@${k}/${total}: ${branches.join(",")} (${trail})`);
      if (branches.includes("x")) {
        const forked = await restarted.openBranch("x");
        assert.deepEqual(texts(await forked.readEntries()), ["<header>", "first question", "first answer", "<branch_start>"], `@${k}/${total} (${trail})`);
        await assertHistoryInvariants(forked);
        await forked.append(user("usable"));
      } else {
        await restarted.fork(fids[1] as string, { name: "x" }); // and a retry then works
      }
    }
  });
});
