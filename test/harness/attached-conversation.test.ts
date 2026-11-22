import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git } from "../../src/index.ts";
import { ATTACHED_FILE, parseAttached } from "../../harness/attached.ts";
import { attachedRule } from "../../harness/attached-note.ts";
import { Conversation } from "../../harness/conversation.ts";
import { injectionContext } from "../../harness/injections.ts";
import { subagentChildRegistry } from "../../harness/subagent.ts";
import { ToolRegistry } from "../../harness/tools.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const person = { name: "p", email: "p@p" };
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const say = (c: Conversation, text: string) => c.append({ $tag: "user", content: [{ $tag: "text", text }] });

/** A conversation whose project folder has the code repository as a real submodule, `code`. */
async function rig() {
  const root = await tempDir();
  const src = join(root, "code-src");
  const code = await Git.init(host, src, { branch: "main" });
  await writeFile(join(src, "a.txt"), "one\n");
  await code.add(["."]);
  await code.commit({ message: "c1", author: person, committer: person });
  const dir = join(root, "conv");
  const convo = await Conversation.create(host, dir, {});
  await convo.git.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", src, "code"]);
  await convo.git.commit({ message: "attach the code", author: person, committer: person });
  const sub = convo.git.withCwd(join(dir, "code"));
  return { root, dir, convo, sub, codeDir: join(dir, "code") };
}

describe("the thread's snapshots hold the code's state", () => {
  test("uncommitted work in an attached repository is recorded, and a clean repository leaves the thread clean", async () => {
    const { convo, dir, codeDir } = await rig();
    await say(convo, "hello");
    assert.equal(await convo.git.isClean(), true);
    await writeFile(join(codeDir, "a.txt"), "two\n");
    assert.equal(await convo.git.isClean(), true, "the parent does not see inside the code");
    await say(convo, "again");
    const [s] = parseAttached(await readFile(join(dir, ATTACHED_FILE), "utf8"));
    assert.ok(s?.snapshot !== undefined);
    assert.equal(s.branch, "main");
    // Nothing changed since: another entry makes no new snapshot and no empty commit.
    await say(convo, "and again");
    assert.equal(await convo.git.isClean(), true);
  });

  test("rewind puts the code back, uncommitted changes included", async () => {
    const { convo, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    await writeFile(join(codeDir, "new.txt"), "new\n");
    const first = await say(convo, "first");
    await sub.addAll();
    await sub.commit({ message: "the person commits", author: person, committer: person });
    await writeFile(join(codeDir, "a.txt"), "three\n");
    await say(convo, "second");

    const r = await convo.rewind(first.commit);
    assert.deepEqual(
      r.attached.map((x) => [x.path, x.restored]),
      [["code", "snapshot"]],
    );
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "two\n");
    assert.equal(await readFile(join(codeDir, "new.txt"), "utf8"), "new\n");
    assert.equal((await sub.status()).length, 2, "uncommitted again");
  });
});

