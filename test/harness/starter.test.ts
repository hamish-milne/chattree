import assert from "node:assert/strict";
import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { MemoryBlobStore } from "../../src/index.ts";
import { PathRefused, applyEdit, expandEnv, expandGlob, GlobError, leafTools, resolveInWorkspace } from "../../harness/starter/index.ts";
import { expandBraces } from "../../harness/starter/glob.ts";
import { ToolRegistry, isStarted, type ToolContext, type ToolOutput } from "../../harness/tools.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const node = process.execPath;
const text = (r: ToolOutput | { started: unknown }): ToolOutput => {
  assert.equal(isStarted(r as ToolOutput), false);
  return r as ToolOutput;
};

async function workspace(files: Record<string, string> = {}) {
  const dir = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  const blobs = new MemoryBlobStore();
  const registry = new ToolRegistry(leafTools({ env: { allow: ["CT_ALLOWED"], values: { CT_ALLOWED: "yes", CT_OTHER: "no" } } }));
  const ctx = (signal = new AbortController().signal): ToolContext => ({ signal, callId: "c1", workspace: dir, host, blobs });
  const call = async (name: string, args: unknown, signal?: AbortSignal): Promise<ToolOutput> => {
    const checked = registry.check({ name, args });
    if ("error" in checked) throw new Error(checked.error);
    return text(await checked.tool.execute(checked.args, ctx(signal)));
  };
  return { dir, blobs, call, registry };
}

describe("the starter tools are valid registry entries", () => {
  test("all five register, with portable schemas, and a bad call is caught before it runs", async () => {
    const { registry } = await workspace();
    assert.deepEqual(registry.names(), ["edit", "read", "run", "script", "write"]);
    assert.match((registry.check({ name: "read", args: { files: [{ path: "a", bogus: 1 }] } }) as { error: string }).error, /bogus is not a known argument/);
    assert.match((registry.check({ name: "run", args: { argv: [] } }) as { error: string }).error, /argv needs at least 1 item/);
  });
});

describe("the workspace boundary", () => {
  test("accepts paths inside, relative or absolute, and new files in new directories", async () => {
    const { dir } = await workspace({ "src/a.txt": "x" });
    assert.equal(await resolveInWorkspace(host, dir, "src/a.txt", "read"), join(dir, "src/a.txt"));
    assert.equal(await resolveInWorkspace(host, dir, join(dir, "src/a.txt"), "write"), join(dir, "src/a.txt"));
    assert.equal(await resolveInWorkspace(host, dir, "new/deep/file.txt", "write"), join(dir, "new/deep/file.txt"));
    assert.equal(await resolveInWorkspace(host, dir, "src/../src/a.txt", "read"), join(dir, "src/a.txt"));
  });

  test("refuses .. and absolute paths that leave, and links that lead out, for reads and writes", async () => {
    const { dir } = await workspace();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "s");
    await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
    await symlink(outside, join(dir, "linkdir"));
    for (const p of ["../x", "a/../../x", outside, join(outside, "secret.txt"), "link.txt", "linkdir/secret.txt", "linkdir/new.txt", "linkdir/sub/new.txt"]) {
      for (const mode of ["read", "write"] as const) await assert.rejects(resolveInWorkspace(host, dir, p, mode), (e) => e instanceof PathRefused && /outside the workspace/.test(e.message), `${p} (${mode})`);
    }
    await assert.rejects(resolveInWorkspace(host, dir, "", "read"), PathRefused);
    await assert.rejects(resolveInWorkspace(host, dir, "a\0b", "read"), PathRefused);
  });

  test("the conversation, its config, git's files, local state and blobs cannot be written; git and local state cannot be read", async () => {
    const { dir } = await workspace({ "chat.yml": "x", "harness.yml": "x", ".git/config": "x", ".chattree/env": "K=v", "blobs/ab/cd": "x" });
    for (const p of ["chat.yml", "harness.yml", ".git/config", ".git/hooks/pre-commit", ".chattree/env", "blobs/ab/cd", "blobs/new"]) {
      await assert.rejects(resolveInWorkspace(host, dir, p, "write"), (e) => e instanceof PathRefused && /cannot be written/.test(e.message), p);
    }
    for (const p of [".git/config", ".chattree/env"]) await assert.rejects(resolveInWorkspace(host, dir, p, "read"), (e) => e instanceof PathRefused && /cannot be read/.test(e.message), p);
    assert.equal(await resolveInWorkspace(host, dir, "chat.yml", "read"), join(dir, "chat.yml"));
    assert.equal(await resolveInWorkspace(host, dir, "blobs/ab/cd", "read"), join(dir, "blobs/ab/cd"));
  });
});

