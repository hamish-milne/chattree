import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git } from "../../src/index.ts";
import {
  ATTACHED_FILE,
  AttachedError,
  discoverAttached,
  formatAttached,
  parseAttached,
  restoreAttached,
  snapshotRepo,
  syncAttached,
  type AttachedState,
} from "../../harness/attached.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const who = { name: "chattree", email: "chattree@localhost.invalid" };
const person = { name: "p", email: "p@p" };

/** A parent repository with the code repository inside it as a real submodule. */
async function rig() {
  const root = await tempDir();
  const codeSrc = join(root, "code-src");
  const code = await Git.init(host, codeSrc, { branch: "main" });
  await writeFile(join(codeSrc, "a.txt"), "one\n");
  await writeFile(join(codeSrc, "gone.txt"), "to be deleted\n");
  await writeFile(join(codeSrc, ".gitignore"), "build/\n");
  await code.add(["."]);
  await code.commit({ message: "c1", author: person, committer: person });

  const dir = join(root, "parent");
  const parent = await Git.init(host, dir, { branch: "main" });
  await writeFile(join(dir, "chat.yml"), "x\n");
  await parent.add(["."]);
  await parent.commit({ message: "init", author: person, committer: person });
  await parent.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", codeSrc, "code"]);
  await parent.commit({ message: "add the code", author: person, committer: person });
  const sub = parent.withCwd(join(dir, "code"));
  return { root, dir, parent, sub, codeDir: join(dir, "code") };
}
const commitIn = async (sub: Git, message: string) => {
  await sub.addAll();
  return sub.commit({ message, author: person, committer: person });
};
const tree = (sub: Git, rev: string) => sub.text(["ls-tree", "-r", "--name-only", rev]);

describe("the record", () => {
  test("is written sorted and read back, and a malformed one is an error", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const states: AttachedState[] = [
      { path: "z", base: a },
      { path: "code", branch: "main", base: b, snapshot: a },
    ];
    const text = formatAttached(states);
    assert.ok(text.indexOf("path: code") < text.indexOf("path: z"));
    assert.deepEqual(parseAttached(text), [states[1], states[0]]);
    assert.equal(formatAttached([]), "");
    assert.deepEqual(parseAttached(""), []);
    for (const bad of ["a: 1", "- path: ../x\n  base: " + a, "- path: x\n  base: nope", "- path: x\n  base: " + a + "\n  snapshot: 12"]) {
      assert.throws(() => parseAttached(bad), AttachedError, bad);
    }
  });
});

describe("what git does with a submodule", () => {
  test("the parent sees none of its uncommitted work, only a commit that moves", async () => {
    const { dir, parent, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "changed\n");
    await writeFile(join(codeDir, "new.txt"), "new\n");
    await parent.addAll();
    assert.deepEqual(await parent.run(["diff", "--cached", "--name-only"]).then((r) => new TextDecoder().decode(r.stdout)), "");
    await commitIn(sub, "c2");
    await parent.addAll();
    assert.equal(await parent.text(["diff", "--cached", "--name-only"]), "code");
    assert.ok(dir);
  });

  test("only checked-out submodules are attached", async () => {
    const { host: _h, ...r } = { host, ...(await rig()) };
    assert.deepEqual(
      (await discoverAttached(host, r.parent)).map((x) => x.path),
      ["code"],
    );
    await rm(join(r.codeDir, ".git"));
    assert.deepEqual(await discoverAttached(host, r.parent), []);
  });
});

