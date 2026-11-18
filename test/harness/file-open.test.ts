import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type NewEntry } from "../../harness/conversation.ts";
import { resolveFileOpen } from "../../harness/file-open.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });

/** A project folder with a thread that has `src/a.ts` in two versions, a fork with its own worktree and a fork with none. */
async function project() {
  const dir = join(await tempDir(), "proj");
  const main = await Conversation.create(host, dir, {});
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "one\n");
  const first = await main.append(user("first"));
  await writeFile(join(dir, "src", "a.ts"), "two\n");
  const second = await main.append(user("second"));
  const withTree = await main.fork(second.id, { name: "wt" });
  assert.ok(withTree.conversation !== undefined);
  await writeFile(join(withTree.conversation.dir, "src", "a.ts"), "three, in the fork\n");
  await withTree.conversation.append(user("in the fork"));
  await main.fork(second.id, { checkout: false, name: "bare" });
  return { dir, main, first, second, fork: withTree.conversation };
}

describe("opening a file a message named", () => {
  test("a thread checked out in the project folder is opened there", async () => {
    const { dir, main } = await project();
    const r = await resolveFileOpen(main, host, { thread: main.branch, path: "src/a.ts", line: 4, endLine: 6 });
    assert.deepEqual(r, { kind: "file", path: join(dir, "src", "a.ts"), worktree: dir, line: 4, endLine: 6 });
  });

  test("a thread with a worktree of its own is opened in that worktree, whichever thread the person is looking at", async () => {
    const { dir, main, fork } = await project();
    const r = await resolveFileOpen(main, host, { thread: "wt", path: "src/a.ts" });
    assert.ok(r.kind === "file");
    assert.equal(r.worktree, fork.dir);
    assert.notEqual(r.worktree, dir);
    assert.equal(r.path, join(fork.dir, "src", "a.ts"));
  });

  test("a thread with no worktree is shown read-only from its history, and a worktree made later is used from then on", async () => {
    const { main, second } = await project();
    const r = await resolveFileOpen(main, host, { thread: "bare", path: "src/a.ts", line: 1 });
    assert.deepEqual(r, {
      kind: "snapshot",
      path: "src/a.ts",
      commit: (await main.listBranches()).find((b) => b.name === "bare")?.tip,
      text: "two\n",
      reason: "no-worktree",
      line: 1,
    });
    assert.ok(second.id);
    const opened = await main.openBranch("bare");
    const again = await resolveFileOpen(main, host, { thread: "bare", path: "src/a.ts" });
    assert.ok(again.kind === "file" && again.worktree === opened.dir, "resolved when asked, not when the reference was written");
  });

  test("the file after a change is read from that commit, even when the file has changed since", async () => {
    const { main, first, second } = await project();
    const at1 = await resolveFileOpen(main, host, { thread: main.branch, path: "src/a.ts", at: first.commit });
    assert.ok(at1.kind === "snapshot" && at1.text === "one\n" && at1.reason === "requested");
    const at2 = await resolveFileOpen(main, host, { thread: main.branch, path: "src/a.ts", at: second.commit });
    assert.ok(at2.kind === "snapshot" && at2.text === "two\n");
    const gone = await resolveFileOpen(main, host, { thread: main.branch, path: "src/new.ts", at: first.commit });
    assert.ok(gone.kind === "refused" && /does not exist in .* at /.test(gone.message));
  });

  test("a missing file, a folder, an unknown thread and a path outside the workspace are refused with a reason", async () => {
    const { dir, main } = await project();
    await symlink(tmpOutside(dir), join(dir, "link"));
    const refuse = async (req: { thread: string; path: string }): Promise<string> => {
      const r = await resolveFileOpen(main, host, req);
      assert.ok(r.kind === "refused", JSON.stringify(r));
      return r.message;
    };
    assert.match(await refuse({ thread: main.branch, path: "src/none.ts" }), /does not exist.*deleted or renamed/);
    assert.match(await refuse({ thread: main.branch, path: "src" }), /is a folder/);
    assert.match(await refuse({ thread: "nope", path: "src/a.ts" }), /no thread named nope/);
    assert.match(await refuse({ thread: main.branch, path: "../x" }), /outside the workspace/);
    assert.match(await refuse({ thread: main.branch, path: "/etc/passwd" }), /outside the workspace/);
    assert.match(await refuse({ thread: main.branch, path: ".git/config" }), /cannot be read/);
    assert.match(await refuse({ thread: main.branch, path: "link/secret.txt" }), /outside the workspace|does not exist/);
  });
});

const tmpOutside = (dir: string): string => join(dir, "..");