describe("threads and their code", () => {
  test("a fork has its own checkout, detached where the code was, and the project folder's code is not touched", async () => {
    const { convo, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    await say(convo, "work");
    const { conversation, attached } = await convo.fork(undefined, { name: "try" });
    assert.ok(conversation !== undefined);
    assert.deepEqual(
      attached?.map((x) => [x.path, x.restored]),
      [["code", "snapshot"]],
    );
    const there = join(conversation.dir, "code");
    assert.equal(await readFile(join(there, "a.txt"), "utf8"), "two\n");
    assert.equal(await convo.git.withCwd(there).currentBranch(), undefined, "no branch: the thread makes one if it is to commit");

    await writeFile(join(there, "a.txt"), "forked\n");
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "two\n");
    assert.equal(await sub.currentBranch(), "main");

    // Its own snapshots record its own code, on its own branch.
    await say(conversation, "in the fork");
    const [s] = parseAttached(await readFile(join(conversation.dir, ATTACHED_FILE), "utf8"));
    assert.equal(s?.branch, undefined);
    assert.ok(s?.snapshot !== undefined);
  });

  test("removing the fork's worktree removes its checkout too", async () => {
    const { convo } = await rig();
    await say(convo, "work");
    const { conversation } = await convo.fork(undefined, { name: "try" });
    assert.ok(conversation !== undefined);
    const dir = conversation.dir;
    await conversation.close();
    await convo.removeWorktree("try", { force: true });
    assert.equal(await exists(dir), false);
  });

  test("switching the project folder to another thread trades the code with it", async () => {
    const { convo, dir, codeDir } = await rig();
    await say(convo, "work");
    const { conversation } = await convo.fork(undefined, { name: "try" });
    assert.ok(conversation !== undefined);
    const other = conversation.dir;
    await writeFile(join(other, "code", "a.txt"), "the fork's\n");
    await writeFile(join(codeDir, "a.txt"), "the main thread's\n");
    await conversation.close();

    const r = await convo.switchWorkspace("try", { uncommitted: "snapshot" });
    assert.ok(r.attached.length > 0);
    assert.equal(await readFile(join(dir, "code", "a.txt"), "utf8"), "the fork's\n", "the project folder shows the fork's code");
    assert.equal(await readFile(join(other, "code", "a.txt"), "utf8"), "the main thread's\n");
    const project = convo.git.withCwd(join(dir, "code"));
    const moved = convo.git.withCwd(join(other, "code"));
    assert.equal(await project.currentBranch(), undefined);
    assert.equal(await moved.currentBranch(), "main", "the person's branch went with the thread that was on it");

    await convo.switchWorkspace("main", { uncommitted: "snapshot" });
    assert.equal(await readFile(join(dir, "code", "a.txt"), "utf8"), "the main thread's\n");
    assert.equal(await project.currentBranch(), "main");
    assert.equal(await readFile(join(other, "code", "a.txt"), "utf8"), "the fork's\n");
  });

  test("a repository with no attached code behaves as before", async () => {
    const root = await tempDir();
    const convo = await Conversation.create(host, join(root, "conv"), {});
    await say(convo, "hi");
    const { attached } = await convo.fork(undefined, { name: "f" });
    assert.deepEqual(attached, undefined);
    assert.equal(await exists(join(root, "conv", ATTACHED_FILE)), false);
  });
});

const id = { author: person, committer: person };
const commit = async (git: Git, message: string) => {
  await git.addAll();
  return git.commit({ message, ...id });
};
const note = (r: { code: { path: string; outcome: string; note: string; branch?: string }[] }) => r.code[0];