describe("read", () => {
  test("numbers the lines under a header, and a window says where to continue", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const { call } = await workspace({ "a.txt": lines, "b.txt": "only\n" });
    const whole = await call("read", { files: [{ path: "b.txt" }] });
    assert.equal(whole.content, "=== b.txt (1 line) ===\n1\tonly");
    const part = await call("read", { files: [{ path: "a.txt", offset: 2, limit: 3 }] });
    assert.equal(part.content, "=== a.txt (lines 3-5 of 12) ===\n3\tline 3\n4\tline 4\n5\tline 5\n... 7 more lines; read again with offset 5 for the rest");
    const tail = await call("read", { files: [{ path: "a.txt", offset: 9 }] });
    assert.match(tail.content, /lines 10-12 of 12/);
    assert.match(tail.content, /^ ?10\tline 10$/m.source.replace("^ ?", "") ? /10\tline 10/ : /x/);
    assert.doesNotMatch(tail.content, /more lines/);
  });

  test("reads several files, and one failing does not stop the others", async () => {
    const { dir, call } = await workspace({ "ok.txt": "fine\n", "empty.txt": "", "bin.dat": "a\0b", "sub/x.txt": "x" });
    await writeFile(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const r = await call("read", { files: [{ path: "ok.txt" }, { path: "missing.txt" }, { path: "empty.txt" }, { path: "bin.dat" }, { path: "latin.txt" }, { path: "../x" }, { path: "ok.txt", offset: 5 }, { path: "sub" }, { path: ".git/config" }] });
    assert.equal(r.is_error, false, "at least one file was read");
    assert.match(r.content, /=== ok.txt \(1 line\) ===\n1\tfine/);
    assert.match(r.content, /=== missing.txt: no such file ===/);
    assert.match(r.content, /=== empty.txt \(empty file\) ===/);
    assert.match(r.content, /=== bin.dat: a binary file ===/);
    assert.match(r.content, /=== latin.txt: not UTF-8 text ===/);
    assert.match(r.content, /=== \.\.\/x: \.\.\/x is outside the workspace ===/);
    assert.match(r.content, /=== ok.txt: only 1 lines; offset 5 is past the end ===/);
    assert.match(r.content, /=== sub\/ \(1 entries\) ===\nx.txt/);
    assert.match(r.content, /=== \.git\/config: \.git\/config cannot be read ===/);
    assert.equal((await call("read", { files: [{ path: "missing.txt" }] })).is_error, true);
  });

  test("lists a directory with its subdirectories marked, and reads stored output by its blob address", async () => {
    const { call, blobs } = await workspace({ "d/a.txt": "1", "d/sub/b.txt": "2" });
    assert.equal((await call("read", { files: [{ path: "d" }] })).content, "=== d/ (2 entries) ===\na.txt\nsub/");
    const hash = await blobs.put(new TextEncoder().encode("stored\nresult\n"));
    assert.equal((await call("read", { files: [{ path: `blob:${hash}` }] })).content, `=== blob:${hash} (2 lines) ===\n1\tstored\n2\tresult`);
    assert.match((await call("read", { files: [{ path: `blob:${"0".repeat(64)}` }] })).content, /no such blob/);
    assert.match((await call("read", { files: [{ path: "blob:xyz" }] })).content, /64 hex digits/);
  });

  test("refuses a file too large to read whole, and says what to do", async () => {
    const { dir, call } = await workspace();
    await writeFile(join(dir, "big.txt"), Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    assert.match((await call("read", { files: [{ path: "big.txt" }] })).content, /too large to read whole; use run with head, tail or grep/);
  });
});

describe("write", () => {
  test("creates files and directories, replaces files, and keeps the executable bit", async () => {
    const { dir, call } = await workspace({ "old.txt": "12345" });
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    const r = await call("write", { files: [{ path: "new/deep/a.txt", content: "héllo" }, { path: "old.txt", content: "x" }, { path: "run.sh", content: "#!/bin/sh\necho\n" }] });
    assert.equal(r.is_error, undefined);
    assert.equal(r.content, "created new/deep/a.txt (6 bytes)\nreplaced old.txt (1 bytes, was 5)\nreplaced run.sh (15 bytes, was 10)");
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "new/deep/a.txt"))), "héllo");
    assert.equal((await stat(join(dir, "run.sh"))).mode & 0o777, 0o755);
  });

  test("stops at the first failure and says what was written and what was not", async () => {
    const { dir, call } = await workspace({ "d/x": "x" });
    const r = await call("write", { files: [{ path: "one.txt", content: "1" }, { path: "d", content: "x" }, { path: "three.txt", content: "3" }, { path: "four.txt", content: "4" }] });
    assert.equal(r.is_error, true);
    assert.equal(r.content, "created one.txt (1 bytes)\nfailed: d: d is a directory; the other 2 files were not written");
    assert.equal(await host.fs.stat(join(dir, "three.txt")), undefined);
    const refused = await call("write", { files: [{ path: "chat.yml", content: "x" }] });
    assert.equal(refused.is_error, true);
    assert.match(refused.content, /failed: chat.yml: chat.yml is part of the conversation or its configuration and cannot be written/);
  });
});