describe("snapshots", () => {
  test("a clean repository has none; a changed one gets a commit with everything in it (not ignored files)", async () => {
    const { sub, codeDir } = await rig();
    const clean = await snapshotRepo(host, sub, "code", "main", who);
    assert.equal(clean.snapshot, undefined);
    assert.equal(clean.branch, "main");

    await writeFile(join(codeDir, "a.txt"), "two\n");
    await writeFile(join(codeDir, "new.txt"), "new\n");
    await rm(join(codeDir, "gone.txt"));
    await mkdir(join(codeDir, "build"));
    await writeFile(join(codeDir, "build", "out.js"), "x");
    const dirty = await snapshotRepo(host, sub, "code", "main", who);
    assert.ok(dirty.snapshot !== undefined);
    assert.equal(await tree(sub, dirty.snapshot), [".gitignore", "a.txt", "new.txt"].join("\n"));
    assert.equal(await sub.text(["show", `${dirty.snapshot}:a.txt`]), "two");
    assert.equal(await sub.revParse("refs/chattree/snapshots/main"), dirty.snapshot);
    assert.equal(await sub.revParse("HEAD"), dirty.base, "the person's branch did not move");
    assert.equal((await sub.status()).length, 3, "nor did their index or files: a.txt, gone.txt, new.txt");
  });

  test("the same state again is the same snapshot; a new state chains onto the old one, which stays reachable", async () => {
    const { sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    const first = await snapshotRepo(host, sub, "code", "main", who);
    const again = await snapshotRepo(host, sub, "code", "main", who, first);
    assert.equal(again.snapshot, first.snapshot);
    await writeFile(join(codeDir, "a.txt"), "three\n");
    const next = await snapshotRepo(host, sub, "code", "main", who, again);
    assert.notEqual(next.snapshot, first.snapshot);
    assert.ok(await sub.isAncestor(first.snapshot ?? "", next.snapshot ?? ""));
    assert.equal(await sub.revParse("refs/chattree/snapshots/main"), next.snapshot);
  });

  test("a thread has its own chain", async () => {
    const { sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    const a = await snapshotRepo(host, sub, "code", "main", who);
    const b = await snapshotRepo(host, sub, "code", "other/thread", who);
    assert.equal(await sub.revParse("refs/chattree/snapshots/main"), a.snapshot);
    assert.equal(await sub.revParse("refs/chattree/snapshots/other/thread"), b.snapshot);
  });
});

describe("attached.yml", () => {
  test("is written when something is attached, only rewritten when the state changes, and removed when nothing is", async () => {
    const { dir, parent, codeDir } = await rig();
    const file = join(dir, ATTACHED_FILE);
    const first = await syncAttached(host, parent, "main", who);
    assert.equal(first.changed, true);
    assert.equal(parseAttached(await readFile(file, "utf8"))[0]?.path, "code");
    assert.equal((await syncAttached(host, parent, "main", who)).changed, false);
    await writeFile(join(codeDir, "a.txt"), "dirty\n");
    const dirty = await syncAttached(host, parent, "main", who);
    assert.equal(dirty.changed, true, "uncommitted work alone changes the record, so the parent has something to commit");
    assert.ok(dirty.states[0]?.snapshot !== undefined);
    assert.equal((await syncAttached(host, parent, "main", who)).changed, false);
    await rm(join(codeDir, ".git"));
    assert.equal((await syncAttached(host, parent, "main", who)).changed, true);
    assert.equal(
      await stat(file).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

describe("restoring", () => {
  test("puts the commit, the changes, the new files and the deletions back, leaving them uncommitted", async () => {
    const { parent, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    await writeFile(join(codeDir, "new.txt"), "new\n");
    await rm(join(codeDir, "gone.txt"));
    const { states } = await syncAttached(host, parent, "main", who);
    const recorded = states[0];
    assert.ok(recorded !== undefined);

    // Afterwards the person commits, adds more and changes their mind.
    const lost = await commitIn(sub, "later");
    await writeFile(join(codeDir, "a.txt"), "elsewhere\n");
    await writeFile(join(codeDir, "stray.txt"), "s\n");

    const [result] = await restoreAttached(host, parent, "main", states, who);
    assert.deepEqual(result, { path: "code", restored: "snapshot", warnings: [] });
    assert.equal(await sub.revParse("HEAD"), recorded.base);
    assert.equal(await sub.currentBranch(), "main");
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "two\n");
    assert.equal(await readFile(join(codeDir, "new.txt"), "utf8"), "new\n");
    assert.equal(
      await stat(join(codeDir, "gone.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await stat(join(codeDir, "stray.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    const status = Object.fromEntries((await sub.status()).map((e) => [e.path, e.code]));
    assert.deepEqual(status, { "a.txt": ".M", "gone.txt": ".D", "new.txt": "??" });
    assert.equal(await sub.revParse(`refs/chattree/undone/main/${lost.slice(0, 8)}`), lost, "the commit the branch lost is kept");
    assert.equal((await syncAttached(host, parent, "main", who)).states[0]?.snapshot, recorded.snapshot, "and it is the same state again");
  });

  test("what was there is not lost: it is a snapshot in the chain", async () => {
    const { parent, sub, codeDir } = await rig();
    const { states } = await syncAttached(host, parent, "main", who);
    await writeFile(join(codeDir, "a.txt"), "precious\n");
    await restoreAttached(host, parent, "main", states, who);
    assert.equal(await readFile(join(codeDir, "a.txt"), "utf8"), "one\n");
    const tip = await sub.revParse("refs/chattree/snapshots/main");
    assert.ok(tip !== undefined);
    assert.equal(await sub.text(["show", `${tip}:a.txt`]), "precious");
  });

  test("a snapshot that is gone restores the commit and says so; a missing commit or checkout leaves the repository alone", async () => {
    const { parent, sub, codeDir } = await rig();
    await writeFile(join(codeDir, "a.txt"), "two\n");
    const { states } = await syncAttached(host, parent, "main", who);
    const s = states[0];
    assert.ok(s?.snapshot !== undefined);
    await sub.run(["update-ref", "-d", "refs/chattree/snapshots/main"]);
    await sub.run(["reflog", "expire", "--expire=now", "--all"]);
    await sub.run(["gc", "--prune=now", "--quiet"]);
    const [r] = await restoreAttached(host, parent, "main", [s], who);
    assert.equal(r?.restored, "base");
    assert.match(r?.warnings[0] ?? "", /are not in the repository/);

    const [missing] = await restoreAttached(host, parent, "main", [{ path: "code", base: "f".repeat(40) }], who);
    assert.equal(missing?.restored, "none");
    assert.match(missing?.warnings[0] ?? "", /is not in code/);
    const [absent] = await restoreAttached(host, parent, "main", [{ path: "nope", base: "f".repeat(40) }], who);
    assert.match(absent?.warnings[0] ?? "", /not checked out/);
  });

  test("a detached head is restored detached, and a branch the person deleted is made again", async () => {
    const { parent, sub } = await rig();
    await sub.detach("HEAD");
    const detached = await syncAttached(host, parent, "t", who);
    assert.equal(detached.states[0]?.branch, undefined);
    await sub.switchBranch("main");
    await restoreAttached(host, parent, "t", detached.states, who);
    assert.equal(await sub.currentBranch(), undefined);
    await sub.switchBranch("main");
    const onMain = await syncAttached(host, parent, "t", who);
    await sub.detach("HEAD");
    await sub.deleteBranch("main", { force: true });
    await restoreAttached(host, parent, "t", onMain.states, who);
    assert.equal(await sub.currentBranch(), "main");
  });
});
