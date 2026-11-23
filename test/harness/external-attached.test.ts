import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { renameRetrying } from "../support/rename.ts";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git } from "../../src/index.ts";
import { ATTACHED_FILE, externalAttached, parseAttached, pushAttached } from "../../harness/attached.ts";
import { Conversation } from "../../harness/conversation.ts";
import { detachExternal, externalTarget, relinkExternal } from "../../harness/external.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const person = { name: "p", email: "p@p" };
const say = (c: Conversation, text: string) => c.append({ $tag: "user", content: [{ $tag: "text", text }] });
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A conversation and, somewhere else, the code repository, linked in as `code`. */
async function rig() {
  const root = await tempDir();
  const src = join(root, "code-src");
  const code = await Git.init(host, src, { branch: "main" });
  await writeFile(join(src, "a.txt"), "one\n");
  await code.add(["."]);
  await code.commit({ message: "c1", author: person, committer: person });
  const dir = join(root, "conv");
  const convo = await Conversation.create(host, dir, {});
  await convo.linkExternal("code", src);
  return { root, src, dir, convo, link: join(dir, "code") };
}

describe("code linked in from outside the project", () => {
  test("the link is kept out of git, listed, and the code is recorded like a submodule's", async () => {
    const { convo, dir, src, link } = await rig();
    assert.deepEqual(await externalAttached(convo.git), ["code"]);
    assert.equal(await readFile(join(link, "a.txt"), "utf8"), "one\n");
    assert.equal(await convo.git.isClean(), true, "the link is not a change to the project");
    await say(convo, "hello");
    await writeFile(join(src, "a.txt"), "two\n");
    await say(convo, "again");
    const [s] = parseAttached(await readFile(join(dir, ATTACHED_FILE), "utf8"));
    assert.equal(s?.path, "code");
    assert.equal(s?.branch, "main");
    assert.ok(s?.snapshot !== undefined, "the uncommitted work is in the snapshot");
    assert.equal(await convo.git.isClean(), true);
    // Doing it again changes nothing.
    await convo.linkExternal("code", src);
    assert.deepEqual(await externalAttached(convo.git), ["code"]);
  });

  test("rewind puts the linked code back, uncommitted changes included", async () => {
    const { convo, src } = await rig();
    await writeFile(join(src, "a.txt"), "two\n");
    const first = await say(convo, "first");
    await writeFile(join(src, "a.txt"), "three\n");
    await say(convo, "second");
    await convo.rewind(first.commit);
    assert.equal(await readFile(join(src, "a.txt"), "utf8"), "two\n");
  });

  test("a fork has its own checkout of the code, and merging a thread with no commits brings its changes back uncommitted", async () => {
    const { convo, src, dir } = await rig();
    await say(convo, "work");
    const { conversation } = await convo.fork(undefined, { name: "try" });
    assert.ok(conversation !== undefined);
    const theirs = join(conversation.dir, "code");
    assert.ok(await exists(join(theirs, ".git")));
    await writeFile(join(theirs, "b.txt"), "b\n");
    await say(conversation, "in the fork");
    const r = await convo.mergeFork(conversation, { summary: "done" });
    assert.equal(r.code[0]?.outcome, "merged_state");
    assert.equal(await readFile(join(src, "b.txt"), "utf8"), "b\n");
    assert.equal(await convo.git.isClean(), true);
    const [rec] = parseAttached(await readFile(join(dir, ATTACHED_FILE), "utf8"));
    assert.ok(rec?.snapshot !== undefined);
    // The fork's folder can go, with its checkout.
    await convo.git.removeWorktree(conversation.dir).catch(() => undefined);
  });

  test("a code repository that moved is found again by linking it at its new place", async () => {
    const { convo, src, root, link } = await rig();
    await say(convo, "hello");
    const moved = join(root, "elsewhere", "renamed");
    await mkdir(join(root, "elsewhere"));
    await renameRetrying(src, moved);
    assert.equal(await externalTarget(host, convo.git, "code"), undefined, "the old link is dangling");
    await convo.linkExternal("code", moved);
    assert.equal(await readFile(join(link, "a.txt"), "utf8"), "one\n");
    assert.deepEqual(await externalAttached(convo.git), ["code"]);
    await say(convo, "after the move");
    assert.equal(await convo.git.isClean(), true);
  });

  test("a real folder in the way is never replaced, and detaching takes the link and the listing away but not the code", async () => {
    const { convo, src, dir, link } = await rig();
    await detachExternal(host, convo.git, "code");
    assert.deepEqual(await externalAttached(convo.git), []);
    assert.equal(await exists(link), false);
    assert.equal(await exists(join(src, "a.txt")), true, "the code is still there");
    await mkdir(join(dir, "code"));
    await writeFile(join(dir, "code", "mine.txt"), "mine\n");
    await assert.rejects(relinkExternal(host, convo.git, "code", src), /in the way/);
    assert.equal(await exists(join(dir, "code", "mine.txt")), true);
    await assert.rejects(relinkExternal(host, convo.git, "../x", src), /not a name/);
  });

  test("a folder that is not a repository with a commit is refused with what to do", async () => {
    const { convo, root } = await rig();
    const empty = join(root, "empty");
    await Git.init(host, empty, {});
    await assert.rejects(relinkExternal(host, convo.git, "other", empty), /no commits yet/);
    await assert.rejects(relinkExternal(host, convo.git, "other", join(root)), /not in a git repository|no commits/);
  });

  test("pushing sends the code's branch first, says what could not be pushed, and leaves a detached repository alone", async () => {
    const { convo, src, root } = await rig();
    const none = await pushAttached(host, convo.git);
    assert.equal(none[0]?.pushed, false);
    assert.match(none[0]?.note ?? "", /no remote/);
    const bare = join(root, "origin.git");
    await (await Git.open(host, { cwd: root })).run(["init", "--bare", "--quiet", bare]);
    await (await Git.open(host, { cwd: src })).run(["remote", "add", "origin", bare]);
    const sent = await pushAttached(host, convo.git);
    assert.deepEqual(
      sent.map((r) => [r.path, r.pushed]),
      [["code", true]],
    );
    assert.equal((await (await Git.open(host, { cwd: bare })).text(["rev-parse", "main"])).trim().length, 40);
    await (await Git.open(host, { cwd: src })).detach();
    const detached = await pushAttached(host, convo.git);
    assert.match(detached[0]?.note ?? "", /no branch/);
  });

  test("the steps in the guide for moving to a submodule work: nothing is lost, and threads carry on", async () => {
    const { convo, src, dir, root } = await rig();
    await writeFile(join(src, "a.txt"), "uncommitted\n");
    await say(convo, "before");
    const git = convo.git;
    // 1. Stop treating it as linked in: the link, the config entry and the line in info/exclude.
    await rm(join(dir, "code"));
    await git.run(["config", "--local", "--unset-all", "chattree.external"]);
    const exclude = join(dir, ".git", "info", "exclude");
    await writeFile(exclude, (await readFile(exclude, "utf8")).replace("/code\n", ""));
    // 2. Move the repository to where the link was and register it.
    await renameRetrying(src, join(dir, "code"));
    await git.run(["-c", "protocol.file.allow=always", "submodule", "add", join(dir, "code"), "code"]);
    await git.commit({ message: "Attach the code as a submodule", author: person, committer: person });
    assert.equal(await readFile(join(dir, "code", "a.txt"), "utf8"), "uncommitted\n", "the uncommitted work moved with it");
    await say(convo, "after");
    const [s] = parseAttached(await readFile(join(dir, ATTACHED_FILE), "utf8"));
    assert.equal(s?.path, "code");
    assert.ok(s?.snapshot !== undefined);
    const { conversation } = await convo.fork(undefined, { name: "later" });
    assert.ok(conversation !== undefined);
    assert.equal(await readFile(join(conversation.dir, "code", "a.txt"), "utf8"), "uncommitted\n");
    assert.ok(root.length > 0);
  });
});