describe("merging a thread's code", () => {
  /** The project's thread has said something, and a fork of it exists with its code checked out. */
  async function forked(opts: { integrate?: "share" | "thread" | "parent" } = {}) {
    const r = await rig();
    await say(r.convo, "work");
    const { conversation } = await r.convo.fork(undefined, { name: "try", ...opts });
    assert.ok(conversation !== undefined);
    const theirs = join(conversation.dir, "code");
    return { ...r, fork: conversation, theirs, theirGit: r.convo.git.withCwd(theirs) };
  }

  test("a thread that made no commits has its code merged like files: its changes arrive uncommitted, and the parent's win a conflict", async () => {
    const { convo, fork, theirs, codeDir } = await forked();
    await writeFile(join(theirs, "a.txt"), "theirs\n");
    await writeFile(join(theirs, "b.txt"), "b\n");
    await say(fork, "in the fork");
    await writeFile(join(codeDir, "a.txt"), "mine\n");
    await say(convo, "in the parent");

    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.outcome, "merged_state");
    assert.match(note(r)?.note ?? "", /a\.txt/);
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "mine\n");
    assert.equal(await readFile(join(codeDir, "b.txt"), "utf8"), "b\n");
    const status = Object.fromEntries((await convo.git.withCwd(codeDir).status()).map((e) => [e.path, e.code]));
    assert.deepEqual(status, { "a.txt": ".M", "b.txt": "??" });
    assert.equal(await convo.git.isClean(), true);
    // The record in the merge commit has the merged state, and the gitlink is the parent's own commit.
    const [rec] = parseAttached(await readFile(join(convo.dir, ATTACHED_FILE), "utf8"));
    assert.ok(rec?.snapshot !== undefined);
    assert.equal(await convo.git.text(["rev-parse", "HEAD:code"]), rec.base);
  });

  test("a thread with nothing changed in the code adds nothing to the merge", async () => {
    const { convo, fork } = await forked();
    await writeFile(join(fork.dir, "note.md"), "x\n");
    await say(fork, "only scratch");
    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.deepEqual(r.code, []);
  });

  test("commits and uncommitted changes together are refused with the commands to fix it, and nothing is written", async () => {
    const { convo, fork, theirs, theirGit } = await forked();
    await writeFile(join(theirs, "a.txt"), "committed\n");
    await commit(theirGit, "c2");
    await writeFile(join(theirs, "a.txt"), "and more\n");
    await say(fork, "both");
    const head = await convo.git.head();
    await assert.rejects(
      convo.mergeFork(fork, { summary: "x" }),
      (e: Error) => /commit the changes/.test(e.message) && /reset /.test(e.message),
    );
    assert.equal(await convo.git.head(), head);
  });

  test("commits fast-forward into a parent with nothing uncommitted", async () => {
    const { convo, fork, theirs, theirGit, sub, codeDir } = await forked();
    await writeFile(join(theirs, "a.txt"), "two\n");
    const c2 = await commit(theirGit, "c2");
    await say(fork, "committed");
    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.outcome, "fast_forward");
    assert.equal(await sub.revParse("HEAD"), c2);
    assert.equal(await sub.currentBranch(), "main");
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "two\n");
    assert.equal(await convo.git.text(["rev-parse", "HEAD:code"]), c2);
    assert.equal(parseAttached(await readFile(join(convo.dir, ATTACHED_FILE), "utf8"))[0]?.base, c2);
  });

  test("commits on a parent that has moved on must be rebased first; once they are, they go in", async () => {
    const { convo, fork, theirs, theirGit, sub, codeDir } = await forked();
    await writeFile(join(theirs, "b.txt"), "b\n");
    await commit(theirGit, "theirs");
    await say(fork, "committed");
    await writeFile(join(codeDir, "a.txt"), "moved on\n");
    await commit(sub, "parent moves");
    await say(convo, "parent committed");

    await assert.rejects(convo.mergeFork(fork, { summary: "x" }), (e: Error) => /rebase main/.test(e.message));
    assert.match((await fork.codeMergeProblem()) ?? "", /rebase main/, "and the thread can be told before it hands back");

    await theirGit.run(["-c", "user.name=t", "-c", "user.email=t@t", "rebase", "main"]);
    await say(fork, "rebased");
    assert.equal(await fork.codeMergeProblem(), undefined);
    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.outcome, "fast_forward");
    assert.equal(await readFile(join(codeDir, "b.txt"), "utf8"), "b\n");
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "moved on\n");
  });

  test("commits are left on a branch when the parent has uncommitted work, and the parent's code is not touched", async () => {
    const { convo, fork, theirs, theirGit, sub, codeDir } = await forked();
    await writeFile(join(theirs, "b.txt"), "b\n");
    const c2 = await commit(theirGit, "theirs");
    await say(fork, "committed");
    await writeFile(join(codeDir, "a.txt"), "uncommitted\n");
    await say(convo, "parent is mid-work");

    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.outcome, "left");
    assert.equal(note(r)?.branch, "chattree/try");
    assert.equal(await sub.revParse("refs/heads/chattree/try"), c2);
    assert.match(note(r)?.note ?? "", /stash/);
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "uncommitted\n");
    assert.equal(await exists(join(codeDir, "b.txt")), false);
    assert.equal(
      await convo.git.text(["rev-parse", "HEAD:code"]),
      parseAttached(await readFile(join(convo.dir, ATTACHED_FILE), "utf8"))[0]?.base,
    );
  });

  test("a thread started to leave its commits for the parent is not fast-forwarded", async () => {
    const { convo, fork, theirs, theirGit } = await forked({ integrate: "parent" });
    await writeFile(join(theirs, "b.txt"), "b\n");
    await commit(theirGit, "theirs");
    await say(fork, "committed");
    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.outcome, "left");
  });

  test("a branch the thread made is the one the commits are left on", async () => {
    const { convo, fork, theirs, theirGit, sub, codeDir } = await forked();
    await theirGit.run(["switch", "-c", "feature/x"]);
    await writeFile(join(theirs, "b.txt"), "b\n");
    await commit(theirGit, "theirs");
    await say(fork, "committed");
    await writeFile(join(codeDir, "a.txt"), "uncommitted\n");
    await say(convo, "mid-work");
    const r = await convo.mergeFork(fork, { summary: "done" });
    assert.equal(note(r)?.branch, "feature/x");
    assert.ok((await sub.revParse("refs/heads/feature/x")) !== undefined);
  });

  test("a commit that nothing points at any more is kept: rewinding to it still works", async () => {
    const { convo, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    const c2 = await commit(sub, "c2");
    const first = await say(convo, "after c2");
    await sub.run(["reset", "--hard", "HEAD~1"]);
    await say(convo, "after the reset");
    await sub.run(["reflog", "expire", "--expire=now", "--all"]);
    await sub.run(["gc", "--prune=now", "--quiet"]);
    const r = await convo.rewind(first.commit);
    assert.equal(r.attached[0]?.restored, "base");
    assert.equal(await sub.revParse("HEAD"), c2);
  });
});