describe("edit", () => {
  const apply = (original: string, edit: Partial<Parameters<typeof applyEdit>[1]>) => applyEdit(original, { path: "f", content: "", ...edit });

  test("replaces what lies between the anchors and keeps them", () => {
    const src = "function a() {\n  old();\n}\nfunction b() {}\n";
    assert.equal(apply(src, { after: "function a() {\n", before: "}\nfunction b", content: "  fresh();\n" }).text, "function a() {\n  fresh();\n}\nfunction b() {}\n");
  });

  test("an omitted anchor means the start or the end of the file", () => {
    assert.equal(apply("one\ntwo\nthree\n", { before: "three", content: "ONE\nTWO\n" }).text, "ONE\nTWO\nthree\n");
    assert.equal(apply("one\ntwo\nthree\n", { after: "one\n", content: "rest\n" }).text, "one\nrest\n");
    assert.equal(apply("one", { content: "all" }).text, "all");
    assert.equal(apply("one", { after: "", before: "", content: "all" }).text, "all", "empty anchors count as omitted");
  });

  test("insert adds after or before the one anchor and replaces nothing", () => {
    assert.equal(apply("a\nb\n", { mode: "insert", after: "a\n", content: "X\n" }).text, "a\nX\nb\n");
    assert.equal(apply("a\nb\n", { mode: "insert", before: "b", content: "X\n" }).text, "a\nX\nb\n");
    assert.throws(() => apply("a", { mode: "insert", content: "x" }), /exactly one of/);
    assert.throws(() => apply("a b", { mode: "insert", after: "a", before: "b", content: "x" }), /exactly one of/);
  });

  test("an anchor that is missing or matches more than once fails, naming the lines", () => {
    assert.throws(() => apply("a\nb\n", { after: "zzz", content: "x" }), /`after` "zzz" was not found/);
    assert.throws(() => apply("x\ny\nx\nz\nx\n", { after: "x", content: "q" }), /`after` "x" occurs 3 times \(lines 1, 3, 5\); make it longer/);
    assert.throws(() => apply("a b", { after: "b", before: "a", content: "x" }), /`before` occurs before the end of `after`/);
    assert.throws(() => apply("a", { before: "x".repeat(100), content: "x" }), /\.\.\./);
  });

  test("a file with CRLF line endings keeps them", () => {
    assert.equal(apply("a\r\nb\r\nc\r\n", { after: "a\n", before: "c", content: "X\nY\n" }).text, "a\r\nX\r\nY\r\nc\r\n");
  });

  test("applies a list in order to files on disk, and stops at the first failure", async () => {
    const { dir, call } = await workspace({ "a.txt": "alpha\nbeta\n", "b.txt": "one\n" });
    const ok = await call("edit", { edits: [{ path: "a.txt", after: "alpha\n", content: "gamma\n", mode: "insert" }, { path: "a.txt", before: "beta", after: "gamma\n", content: "" }] });
    assert.equal(ok.is_error, undefined);
    assert.match(ok.content, /edited a.txt: inserted 6 characters at line 2\nedited a.txt: replaced 0 characters with 0/);
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "alpha\ngamma\nbeta\n");
    const bad = await call("edit", { edits: [{ path: "b.txt", before: "one", content: "zero\n", mode: "insert" }, { path: "b.txt", after: "nope", content: "x" }, { path: "a.txt", content: "z" }] });
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /edited b.txt: inserted/);
    assert.match(bad.content, /failed: edit 2 \(b.txt\): `after` "nope" was not found in the file; the other 1 edit was not applied/);
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "alpha\ngamma\nbeta\n");
    assert.match((await call("edit", { edits: [{ path: "missing.txt", content: "x" }] })).content, /does not exist \(use write to create it\)/);
    assert.match((await call("edit", { edits: [{ path: "harness.yml", content: "x" }] })).content, /cannot be written/);
  });
});

