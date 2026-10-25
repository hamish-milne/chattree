import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const { fs, path } = host;
const enc = new TextEncoder();
const dec = new TextDecoder();
const node = process.execPath;

describe("exec", () => {
  test("returns output and exit code for any exit code", async () => {
    const cwd = await tempDir();
    const r = await host.exec(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { cwd });
    assert.equal(r.exitCode, 3);
    assert.equal(dec.decode(r.stdout), "out");
    assert.equal(dec.decode(r.stderr), "err");
  });

  test("passes stdin and returns binary output unchanged", async () => {
    const cwd = await tempDir();
    const input = Uint8Array.from({ length: 256 }, (_, i) => i);
    const r = await host.exec(node, ["-e", "process.stdin.pipe(process.stdout)"], { cwd, stdin: input });
    assert.deepEqual(r.stdout, input);
  });

  test("arguments are never interpreted by a shell", async () => {
    const cwd = await tempDir();
    const arg = "a b; echo pwned && $(whoami) `id` \"q\" 'q' *";
    const r = await host.exec(node, ["-e", "process.stdout.write(process.argv[1])", arg], { cwd });
    assert.equal(dec.decode(r.stdout), arg);
  });

  test("env is added to the base environment and overrides it", async () => {
    const cwd = await tempDir();
    const r = await host.exec(node, ["-e", "process.stdout.write(`${process.env.CT_A}|${typeof process.env.PATH}`)"], { cwd, env: { CT_A: "x" } });
    assert.equal(dec.decode(r.stdout), "x|string");
  });

  test("runs in the given directory", async () => {
    const cwd = await tempDir();
    const r = await host.exec(node, ["-e", "process.stdout.write(process.cwd())"], { cwd });
    assert.equal(dec.decode(r.stdout), cwd);
  });

  test("a program that does not exist rejects", async () => {
    await assert.rejects(host.exec("chattree-no-such-program", [], { cwd: await tempDir() }));
  });

  test("output over the limit rejects and stops the process", async () => {
    await assert.rejects(
      host.exec(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(10000)), 1)"], { cwd: await tempDir(), maxOutput: 50_000 }),
      /exceeded/,
    );
  });

  test("a process that ignores its input still completes", async () => {
    const r = await host.exec(node, ["-e", "process.exit(0)"], { cwd: await tempDir(), stdin: new Uint8Array(5_000_000) });
    assert.equal(r.exitCode, 0);
  });

  test("an abort signal stops the process", async () => {
    const ac = new AbortController();
    const p = host.exec(node, ["-e", "setTimeout(() => {}, 60000)"], { cwd: await tempDir(), signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(p);
  });
});

describe("fs", () => {
  test("append creates parents, appends and optionally syncs", async () => {
    const f = path.join(await tempDir(), "a", "b", "log");
    await fs.append(f, enc.encode("one\n"));
    await fs.append(f, enc.encode("two\n"), { sync: true });
    assert.equal(dec.decode(await fs.read(f)), "one\ntwo\n");
  });

  test("readRange returns the requested bytes and stops at the end of the file", async () => {
    const f = path.join(await tempDir(), "f");
    await fs.writeAtomic(f, enc.encode("0123456789"));
    assert.equal(dec.decode(await fs.readRange(f, 2, 3)), "234");
    assert.equal(dec.decode(await fs.readRange(f, 8, 10)), "89");
    assert.equal((await fs.readRange(f, 20, 4)).length, 0);
    await assert.rejects(fs.readRange(path.join(path.dirname(f), "missing"), 0, 1));
  });

  test("writeAtomic replaces content and leaves no temporary files", async () => {
    const dir = await tempDir();
    const f = path.join(dir, "sub", "f");
    await fs.writeAtomic(f, enc.encode("first"));
    await fs.writeAtomic(f, enc.encode("second"));
    assert.equal(dec.decode(await fs.read(f)), "second");
    assert.deepEqual(await fs.readdir(path.join(dir, "sub")), ["f"]);
  });

  test("createExclusive succeeds once", async () => {
    const f = path.join(await tempDir(), "locks", "x.lock");
    assert.equal(await fs.createExclusive(f, enc.encode("a")), true);
    assert.equal(await fs.createExclusive(f, enc.encode("b")), false);
    assert.equal(dec.decode(await fs.read(f)), "a");
  });

  test("createExclusive has exactly one winner among concurrent callers", async () => {
    const f = path.join(await tempDir(), "race.lock");
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => fs.createExclusive(f, enc.encode(String(i)))));
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("truncate shrinks the file", async () => {
    const f = path.join(await tempDir(), "f");
    await fs.append(f, enc.encode("hello world"));
    await fs.truncate(f, 5);
    assert.equal(dec.decode(await fs.read(f)), "hello");
  });

  test("stat, remove, rename, mkdir, readdir", async () => {
    const dir = await tempDir();
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    assert.equal(await fs.stat(a), undefined);
    await fs.append(a, enc.encode("xyz"));
    const st = await fs.stat(a);
    assert.deepEqual({ ...st, mtimeMs: undefined }, { size: 3, isFile: true, isDirectory: false, mtimeMs: undefined });
    assert.ok(typeof st?.mtimeMs === "number" && Math.abs(Date.now() - st.mtimeMs) < 60_000, "mtimeMs is the modification time");
    await fs.rename(a, b);
    assert.equal(await fs.stat(a), undefined);
    await fs.mkdir(path.join(dir, "d", "e"));
    assert.equal((await fs.stat(path.join(dir, "d")))?.isDirectory, true);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["b", "d"]);
    assert.equal(await fs.remove(b), true);
    assert.equal(await fs.remove(b), false);
    assert.equal(await fs.stat(path.join(b, "inside")), undefined, "a path below a missing entry is simply absent");
  });
});
