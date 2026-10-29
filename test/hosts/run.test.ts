import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, sep } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import type { RunSpec } from "../../src/index.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const run = (spec: RunSpec) => (host.run as NonNullable<typeof host.run>)(spec);
const dec = new TextDecoder();
const enc = new TextEncoder();
const node = process.execPath;
/** Running, not merely a zombie that nothing has reaped yet (containers often have no init to do it). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
};

describe("run", () => {
  test("collects stdout and stderr in the order they arrived, with the exit code", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, stages: [[node, "-e", "const w=(s,m)=>new Promise(r=>setTimeout(()=>{s.write(m);r()},60)); (async()=>{await w(process.stdout,'one\\n');await w(process.stderr,'two\\n');await w(process.stdout,'three\\n');process.exit(3)})()"]] });
    assert.equal(dec.decode(r.output), "one\ntwo\nthree\n");
    assert.equal(r.exitCode, 3);
    assert.deepEqual(r.stageCodes, [3]);
    assert.equal(r.timedOut, false);
    assert.equal(r.aborted, false);
  });

  test("starts the program directly: no shell means no expansion", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, stages: [[node, "-e", "console.log(process.argv.slice(1).join('|'))", "$HOME", "*", "a b;c"]] });
    assert.equal(dec.decode(r.output), "$HOME|*|a b;c\n");
  });

  test("a program that does not exist is an outcome with code 127", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, stages: [["definitely-not-a-program-xyz"]] });
    assert.equal(r.exitCode, 127);
    assert.match(dec.decode(r.output), /definitely-not-a-program-xyz: command not found/);
  });

  test("pipes each stage into the next, reports every code, and merges every stage's stderr", async () => {
    const cwd = await tempDir();
    const r = await run({
      cwd,
      stages: [
        [node, "-e", "process.stderr.write('warn\\n'); process.stdout.write('b\\na\\nc\\n'); process.exit(2)"],
        [node, "-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.split('\\n').filter(Boolean).sort().join('\\n')+'\\n'))"],
      ],
    });
    assert.deepEqual(r.stageCodes, [2, 0]);
    assert.equal(r.exitCode, 0);
    const out = dec.decode(r.output);
    assert.match(out, /warn\n/);
    assert.match(out, /a\nb\nc\n/);
  });

  test("feeds stdin to the first stage and can keep stdout apart from the output", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, stdin: enc.encode("hello"), captureStdout: true, stages: [[node, "-e", "process.stdin.on('data',d=>process.stdout.write(String(d).toUpperCase()));process.stderr.write('note')"]] });
    assert.equal(dec.decode(r.stdout ?? new Uint8Array()), "HELLO");
    assert.equal(dec.decode(r.output), "note");
  });

  test("closes stdin when there is none, so a program that reads it ends", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, timeoutMs: 5000, stages: [[node, "-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('eof'))"]] });
    assert.equal(dec.decode(r.output), "eof\n");
  });

  test("a timeout kills the whole process group, not just the child", { skip: process.platform === "win32" && "needs a POSIX sh and process groups" }, async () => {
    const cwd = await tempDir();
    const pidFile = `${cwd}/pid`;
    const r = await run({ cwd, timeoutMs: 400, stages: [["sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`]] });
    assert.equal(r.timedOut, true);
    const pid = Number(dec.decode(await host.fs.read(pidFile)).trim());
    assert.ok(pid > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, "the background sleep survived");
  });

  test("aborting kills the group and says so", async () => {
    const cwd = await tempDir();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const r = await run({ cwd, signal: ac.signal, stages: [["sh", "-c", "sleep 60"]] });
    assert.equal(r.aborted, true);
    assert.ok(Date.now() - t0 < 5000);
    assert.notEqual(r.exitCode, 0);
  });

  test("a signal that is already aborted never runs long", async () => {
    const cwd = await tempDir();
    const ac = new AbortController();
    ac.abort();
    const r = await run({ cwd, signal: ac.signal, stages: [["sh", "-c", "sleep 60"]] });
    assert.equal(r.aborted, true);
  });

  test("keeps only maxOutput bytes and counts the rest", async () => {
    const cwd = await tempDir();
    const r = await run({ cwd, maxOutput: 100, stages: [[node, "-e", "process.stdout.write('x'.repeat(5000))"]] });
    assert.equal(r.output.length, 100);
    assert.equal(r.dropped, 4900);
    assert.equal(r.exitCode, 0);
  });

  test("removes named and pattern-matched variables, keeps the rest, and adds env", async () => {
    const cwd = await tempDir();
    process.env["CT_TEST_SECRET_KEY"] = "s3";
    process.env["CT_TEST_PLAIN"] = "p";
    process.env["CT_TEST_NAMED"] = "n";
    try {
      const r = await run({ cwd, unsetEnv: ["CT_TEST_NAMED"], unsetEnvPattern: "SECRET", env: { CT_TEST_ADDED: "a" }, stages: [[node, "-e", "console.log(['CT_TEST_SECRET_KEY','CT_TEST_PLAIN','CT_TEST_NAMED','CT_TEST_ADDED'].map(k=>process.env[k]??'-').join(','))"]] });
      assert.equal(dec.decode(r.output), "-,p,-,a\n");
    } finally {
      delete process.env["CT_TEST_SECRET_KEY"];
      delete process.env["CT_TEST_PLAIN"];
      delete process.env["CT_TEST_NAMED"];
    }
  });
});

describe("path and file helpers for the tools", () => {
  test("realpath resolves links and says undefined for a missing path", async () => {
    const dir = await tempDir();
    await writeFile(`${dir}/real.txt`, "x");
    await symlink(`${dir}/real.txt`, `${dir}/link.txt`);
    assert.equal(await host.fs.realpath(`${dir}/link.txt`), join(dir, "real.txt"));
    assert.equal(await host.fs.realpath(`${dir}/missing`), undefined);
  });

  test("path ops resolve, relativise and tell absolute from relative", () => {
    assert.equal(host.path.resolve("/a/b", "../c", "d"), resolvePath("/a/c/d"));
    assert.equal(host.path.relative("/a/b", "/a/c"), `..${sep}c`);
    assert.equal(host.path.isAbsolute("/a"), true);
    assert.equal(host.path.isAbsolute("a"), false);
  });

  test("writeAtomic keeps the executable bit when asked to", { skip: process.platform === "win32" && "Windows has no executable bit" }, async () => {
    const dir = await tempDir();
    const file = `${dir}/script.sh`;
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    await host.fs.writeAtomic(file, enc.encode("#!/bin/sh\necho hi\n"), { keepMode: true });
    assert.equal((await stat(file)).mode & 0o777, 0o755);
    await host.fs.writeAtomic(file, enc.encode("plain\n"));
    assert.equal((await stat(file)).mode & 0o111, 0, "without keepMode the file is a fresh, non-executable one");
    await host.fs.writeAtomic(`${dir}/new.txt`, enc.encode("n"), { keepMode: true });
    assert.equal(dec.decode(await host.fs.read(`${dir}/new.txt`)), "n");
  });
});