describe("glob", () => {
  async function tree() {
    return workspace({ "a.ts": "", "b.ts": "", "c.js": "", ".hidden.ts": "", "src/x.ts": "", "src/y.js": "", "src/deep/z.ts": "", "src/.dot/w.ts": "", "docs/readme.md": "" });
  }

  test("braces expand, and a lone {x} stays literal", () => {
    assert.deepEqual(expandBraces("a{b,c}d"), ["abd", "acd"]);
    assert.deepEqual(expandBraces("{a,b{1,2}}"), ["a", "b1", "b2"]);
    assert.deepEqual(expandBraces("{x}"), ["{x}"]);
    assert.deepEqual(expandBraces("plain"), ["plain"]);
  });

  test("matches * ? classes and braces within a directory, sorted, and skips dot files", async () => {
    const { dir } = await tree();
    assert.deepEqual(await expandGlob(host, dir, "*.ts"), ["a.ts", "b.ts"]);
    assert.deepEqual(await expandGlob(host, dir, "?.{ts,js}"), ["a.ts", "b.ts", "c.js"]);
    assert.deepEqual(await expandGlob(host, dir, "[ab].ts"), ["a.ts", "b.ts"]);
    assert.deepEqual(await expandGlob(host, dir, "[!a].ts"), ["b.ts"]);
    assert.deepEqual(await expandGlob(host, dir, ".*.ts"), [".hidden.ts"]);
    assert.deepEqual(await expandGlob(host, dir, "src/*"), ["src/deep", "src/x.ts", "src/y.js"]);
    assert.deepEqual(await expandGlob(host, dir, "nothing*"), []);
  });

  test("** crosses directories, including none, and never enters dot directories", async () => {
    const { dir } = await tree();
    assert.deepEqual(await expandGlob(host, dir, "**/*.ts"), ["a.ts", "b.ts", "src/deep/z.ts", "src/x.ts"]);
    assert.deepEqual(await expandGlob(host, dir, "src/**/*.ts"), ["src/deep/z.ts", "src/x.ts"]);
  });

  test("patterns stay inside the workspace, and links that lead out are not followed", async () => {
    const { dir } = await tree();
    const outside = await tempDir();
    await writeFile(join(outside, "o.ts"), "");
    await symlink(outside, join(dir, "out"));
    await assert.rejects(expandGlob(host, dir, "../*"), GlobError);
    await assert.rejects(expandGlob(host, dir, "/etc/*"), GlobError);
    assert.deepEqual(await expandGlob(host, dir, "out/*"), []);
    assert.ok(!(await expandGlob(host, dir, "**/*.ts")).some((p) => p.includes("out")));
  });
});

