import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Host } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { identity, newRepo } from "../support/tmp.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const who = { name: "Importer", email: "imp@example.com" };

async function repoWithHistory() {
  const git = await newRepo();
  const files: Record<string, string> = {};
  for (let i = 1; i <= 3; i++) {
    files[`f${i}.txt`] = `content ${i}\n`.repeat(i);
    await writeFile(join(git.cwd, `f${i}.txt`), files[`f${i}.txt`] as string);
    await git.addAll();
    await git.commit({ message: `commit ${i}`, author: identity, committer: identity });
  }
  return { git, files };
}

describe("catFile", () => {
  test("a persistent session answers info and read, in order, including missing objects and binary data", async () => {
    const { git } = await repoWithHistory();
    const bin = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    await writeFile(join(git.cwd, "bin"), bin);
    await git.addAll();
    await git.commit({ message: "bin", author: identity, committer: identity });
    const session = await git.catFile();
    try {
      assert.equal(dec.decode(await session.read("HEAD:f2.txt")), "content 2\ncontent 2\n");
      assert.equal((await session.info("HEAD:f3.txt"))?.size, "content 3\n".length * 3);
      assert.equal(await session.read("HEAD:nope"), undefined);
      assert.equal(await session.info("HEAD~9:f1.txt"), undefined);
      assert.deepEqual(await session.read("HEAD:bin"), bin);
      // concurrent requests are answered correctly
      const [a, b, c] = await Promise.all([session.read("HEAD~4:f1.txt"), session.read("HEAD:f1.txt"), session.info("HEAD:bin")]);
      assert.equal(a, undefined);
      assert.equal(dec.decode(b), "content 1\n");
      assert.equal(c?.size, 70_000);
    } finally {
      await session.close();
      await session.close(); // idempotent
    }
    await assert.rejects(session.read("HEAD:f1.txt"), /closed/);
  });

  test("rejects names that could be options or break the protocol", async () => {
    const { git } = await repoWithHistory();
    const session = await git.catFile();
    try {
      for (const bad of ["--help", "a\nb", "a\u0000b", ""]) await assert.rejects(session.read(bad), /invalid object name/);
      assert.equal(dec.decode(await session.read("HEAD:f1.txt")), "content 1\n", "still usable");
    } finally {
      await session.close();
    }
  });

  test("uses one process for any number of requests", async () => {
    const { git } = await repoWithHistory();
    let execs = 0;
    let spawns = 0;
    const base = nodeHost();
    const counting: Host = {
      ...base,
      exec: (p, a, o) => (execs++, base.exec(p, a, o)),
      ...(base.spawn === undefined ? {} : { spawn: (p, a, o) => (spawns++, base.spawn!(p, a, o)) }),
    };
    const { Git } = await import("../../src/index.ts");
    const g = await Git.open(counting, { cwd: git.cwd });
    const before = execs;
    const s = await g.catFile();
    for (let i = 0; i < 50; i++) await s.read("HEAD:f1.txt");
    await s.close();
    assert.equal(spawns, 1);
    assert.equal(execs, before);
  });

  test("falls back to a process per request when the host cannot spawn", async () => {
    const { git } = await repoWithHistory();
    const { Git } = await import("../../src/index.ts");
    const { spawn: _unused, ...noSpawn } = nodeHost();
    const g = await Git.open(noSpawn as Host, { cwd: git.cwd });
    const s = await g.catFile();
    assert.equal(dec.decode(await s.read("HEAD:f1.txt")), "content 1\n");
    assert.equal((await s.info("HEAD:f1.txt"))?.type, "blob");
    assert.equal(await s.read("HEAD:missing"), undefined);
    await s.close();
  });
});

describe("importCommits", () => {
  test("writes a chain of commits in one process and moves the ref once", async () => {
    const { git } = await repoWithHistory();
    const parent = await git.head();
    const branch = (await git.currentBranch()) as string;
    const hashes = await git.importCommits(`refs/heads/${branch}`, parent, [
      { message: "one", trailers: [["T-Key", "1"]], author: who, committer: who, date: "2026-01-02T03:04:05Z", files: [{ path: "chat.yml", data: enc.encode("v1\n") }] },
      { message: "two", author: who, committer: who, date: "2026-01-02T03:04:06Z", files: [{ path: "chat.yml", data: enc.encode("v2\n") }, { path: "blobs/ab/cd", data: new Uint8Array([0, 1, 2, 255]) }] },
    ]);
    assert.equal(hashes.length, 2);
    assert.equal(await git.head(), hashes[1]);
    const log = await git.log("HEAD", { firstParent: true });
    assert.deepEqual(log.slice(0, 3).map((c) => c.hash), [hashes[1], hashes[0], parent]);
    assert.equal(log[1]?.trailers["T-Key"]?.[0], "1");
    assert.equal(dec.decode(await git.readFileAt(hashes[0] as string, "chat.yml")), "v1\n");
    assert.equal(dec.decode(await git.readFileAt(hashes[1] as string, "chat.yml")), "v2\n");
    assert.deepEqual(await git.readFileAt(hashes[1] as string, "blobs/ab/cd"), new Uint8Array([0, 1, 2, 255]));
    assert.equal(dec.decode(await git.readFileAt(hashes[1] as string, "f1.txt")), "content 1\n", "the rest of the parent's tree is kept");
    assert.equal(await git.readFileAt(hashes[0] as string, "blobs/ab/cd"), undefined);
    assert.equal(log[0]?.authorName, "Importer");
    // after syncing the index the repository is clean
    await git.syncIndex();
    const status = (await git.status()).filter((e) => e.path !== "chat.yml" && !e.path.startsWith("blobs"));
    assert.deepEqual(status, []);
  });

  test("can start a branch with no parent, and leaves the ref alone on bad input", async () => {
    const { git } = await repoWithHistory();
    const [h] = await git.importCommits("refs/heads/orphan", undefined, [{ message: "root", author: who, committer: who, files: [{ path: "x", data: enc.encode("x") }] }]);
    assert.equal(await git.revParse("refs/heads/orphan"), h);
    assert.equal((await git.log("refs/heads/orphan")).length, 1);
    const before = await git.head();
    const branch = (await git.currentBranch()) as string;
    await assert.rejects(git.importCommits(`refs/heads/${branch}`, before, [{ message: "bad", author: who, committer: who, files: [{ path: "../escape", data: new Uint8Array() }] }]), /unsupported path/);
    await assert.rejects(git.importCommits(`refs/heads/${branch}`, before, [{ message: "bad", author: { name: "a<b", email: "x@y" }, committer: who, files: [] }]), /identity/);
    await assert.rejects(git.importCommits("--evil", before, [{ message: "m", author: who, committer: who, files: [] }]));
    assert.equal(await git.head(), before);
  });

  test("handles empty and large input", async () => {
    const { git } = await repoWithHistory();
    assert.deepEqual(await git.importCommits("refs/heads/z", undefined, []), []);
    const big = new Uint8Array(3_000_000).fill(97);
    const [h] = await git.importCommits("refs/heads/big", await git.head(), [{ message: "big", author: who, committer: who, files: [{ path: "big.bin", data: big }] }]);
    assert.equal((await git.objectInfo([`${h}:big.bin`]))[0]?.size, 3_000_000);
  });
});

describe("catFile close", () => {
  test("requests already made are answered before the session closes", async () => {
    const { git } = await repoWithHistory();
    const s = await git.catFile();
    const pending = Array.from({ length: 20 }, () => s.read("HEAD:f1.txt"));
    await s.close();
    for (const p of pending) assert.equal(dec.decode(await p), "content 1\n");
  });
});
