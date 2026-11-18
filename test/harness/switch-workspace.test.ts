import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, WorkspaceDirty, type NewEntry } from "../../harness/conversation.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const read = (p: string): Promise<string> => readFile(p, "utf8");
const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );
async function put(file: string, text: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

/** A project folder on `main` and a thread `idea` in its own worktree, each with its own node_modules and a differing tracked file. */
async function rig() {
  const root = await tempDir();
  const dir = join(root, "project");
  const main = await Conversation.create(host, dir);
  await put(join(dir, ".gitignore"), "/.chattree/\nnode_modules/\n");
  await put(join(dir, "a.txt"), "main\n");
  await main.append(user("start"));
  const wt = join(root, "idea");
  const forked = await main.fork(undefined, { name: "idea", worktree: wt });
  const idea = forked.conversation;
  assert.ok(idea !== undefined);
  await put(join(wt, "a.txt"), "idea\n");
  await idea.append(user("work on the idea"));
  await put(join(dir, "node_modules", "p"), "MAIN-NM");
  await put(join(wt, "node_modules", "p"), "IDEA-NM");
  return { root, dir, wt, main, idea };
}
const branchOf = async (c: Conversation, dir: string): Promise<string | undefined> => c.git.withCwd(dir).currentBranch();

describe("Conversation.switchWorkspace", () => {
  test("the folders trade threads, with their files and their ignored files", async () => {
    const { dir, wt, main } = await rig();
    const r = await main.switchWorkspace("idea");
    assert.deepEqual([r.from, r.to, r.fromWorktree], ["main", "idea", wt]);
    assert.equal(await branchOf(main, dir), "idea");
    assert.equal(await branchOf(main, wt), "main");
    assert.equal(await read(join(dir, "a.txt")), "idea\n");
    assert.equal(await read(join(wt, "a.txt")), "main\n");
    assert.equal(await read(join(dir, "node_modules", "p")), "IDEA-NM");
    assert.equal(await read(join(wt, "node_modules", "p")), "MAIN-NM");
    assert.deepEqual(r.moved, ["node_modules"]);
    // and back again
    await main.switchWorkspace("main");
    assert.equal(await branchOf(main, dir), "main");
    assert.equal(await read(join(dir, "node_modules", "p")), "MAIN-NM");
  });

  test("a reopened handle on the project folder is on the new thread and appends there", async () => {
    const { dir, main } = await rig();
    await main.switchWorkspace("idea");
    const reopened = await Conversation.open(host, dir);
    assert.equal(reopened.branch, "idea");
    await reopened.append(user("on idea now"));
  });

  test("ignored: leave keeps node_modules where it is", async () => {
    const { dir, wt, main } = await rig();
    const r = await main.switchWorkspace("idea", { ignored: "leave" });
    assert.deepEqual(r.moved, []);
    assert.equal(await read(join(dir, "node_modules", "p")), "MAIN-NM");
    assert.equal(await read(join(wt, "node_modules", "p")), "IDEA-NM");
  });

  test("harness.yml can choose leave", async () => {
    const { dir, main } = await rig();
    await put(join(dir, "harness.yml"), "workspace:\n  switch:\n    ignored: leave\n");
    await main.snapshot();
    const reader = await Conversation.open(host, dir, { configTrust: "ignore" });
    const r = await reader.switchWorkspace("idea", { uncommitted: "snapshot" });
    assert.deepEqual(r.moved, []);
  });

  test("unsaved changes stop the switch, and are saved as a snapshot on their own thread when asked", async () => {
    const { dir, wt, main, idea } = await rig();
    await put(join(dir, "notes.md"), "not saved\n");
    await assert.rejects(main.switchWorkspace("idea"), (e: unknown) => {
      assert.ok(e instanceof WorkspaceDirty);
      assert.deepEqual(e.files, [{ branch: "main", paths: ["notes.md"] }]);
      return true;
    });
    assert.equal(await branchOf(main, dir), "main", "nothing moved");
    await put(join(wt, "idea-notes.md"), "also not saved\n");
    const r = await main.switchWorkspace("idea", { uncommitted: "snapshot" });
    assert.deepEqual(r.snapshots.map((s) => s.branch).sort(), ["idea", "main"]);
    assert.ok(await main.git.readFileAt("main", "notes.md"), "the snapshot is on main");
    assert.ok(await idea.git.readFileAt("idea", "idea-notes.md"));
    assert.equal(await exists(join(wt, "notes.md")), true, "main's files are in main's new folder");
    assert.equal(await exists(join(dir, "notes.md")), false);
  });

  test("a target without a worktree is checked out in the project folder; the old thread has none", async () => {
    const { dir, main } = await rig();
    await main.git.createBranch("loose", "idea");
    const r = await main.switchWorkspace("loose");
    assert.equal(r.fromWorktree, undefined);
    assert.equal(await branchOf(main, dir), "loose");
    assert.equal((await main.listBranches()).find((b) => b.name === "main")?.worktree, undefined);
  });

  test("refuses the thread already there, a thread that does not exist, and a busy one", async () => {
    const { dir, main } = await rig();
    await assert.rejects(main.switchWorkspace("main"), /already checked out/);
    await assert.rejects(main.switchWorkspace("nope"), /no such thread/);
    const store = await main.leaseStore();
    await store.hold("idea", { pid: 4242 }, main.leaseEnv, "loop", main.now() + 3_600_000);
    await assert.rejects(main.switchWorkspace("idea"), (e: unknown) => e instanceof ConversationError && /held by another/.test(e.message));
    assert.equal(await branchOf(main, dir), "main");
  });

  test("a failure while switching puts the branches and the ignored files back", async () => {
    const { dir, wt, main } = await rig();
    // A stale index lock in the project folder makes git refuse to switch it, after the other folder was already detached.
    await writeFile(join(dir, ".git", "index.lock"), "");
    await assert.rejects(main.switchWorkspace("idea"), /could not switch to idea/);
    await rm(join(dir, ".git", "index.lock"));
    assert.equal(await branchOf(main, dir), "main");
    assert.equal(await branchOf(main, wt), "idea");
    assert.equal(await read(join(dir, "node_modules", "p")), "MAIN-NM");
    assert.equal(await read(join(wt, "node_modules", "p")), "IDEA-NM");
  });
});