describe("a subagent's merge tool", () => {
  test("hands back unless the code cannot be merged, and then says how to fix it", async () => {
    const tool = subagentChildRegistry(new ToolRegistry([]), [], () => Promise.resolve("rebase it")).get("merge");
    const refused = await tool?.execute({ summary: "done" }, {} as never);
    assert.equal(refused && "is_error" in refused ? refused.is_error : undefined, true);
    assert.match(refused && "content" in refused ? refused.content : "", /Not handed back yet\. rebase it/);
    const fine = await subagentChildRegistry(new ToolRegistry([]), [], () => Promise.resolve(undefined))
      .get("merge")
      ?.execute({ summary: "done" }, {} as never);
    assert.equal(fine && "finish" in fine ? fine.finish : undefined, true);
  });
});

describe("the note about attached repositories", () => {
  const settings = { guidance: true, prefix: "chattree" };
  const ctxOf = (entries: Parameters<typeof injectionContext>[0]) => injectionContext(entries, {} as never, 0);
  const text = async (c: Conversation, entries: Parameters<typeof injectionContext>[0] = []) => {
    const out = await attachedRule(c, settings)(ctxOf(entries));
    return out === undefined || Array.isArray(out) ? undefined : (out as { text: string }).text;
  };

  test("lists the repositories and says the workspace is scratch space; a thread with none is told nothing", async () => {
    const { convo } = await rig();
    const t = await text(convo);
    assert.match(t ?? "", /Attached repository: `code`/);
    assert.match(t ?? "", /scratch space/);
    assert.match(t ?? "", /Commit there only when the user asks/);
    assert.doesNotMatch(t ?? "", /come back|shared with the thread/, "the thread in the project folder has nobody to come back to");
    const bare = await Conversation.create(host, join(await tempDir(), "conv"), {});
    assert.equal(await text(bare), undefined);
  });

  test("the guidance can be left out, and the note is not repeated while it would say the same", async () => {
    const { convo } = await rig();
    const quiet = await attachedRule(convo, { guidance: false, prefix: "chattree" })(ctxOf([]));
    assert.doesNotMatch((quiet as { text: string }).text, /scratch/);
    const first = (await text(convo)) ?? "";
    const entries = [{ $tag: "injection" as const, id: "01ARZ3NDEKTSV4RRFFQ69G0001", key: "attached-repos", text: first }];
    assert.equal(await text(convo, entries), undefined);
  });

  test("a fork is told how its code comes back, by what it was started with", async () => {
    const { convo } = await rig();
    const start = (integrate?: "share" | "thread" | "parent") => [
      {
        $tag: "branch_start" as const,
        id: "01ARZ3NDEKTSV4RRFFQ69G0002",
        kind: "fork" as const,
        from: { branch: "main", commit: "abc" },
        context: "inherit" as const,
        ...(integrate === undefined ? {} : { integrate }),
      },
    ];
    assert.match((await text(convo, start())) ?? "", /leave them uncommitted/);
    assert.match((await text(convo, start("share"))) ?? "", /leave them uncommitted/);
    assert.match((await text(convo, start("thread"))) ?? "", /git switch -c chattree\/.*rebased onto/s);
    assert.match((await text(convo, start("parent"))) ?? "", /for the thread you came from to integrate/);
  });
});