describe("run", () => {
  test("starts the program directly: nothing is expanded, and the result begins with the exit code", async () => {
    const { call } = await workspace();
    const r = await call("run", { argv: [node, "-e", "console.log(process.argv.slice(1).join('|'))", "*.ts", "a;b", "x|y", ">out"] });
    assert.equal(r.content, "exit 0\n*.ts|a;b|x|y|>out");
    assert.equal(r.is_error, false);
    const fail = await call("run", { argv: [node, "-e", "console.error('bad'); process.exit(4)"] });
    assert.equal(fail.content, "exit 4\nbad");
    assert.equal(fail.is_error, true);
    assert.equal((await call("run", { argv: [node, "-e", ""] })).content, "exit 0\n(no output)");
    assert.match((await call("run", { argv: ["no-such-program-xyz"] })).content, /exit 127\nno-such-program-xyz: command not found/);
  });

  test("pipes, reads stdin from a file and writes or appends stdout to a file", async () => {
    const { dir, call } = await workspace({ "in.txt": "b\na\n" });
    const sort = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.split('\\n').filter(Boolean).sort().join('\\n')+'\\n'))";
    const r = await call("run", { argv: [node, "-e", "process.stdin.pipe(process.stdout)"], stdin: "in.txt", pipe_to: [[node, "-e", sort]] });
    assert.equal(r.content, "exit 0 (stages: 0, 0)\na\nb");
    const w = await call("run", { argv: [node, "-e", "console.log('first')"], stdout: "out/log.txt" });
    assert.equal(w.content, "exit 0\n(no output)\nstdout written to out/log.txt (6 bytes)");
    await call("run", { argv: [node, "-e", "console.log('second')"], stdout: "out/log.txt", append: true });
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "out/log.txt"))), "first\nsecond\n");
    assert.match((await call("run", { argv: [node, "-e", ""], stdout: "chat.yml" })).content, /cannot be written/);
    assert.match((await call("run", { argv: [node, "-e", ""], stdin: "../x" })).content, /outside the workspace/);
    assert.match((await call("run", { argv: [node, "-e", ""], stdin: "nope.txt" })).content, /no such file/);
  });

  test("$VAR is replaced only for allowed names", async () => {
    const { call } = await workspace();
    const ok = await call("run", { argv: [node, "-e", "console.log(process.argv[1])", "v=$CT_ALLOWED/${CT_ALLOWED}"] });
    assert.equal(ok.content, "exit 0\nv=yes/yes");
    const denied = await call("run", { argv: [node, "-e", "", "$CT_OTHER"] });
    assert.equal(denied.is_error, true);
    assert.match(denied.content, /\$CT_OTHER is not an allowed environment variable \(names are listed under tools\.env in harness\.yml\); for a literal \$ use the script tool/);
    assert.match((await call("run", { argv: [node, "-e", "", "$NOT_THERE"] })).content, /\$NOT_THERE is not an allowed/);
    assert.equal(expandEnv("$A-$B", { allow: "*", values: { A: "1", B: "2" } }), "1-2");
    assert.throws(() => expandEnv("$A", { allow: "*", values: {} }), /\$A is not set/);
    assert.equal(expandEnv("plain", undefined), "plain");
  });

  test("glob: true expands arguments to workspace files; a pattern with no match is an error", async () => {
    const { call } = await workspace({ "a.ts": "", "b.ts": "", "c.js": "" });
    const show = "console.log(process.argv.slice(1).join(','))";
    assert.equal((await call("run", { argv: [node, "-e", show, "*.ts", "plain"], glob: true })).content, "exit 0\na.ts,b.ts,plain");
    assert.equal((await call("run", { argv: [node, "-e", show, "*.ts"] })).content, "exit 0\n*.ts", "off by default");
    const none = await call("run", { argv: [node, "-e", show, "*.md"], glob: true });
    assert.equal(none.is_error, true);
    assert.match(none.content, /\*\.md: no file matches/);
    assert.match((await call("run", { argv: [node, "-e", show, "../*"], glob: true })).content, /cannot leave the workspace/);
  });

  test("a command that runs too long is killed and the result says so", async () => {
    const { call } = await workspace();
    const t0 = Date.now();
    const r = await call("run", { argv: ["sleep", "30"], timeout_seconds: 1 });
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(r.is_error, true);
    assert.match(r.content, /timed out after 1 seconds and was killed/);
  });

  test("an abort stops the command and the result says it did not finish", async () => {
    const { call } = await workspace();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await call("run", { argv: ["sleep", "30"] }, ac.signal);
    assert.equal(r.is_error, true);
    assert.match(r.content, /stopped before it finished/);
  });

  test("runs in the workspace, and credentials in the environment are not passed on", async () => {
    const { dir, call } = await workspace();
    process.env["CT_FAKE_API_KEY"] = "k1";
    process.env["CT_PLAIN_VAR"] = "p1";
    try {
      const r = await call("run", { argv: [node, "-e", "console.log(process.cwd(), process.env.CT_FAKE_API_KEY ?? '-', process.env.CT_PLAIN_VAR ?? '-')"] });
      assert.equal(r.content, `exit 0\n${dir} - p1`);
    } finally {
      delete process.env["CT_FAKE_API_KEY"];
      delete process.env["CT_PLAIN_VAR"];
    }
  });
});

describe("script", () => {
  test("runs shell syntax, with stderr merged in order and the exit code first", async () => {
    const { call } = await workspace({ "x.txt": "hi" });
    const r = await call("script", { script: "echo start && cat x.txt && echo && sleep 0.2 && echo oops >&2; sleep 0.2; for i in 1 2; do echo $i; done; exit 3" });
    assert.equal(r.is_error, true);
    assert.equal(r.content, "exit 3\nstart\nhi\noops\n1\n2");
  });

  test("a script can be timed out too", async () => {
    const { call } = await workspace();
    const r = await call("script", { script: "sleep 30", timeout_seconds: 1 });
    assert.match(r.content, /timed out after 1 seconds/);
  });
});
