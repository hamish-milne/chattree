import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { runInit } from "../../app/init.ts";
import { inspectFolder, inspectWorkspace } from "../../app/workspace.ts";
import { Git } from "../../src/index.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const sh = async (cwd: string, args: string[]): Promise<void> => {
  await (await Git.open(host, { cwd })).run(args);
};
const start = async (dir: string, adopt = false) =>
  runInit({ host, cwd: dir, env: { CHATTREE_SETTINGS: join(dir, "s", "settings.yml") }, now: Date.now }, { dir, provider: "none", adopt });

describe("what can be done with a workspace folder", () => {
  test("a plain folder can get a new repository; a repository that has none can be adopted", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "plain"));
    assert.deepEqual((await inspectFolder({ host }, join(dir, "plain"))).state, { kind: "init", mode: "new" });
    const repo = join(dir, "repo");
    const git = await Git.init(host, repo, {});
    await git.setConfig("user.name", "T");
    await git.setConfig("user.email", "t@example.com");
    await writeFile(join(repo, "a.txt"), "a");
    await git.run(["add", "."]);
    await git.run(["commit", "-m", "a"]);
    assert.deepEqual((await inspectFolder({ host }, repo)).state, { kind: "init", mode: "adopt" });
  });

  test("a folder inside a repository without a conversation cannot be started, and says where to", async () => {
    const dir = await tempDir();
    const repo = join(dir, "repo");
    await Git.init(host, repo, {});
    await mkdir(join(repo, "packages", "a"), { recursive: true });
    const f = await inspectFolder({ host }, join(repo, "packages", "a"));
    assert.equal(f.state.kind, "unusable");
    assert.match(f.state.kind === "unusable" ? f.state.reason : "", /inside the git repository .*repo/);
  });

  test("a conversation is found from its folder or from a folder inside it, and listed once", async () => {
    const dir = await tempDir();
    const p = join(dir, "p");
    await start(p);
    await mkdir(join(p, "src"));
    const list = await inspectWorkspace({ host }, [p, join(p, "src")]);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]?.state, { kind: "conversation" });
    assert.equal(list[0]?.root, p);
    assert.equal(list[0]?.name, "p");
  });

  test("a folder that is not there, and a conversation that cannot be opened, are unusable with the reason", async () => {
    const dir = await tempDir();
    const gone = await inspectFolder({ host }, join(dir, "nope"));
    assert.deepEqual(gone.state, { kind: "unusable", reason: "the folder does not exist" });
    const p = join(dir, "p");
    await start(p);
    await writeFile(join(p, "chat.yml"), "- $tag: header\n  format: chatlog\n  major: 1\n  minor: 0\n");
    await sh(p, ["add", "."]);
    await sh(p, ["commit", "-m", "old format", "--no-verify"]);
    const broken = await inspectFolder({ host }, p);
    assert.equal(broken.state.kind, "unusable");
    assert.match(broken.state.kind === "unusable" ? broken.state.reason : "", /no longer reads/);
  });

  test("the list keeps the workspace's order, and a new folder sits beside a conversation", async () => {
    const dir = await tempDir();
    await start(join(dir, "a"));
    await mkdir(join(dir, "b"));
    const list = await inspectWorkspace({ host }, [join(dir, "b"), join(dir, "a")]);
    assert.deepEqual(
      list.map((f) => [f.name, f.state.kind]),
      [
        ["b", "init"],
        ["a", "conversation"],
      ],
    );
  });
});
