import assert from "node:assert/strict";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { conversationsHome, linkNameFor, quickStart } from "../../app/quick-start.ts";
import { inspectFolder } from "../../app/workspace.ts";
import { externalAttached } from "../../harness/attached.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Git } from "../../src/index.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const person = { name: "p", email: "p@p" };

async function rig() {
  const dir = await tempDir();
  const env = { host, cwd: dir, env: { CHATTREE_DATA: join(dir, "data") }, now: Date.now };
  const code = join(dir, "work", "my app");
  const git = await Git.init(host, code, { branch: "main" });
  await writeFile(join(code, "a.txt"), "one\n");
  await git.add(["."]);
  await git.commit({ message: "c1", author: person, committer: person });
  return { dir, env, code, git };
}

describe("quick start", () => {
  test("names: the folder itself is `code`, another path is its name with dashes", () => {
    assert.equal(linkNameFor("."), "code");
    assert.equal(linkNameFor("./"), "code");
    assert.equal(linkNameFor("packages/web app"), "packages-web_app");
    assert.equal(linkNameFor("../x"), "x");
  });

  test("the conversation is kept in the data directory, the code gets nothing, and the link is recorded", async () => {
    const { env, code, git } = await rig();
    const heads = await git.text(["for-each-ref", "refs/heads"]);
    const { project, name } = await quickStart(env, { code, key: "." });
    assert.equal(name, "code");
    assert.ok(project.startsWith(conversationsHome(env)), project);
    assert.equal(await git.text(["for-each-ref", "refs/heads"]), heads, "no branch of ours, no commit on the person's");
    assert.match(await git.text(["for-each-ref", "refs/chattree"]), /refs\/chattree\/snapshots\//, "only a hidden keep-alive ref");
    assert.equal((await git.status()).length, 0);
    assert.equal(await readFile(join(project, "code", "a.txt"), "utf8"), "one\n");
    const pgit = await Git.open(host, { cwd: project });
    assert.deepEqual(await externalAttached(pgit), ["code"]);
    assert.equal(await pgit.isClean(), true);
    const f = await inspectFolder({ host }, code, [{ code, project, name }]);
    assert.equal(f.state.kind, "conversation");
    assert.equal(f.attachedAs, "code");
    // Starting again finds the conversation that is there.
    assert.equal((await quickStart(env, { code, key: "." })).project, project);
  });

  test("a moved repository is found through the record that moved with it, and a missing conversation says so", async () => {
    const { dir, env, code } = await rig();
    const { project, name } = await quickStart(env, { code, key: "." });
    const moved = join(dir, "other", "renamed");
    await mkdir(join(dir, "other"));
    await rename(code, moved);
    const f = await inspectFolder({ host }, moved, [{ code: moved, project, name }]);
    assert.equal(f.state.kind, "conversation", "the folder is found by its new path");
    const gone = await inspectFolder({ host }, moved, [{ code: moved, project: join(dir, "nowhere"), name }]);
    assert.equal(gone.state.kind, "unusable");
    assert.match(gone.state.kind === "unusable" ? gone.state.reason : "", /not there now/);
  });
});
