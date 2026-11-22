import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git } from "../../src/index.ts";
import { ATTACHED_FILE, parseAttached } from "../../harness/attached.ts";
import { Conversation } from "../../harness/conversation.ts";
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
  test("a fork has its own checkout on its own branch, starting where the code was, and the project folder's code is not touched", async () => {
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
    assert.equal(await convo.git.withCwd(there).currentBranch(), "chattree/try");

    await writeFile(join(there, "a.txt"), "forked\n");
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "two\n");
    assert.equal(await sub.currentBranch(), "main");

    // Its own snapshots record its own code, on its own branch.
    await say(conversation, "in the fork");
    const [s] = parseAttached(await readFile(join(conversation.dir, ATTACHED_FILE), "utf8"));
    assert.equal(s?.branch, "chattree/try");
    assert.ok(s?.snapshot !== undefined);
  });

  test("removing the fork's worktree removes its checkout too; the code branch stays", async () => {
    const { convo, sub } = await rig();
    await say(convo, "work");
    const { conversation } = await convo.fork(undefined, { name: "try" });
    assert.ok(conversation !== undefined);
    const dir = conversation.dir;
    await conversation.close();
    await convo.removeWorktree("try", { force: true });
    assert.equal(await exists(dir), false);
    assert.ok((await sub.revParse("refs/heads/chattree/try")) !== undefined);
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
    assert.equal(await project.currentBranch(), "chattree/try");
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
    await rm(root, { recursive: true, force: true });
  });
});
