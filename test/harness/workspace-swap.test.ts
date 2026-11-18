import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { swapIgnored } from "../../harness/workspace-swap.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const io = { fs: host.fs, path: host.path };

async function put(dir: string, rel: string, text: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), text);
}
const read = (dir: string, rel: string): Promise<string> => readFile(join(dir, rel), "utf8");

describe("swapping ignored entries", () => {
  test("entries both folders have trade places; one-sided ones move across", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, "node_modules/x/index.js", "A-nm");
    await put(b, "node_modules/x/index.js", "B-nm");
    await put(a, "dist/out.js", "A-dist");
    await put(b, ".venv/bin/python", "B-venv");
    const r = await swapIgnored(io, {
      a: { dir: a, ignored: ["node_modules", "dist"] },
      b: { dir: b, ignored: ["node_modules", ".venv"] },
    });
    assert.deepEqual(r.moved, [".venv", "dist", "node_modules"]);
    assert.deepEqual(r.left, []);
    assert.equal(await read(a, "node_modules/x/index.js"), "B-nm");
    assert.equal(await read(b, "node_modules/x/index.js"), "A-nm");
    assert.equal(await read(b, "dist/out.js"), "A-dist");
    assert.equal(await read(a, ".venv/bin/python"), "B-venv");
  });

  test("git's own and the harness's per-folder entries never move", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, ".chattree/env", "A-keys");
    await put(b, ".chattree/env", "B-keys");
    const r = await swapIgnored(io, { a: { dir: a, ignored: [".chattree"] }, b: { dir: b, ignored: [".chattree"] } });
    assert.deepEqual(r.moved, []);
    assert.equal(await read(a, ".chattree/env"), "A-keys");
  });

  test("a name the other folder holds as a tracked entry stays, with the reason", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, "build/o", "ignored here");
    await put(b, "build/src.c", "tracked there");
    const r = await swapIgnored(io, { a: { dir: a, ignored: ["build"] }, b: { dir: b, ignored: [] } });
    assert.deepEqual(r.moved, []);
    assert.equal(r.left[0]?.name, "build");
    assert.equal(await read(a, "build/o"), "ignored here");
    assert.equal(await read(b, "build/src.c"), "tracked there");
  });

  test("undo puts everything back", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, "node_modules/p", "A");
    await put(b, "node_modules/p", "B");
    await put(a, "only-a/f", "fa");
    const r = await swapIgnored(io, { a: { dir: a, ignored: ["node_modules", "only-a"] }, b: { dir: b, ignored: ["node_modules"] } });
    await r.undo();
    await r.undo();
    assert.equal(await read(a, "node_modules/p"), "A");
    assert.equal(await read(b, "node_modules/p"), "B");
    assert.equal(await read(a, "only-a/f"), "fa");
  });

  test("a failure part-way rolls back what was done and is raised", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, "a1/f", "1");
    await put(a, "a2/f", "2");
    let n = 0;
    const fs = {
      ...host.fs,
      rename: async (from: string, to: string) => {
        if (++n === 2) throw new Error("disk on fire");
        await host.fs.rename(from, to);
      },
    };
    await assert.rejects(
      swapIgnored({ fs, path: host.path }, { a: { dir: a, ignored: ["a1", "a2"] }, b: { dir: b, ignored: [] } }),
      /disk on fire/,
    );
    assert.equal(await read(a, "a1/f"), "1");
    assert.equal(await read(a, "a2/f"), "2");
    assert.equal(await host.fs.stat(join(b, "a1")), undefined);
  });

  test("different disks: nothing moves, and it says why", async () => {
    const a = await tempDir();
    const b = await tempDir();
    await put(a, "node_modules/p", "A");
    const fs = {
      ...host.fs,
      rename: async () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
    };
    const r = await swapIgnored({ fs, path: host.path }, { a: { dir: a, ignored: ["node_modules"] }, b: { dir: b, ignored: [] } });
    assert.deepEqual(r.moved, []);
    assert.match(r.left[0]?.reason ?? "", /different disks/);
    assert.equal(await read(a, "node_modules/p"), "A");
  });
});
