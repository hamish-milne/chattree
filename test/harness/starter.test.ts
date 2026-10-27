import assert from "node:assert/strict";
import { chmod, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { MemoryBlobStore } from "../../src/index.ts";
import { PathRefused, applyChanges, versionOf, type Change, expandEnv, expandGlob, GlobError, leafTools, resolveInWorkspace } from "../../harness/starter/index.ts";
import { expandBraces } from "../../harness/starter/glob.ts";
import { ToolRegistry, isStarted, type Tool, type ToolContext, type ToolOutput } from "../../harness/tools.ts";
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
    assert.match((registry.check({ name: "run", args: { argv: ["ls"] } }) as { error: string }).error, /argv is not a known argument \(known: command, timeout_seconds, background\)/);
    assert.match((registry.check({ name: "run", args: {} }) as { error: string }).error, /command is required/);
    assert.match((registry.check({ name: "write", args: { content: "x" } }) as { error: string }).error, /path is required \(the arguments are: path, content\)/, "a missing argument says what the tool takes");
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
    const whole = await call("read", { path: "b.txt" });
    assert.match(whole.content, /^=== b.txt \(1 line, version [0-9a-f]{8}\) ===\n1\tonly$/);
    const part = await call("read", { path: "a.txt", offset: 2, limit: 3 });
    assert.match(part.content, /^=== a.txt \(lines 3-5 of 12, version [0-9a-f]{8}\) ===\n3\tline 3\n4\tline 4\n5\tline 5\n\.\.\. 7 more lines; read again with offset 5 for the rest$/);
    const tail = await call("read", { path: "a.txt", offset: 9 });
    assert.match(tail.content, /lines 10-12 of 12/);
    assert.match(tail.content, /^ ?10\tline 10$/m.source.replace("^ ?", "") ? /10\tline 10/ : /x/);
    assert.doesNotMatch(tail.content, /more lines/);
  });

  test("each way a read can fail is said plainly, and is an error", async () => {
    const { dir, call } = await workspace({ "ok.txt": "fine\n", "empty.txt": "", "bin.dat": "a\0b", "sub/x.txt": "x" });
    await writeFile(join(dir, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    const ok = await call("read", { path: "ok.txt" });
    assert.equal(ok.is_error, false);
    assert.match(ok.content, /=== ok.txt \(1 line, version [0-9a-f]{8}\) ===\n1\tfine/);
    assert.match((await call("read", { path: "empty.txt" })).content, /=== empty.txt \(empty file, version [0-9a-f]{8}\) ===/);
    assert.match((await call("read", { path: "sub" })).content, /=== sub\/ \(1 entries\) ===\nx.txt/);
    for (const [path, expected] of [
      ["missing.txt", /=== missing.txt: no such file ===/],
      ["bin.dat", /=== bin.dat: a binary file ===/],
      ["latin.txt", /=== latin.txt: not UTF-8 text ===/],
      ["../x", /=== \.\.\/x: \.\.\/x is outside the workspace ===/],
      [".git/config", /=== \.git\/config: \.git\/config cannot be read ===/],
    ] as const) {
      const r = await call("read", { path });
      assert.equal(r.is_error, true, path);
      assert.match(r.content, expected);
    }
    const past = await call("read", { path: "ok.txt", offset: 5 });
    assert.match(past.content, /=== ok.txt: only 1 lines; offset 5 is past the end ===/);
  });

  test("lists a directory with its subdirectories marked, and reads stored output by its blob address", async () => {
    const { call, blobs } = await workspace({ "d/a.txt": "1", "d/sub/b.txt": "2" });
    assert.equal((await call("read", { path: "d" })).content, "=== d/ (2 entries) ===\na.txt\nsub/");
    const hash = await blobs.put(new TextEncoder().encode("stored\nresult\n"));
    assert.equal((await call("read", { path: `blob:${hash}` })).content, `=== blob:${hash} (2 lines) ===\n1\tstored\n2\tresult`);
    assert.match((await call("read", { path: `blob:${"0".repeat(64)}` })).content, /no such blob/);
    assert.match((await call("read", { path: "blob:xyz" })).content, /64 hex digits/);
  });

  test("refuses a file too large to read whole, and says what to do", async () => {
    const { dir, call } = await workspace();
    await writeFile(join(dir, "big.txt"), Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    assert.match((await call("read", { path: "big.txt" })).content, /too large to read whole; use run with head, tail or grep/);
  });
});

describe("write", () => {
  test("creates files and directories, replaces files, and keeps the executable bit", async () => {
    const { dir, call } = await workspace({ "old.txt": "12345" });
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    const created = await call("write", { path: "new/deep/a.txt", content: "héllo" });
    assert.equal(created.is_error, undefined);
    assert.match(created.content, /^created new\/deep\/a.txt \(6 bytes, version [0-9a-f]{8}\)$/);
    assert.match((await call("write", { path: "old.txt", content: "x" })).content, /^replaced old.txt \(1 bytes, was 5, version [0-9a-f]{8}\)$/);
    assert.match((await call("write", { path: "run.sh", content: "#!/bin/sh\necho\n" })).content, /^replaced run.sh \(15 bytes, was 10, version [0-9a-f]{8}\)$/);
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "new/deep/a.txt"))), "héllo");
    assert.equal((await stat(join(dir, "run.sh"))).mode & 0o777, 0o755);
  });

  test("a file that ended with a newline still does after a whole-file write, and the result says so", async () => {
    const { dir, call } = await workspace({ "a.txt": "one\ntwo\n", "crlf.txt": "one\r\ntwo\r\n", "bare.txt": "one\ntwo", "empty.txt": "" });
    const text = async (n: string) => new TextDecoder().decode(await host.fs.read(join(dir, n)));
    const r = await call("write", { path: "a.txt", content: "1\n2" });
    assert.match(r.content, /replaced a.txt \(4 bytes, was 8, version [0-9a-f]{8}; added the final newline the file had\)/);
    assert.equal(await text("a.txt"), "1\n2\n");
    await call("write", { path: "crlf.txt", content: "1\r\n2" });
    assert.equal(await text("crlf.txt"), "1\r\n2\r\n");
    await call("write", { path: "bare.txt", content: "1\n2" });
    assert.equal(await text("bare.txt"), "1\n2", "a file with no final newline is left alone");
    await call("write", { path: "empty.txt", content: "x" });
    assert.equal(await text("empty.txt"), "x");
    await call("write", { path: "new.txt", content: "x" });
    assert.equal(await text("new.txt"), "x", "a new file is written as given");
    await call("write", { path: "a.txt", content: "" });
    assert.equal(await text("a.txt"), "", "empty content empties the file");
  });

  test("a directory or a protected file is refused and said so", async () => {
    const { call } = await workspace({ "d/x": "x" });
    const dirRefused = await call("write", { path: "d", content: "x" });
    assert.equal(dirRefused.is_error, true);
    assert.match(dirRefused.content, /^failed: d: d is a directory$/);
    const refused = await call("write", { path: "chat.yml", content: "x" });
    assert.equal(refused.is_error, true);
    assert.match(refused.content, /failed: chat.yml: chat.yml is part of the conversation or its configuration and cannot be written/);
  });
});

describe("edit", () => {
  const apply = (original: string, ...changes: Change[]) => applyChanges(original, changes);
  const L = "a\nb\nc\nd\n";

  test("replaces lines, deletes them with empty content, and inserts after a line (0 is the top, the last line appends)", () => {
    assert.equal(apply(L, { start: 2, end: 3, content: "X\nY\nZ\n" }).text, "a\nX\nY\nZ\nd\n");
    assert.equal(apply(L, { start: 2, end: 2, content: "B" }).text, "a\nB\nc\nd\n", "a trailing newline in content is optional");
    assert.equal(apply(L, { start: 2, end: 3, content: "" }).text, "a\nd\n");
    assert.equal(apply(L, { after: 0, content: "top" }).text, "top\na\nb\nc\nd\n");
    assert.equal(apply(L, { after: 4, content: "end" }).text, "a\nb\nc\nd\nend\n");
    assert.equal(apply(L, { after: 2, content: "m" }).text, "a\nb\nm\nc\nd\n");
    assert.equal(apply(L, { start: 1, end: 4, content: "\n" }).text, "\n", "a lone newline is one blank line");
  });

  test("all changes in a call use the numbering as read, in any order, however they shift one another", () => {
    const r = apply(L, { start: 4, end: 4, content: "D" }, { start: 1, end: 1, content: "A1\nA2" }, { after: 2, content: "mid" }, { start: 3, end: 3, content: "" });
    assert.equal(r.text, "A1\nA2\nb\nmid\nD\n");
    assert.equal(r.lines, 5);
    assert.deepEqual(r.report.map((x) => x.split("\n")[0]), [
      "change 2: replaced lines 1-1 with 2 lines; now lines 1-2; the lines after it moved down by 1",
      "change 3: inserted 1 line after line 2; now lines 4-4; the lines after it moved down by 1",
      "change 4: deleted lines 3-3; line 5 is now what followed them; the lines after it moved up by 1",
      "change 1: replaced lines 4-4 with 1 line; now lines 5-5",
    ]);
  });

  test("the report shows what was removed and what was added, with the new numbers, and clips long ones", () => {
    const big = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const r = apply(big, { start: 2, end: 9, content: "n\n".repeat(8) });
    assert.match(r.report[0] as string, /- 2\tl2\n- 3\tl3\n[\s\S]*- 7\tl7\n- \.\.\. 2 more lines\n  1\tl1\n\+ 2\tn\n/);
  });

  test("the report shows the line before and after each change as the file now is, so a doubled line is visible", () => {
    const code = "function add(a, b) {\n  // TODO\n  return 0;\n}\n";
    const r = apply(code, { start: 1, end: 3, content: "function add(a, b) {\n  return a + b;\n}" });
    assert.equal(r.report[0], "change 1: replaced lines 1-3 with 3 lines; now lines 1-3\n- 1\tfunction add(a, b) {\n- 2\t  // TODO\n- 3\t  return 0;\n+ 1\tfunction add(a, b) {\n+ 2\t  return a + b;\n+ 3\t}\n  4\t}");
    assert.equal(apply(L, { after: 0, content: "top" }).report[0], "change 1: inserted 1 line after line 0; now lines 1-1; the lines after it moved down by 1\n+ 1\ttop\n  2\ta");
    assert.equal(apply(L, { after: 4, content: "end" }).report[0], "change 1: inserted 1 line after line 4; now lines 5-5\n  4\td\n+ 5\tend");
    assert.equal(apply(L, { start: 2, end: 3, content: "" }).report[0], "change 1: deleted lines 2-3; line 2 is now what followed them; the lines after it moved up by 2\n- 2\tb\n- 3\tc\n  1\ta\n  2\td");
  });

  test("bad numbers, both shapes at once, an empty insert, and overlaps are refused with the file's size", () => {
    assert.throws(() => apply(L, { start: 3, end: 9, content: "x" }), /lines 3-9 are not within the file's 4 lines/);
    assert.throws(() => apply(L, { start: 0, end: 1, content: "x" }), /start must be at least 1/);
    assert.throws(() => apply(L, { start: 3, end: 2, content: "x" }), /end at least start/);
    assert.throws(() => apply(L, { after: 5, content: "x" }), /between 0 and 4/);
    assert.throws(() => apply(L, { start: 1, end: 1, after: 1, content: "x" }), /either `start` and `end`.*or `after`/);
    assert.throws(() => apply(L, { content: "x" }), /give `start` and `end`/);
    assert.throws(() => apply(L, { start: 2, end: 2, content: "x" }, { start: 2, end: 3, content: "y" }), /overlaps/);
    assert.throws(() => apply(L, { start: 2, end: 3, content: "x" }, { after: 2, content: "y" }), /overlaps/);
    assert.throws(() => apply(L, { after: 2, content: "" }), /insert needs `content`/);
    assert.throws(() => apply("", { start: 1, end: 1, content: "x" }), /file is empty, so use `after`: 0/);
    assert.equal(apply("", { after: 0, content: "hi" }).text, "hi\n");
    assert.equal(apply(L, { after: 1, content: "x" }, { start: 2, end: 2, content: "y" }).text, "a\nx\ny\nc\nd\n", "touching changes do not overlap");
  });

  test("line endings are kept: CRLF files, and a file with no final newline", () => {
    assert.equal(apply("a\r\nb\r\nc\r\n", { start: 2, end: 2, content: "X\nY" }).text, "a\r\nX\r\nY\r\nc\r\n");
    assert.equal(apply("a\nb\nc", { start: 3, end: 3, content: "Z" }).text, "a\nb\nZ");
    assert.equal(apply("a\nb\nc", { after: 3, content: "d" }).text, "a\nb\nc\nd", "appending to an unterminated file terminates the old last line only");
    assert.equal(apply("a\nb\nc", { start: 1, end: 3, content: "" }).text, "");
  });

  test("on disk: the version is checked, results give the new version, and a failing edit changes nothing", async () => {
    const { dir, call } = await workspace({ "a.txt": "alpha\nbeta\ngamma\n" });
    const disk = async () => new TextDecoder().decode(await host.fs.read(join(dir, "a.txt")));
    const read = await call("read", { path: "a.txt" });
    const v = /version ([0-9a-f]{8})/.exec(read.content)?.[1] as string;
    assert.equal(v, await versionOf(new TextEncoder().encode("alpha\nbeta\ngamma\n")));
    const ok = await call("edit", { path: "a.txt", version: v, start: 2, end: 2, content: "BETA" });
    assert.equal(ok.is_error, undefined);
    assert.equal(await disk(), "alpha\nBETA\ngamma\n");
    const nv = /edited a.txt \(now 3 lines, version ([0-9a-f]{8})\)/.exec(ok.content)?.[1] as string;
    assert.equal(nv, await versionOf(new TextEncoder().encode("alpha\nBETA\ngamma\n")));
    assert.match(ok.content, /change 1: replaced lines 2-2 with 1 line; now lines 2-2\n- 2\tbeta\n  1\talpha\n\+ 2\tBETA\n  3\tgamma/);

    const stale = await call("edit", { path: "a.txt", version: v, start: 1, end: 1, content: "x" });
    assert.equal(stale.is_error, true);
    assert.match(stale.content, new RegExp(`a.txt has changed since you read it \\(you gave ${v}, it is at ${nv} now\\); read it again`));
    assert.equal(await disk(), "alpha\nBETA\ngamma\n");

    const outside = await call("edit", { path: "a.txt", version: nv, start: 9, end: 9, content: "bad" });
    assert.equal(outside.is_error, true);
    assert.match(outside.content, /failed: a.txt: change 1: lines 9-9 are not within.*nothing in it was changed/);
    assert.equal(await disk(), "alpha\nBETA\ngamma\n");
    assert.match((await call("edit", { path: "missing.txt", version: "x", after: 0, content: "x" })).content, /does not exist \(use write to create it\)/);
    assert.match((await call("edit", { path: "harness.yml", version: "x", after: 0, content: "x" })).content, /cannot be written/);
  });

  test("another change to the same file uses the version and numbers the last result gave", async () => {
    const { dir, call } = await workspace({ "a.txt": "1\n2\n3\n4\n" });
    let v = await versionOf(new TextEncoder().encode("1\n2\n3\n4\n"));
    for (const change of [{ start: 4, end: 4, content: "four" }, { after: 2, content: "two and a half" }, { start: 1, end: 1 }]) {
      const r = await call("edit", { path: "a.txt", version: v, ...change });
      assert.equal(r.is_error, undefined, r.content);
      v = /version ([0-9a-f]{8})\)/.exec(r.content)?.[1] as string;
    }
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "2\ntwo and a half\n3\nfour\n", "content may be left out to delete");
  });

  test("end defaults to start, so one line needs only start; end alone is still an error", async () => {
    const { dir, call } = await workspace({ "a.txt": "one\ntwo\nthree\n" });
    const v = await versionOf(new TextEncoder().encode("one\ntwo\nthree\n"));
    const r = await call("edit", { path: "a.txt", version: v, start: 2, content: "TWO" });
    assert.equal(r.is_error, undefined, r.content);
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "one\nTWO\nthree\n");
    const nv = /version ([0-9a-f]{8})\)/.exec(r.content)?.[1] as string;
    const del = await call("edit", { path: "a.txt", version: nv, start: 1 });
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "TWO\nthree\n", del.content);
    const bad = await call("edit", { path: "a.txt", version: await versionOf(new TextEncoder().encode("TWO\nthree\n")), end: 2, content: "x" });
    assert.match(bad.content, /give `start` and `end`/);
  });

  test("the version is read loosely: the header's own words, a v prefix or capitals still match; no digits at all is explained", async () => {
    const { dir, call } = await workspace({ "a.txt": "one\ntwo\n" });
    const v = await versionOf(new TextEncoder().encode("one\ntwo\n"));
    for (const given of [v, `version ${v}`, `v ${v}`, `v${v}`, v.toUpperCase(), `(1 line, version ${v})`]) {
      const r = await call("edit", { path: "a.txt", version: given, after: 0, content: "x" });
      assert.equal(r.is_error, undefined, given);
      await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    }
    const none = await call("edit", { path: "a.txt", version: "latest", after: 0, content: "x" });
    assert.match(none.content, new RegExp(`must be the 8 hex digits that read shows after "version" \\(the file is at ${v} now\\)`));
  });

  test("the old nested shapes and other names are repaired when they hold one file and one change; more than one is refused with what is known", async () => {
    const { dir, call } = await workspace({ "a.txt": "one\ntwo\n" });
    const v = await versionOf(new TextEncoder().encode("one\ntwo\n"));
    const redo = () => writeFile(join(dir, "a.txt"), "one\ntwo\n");
    const shapes: unknown[] = [
      { path: "a.txt", version: v, start: 2, end: 2, content: "TWO" },
      { files: [{ path: "a.txt", version: v, start: 2, end: 2, content: "TWO" }] },
      { files: [{ path: "a.txt", changes: [{ version: v, start: 2, end: 2, content: "TWO" }] }] },
      { files: [{ path: "a.txt", version: v, changes: [{ path: "a.txt", start: 2, end: 2, content: "TWO" }] }] },
      { path: "a.txt", version: v, changes: [{ start: 2, end: 2, content: "TWO" }] },
      { files: { path: "a.txt", version: v, changes: { start: 2, end: 2, content: "TWO" } } },
      { file: "a.txt", version: v, start_line: 2, end_line: 2, new_text: "TWO" },
      { path: "a.txt", version: v, start: "2", end: "2", content: "TWO", after: null },
    ];
    for (const args of shapes) {
      const r = await call("edit", args);
      assert.equal(r.is_error, undefined, JSON.stringify(args));
      assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "a.txt"))), "one\nTWO\n");
      await redo();
    }
    await assert.rejects(call("edit", { path: "a.txt", version: v, changes: [{ start: 1, end: 1, content: "x" }, { start: 2, end: 2, content: "y" }] }), /changes is not a known argument \(known: path, version, start, end, after, content\)/);
    assert.equal((await call("read", { files: ["a.txt"] })).is_error, false, "a lone path in a list is a path");
    assert.equal((await call("read", { file: "a.txt" })).is_error, false);
    await assert.rejects(call("read", { files: ["a.txt", "b.txt"] }), /files is not a known argument \(known: path, offset, limit\)/);
    assert.equal((await call("write", { file_path: "n.txt", contents: "x" })).is_error, undefined);
  });

  test("read and write report the version edit needs", async () => {
    const { call } = await workspace({ "e.txt": "" });
    const w = await call("write", { path: "n.txt", content: "x\n" });
    const wv = /version ([0-9a-f]{8})/.exec(w.content)?.[1];
    assert.equal(wv, await versionOf(new TextEncoder().encode("x\n")));
    assert.match((await call("read", { path: "n.txt" })).content, new RegExp(`^=== n.txt \\(1 line, version ${wv}\\) ===`));
    assert.match((await call("read", { path: "e.txt" })).content, /\(empty file, version [0-9a-f]{8}\)/);
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
  const q = `"${node}"`;
  const show = `'console.log(process.argv.slice(1).join("|"))'`;

  test("one command line, started without a shell: quoted text is passed on as it is, and the result begins with the exit code", async () => {
    const { call } = await workspace();
    const r = await call("run", { command: `${q} -e ${show} '*.ts' "a;b" 'x|y' ">out" "it's"` });
    assert.equal(r.content, "exit 0\n*.ts|a;b|x|y|>out|it's");
    assert.equal(r.is_error, false);
    const fail = await call("run", { command: `${q} -e "console.error('bad'); process.exit(4)"` });
    assert.equal(fail.content, "exit 4\nbad");
    assert.equal(fail.is_error, true);
    assert.equal((await call("run", { command: `${q} -e ""` })).content, "exit 0\n(no output)");
    assert.match((await call("run", { command: "no-such-program-xyz --flag" })).content, /exit 127\nno-such-program-xyz: command not found/);
  });

  test("syntax run does not do is an error result that says what to use instead", async () => {
    const { call } = await workspace();
    for (const [command, re] of [["echo a; echo b", /`;` is not supported by run \(use the script tool/], ["echo a && echo b", /`&&`/], ["echo $(date)", /\$\(\.\.\.\)/], ["", /empty/], ["FOO=1 node -v", /setting a variable/]] as const) {
      const r = await call("run", { command });
      assert.equal(r.is_error, true, command);
      assert.match(r.content, re, command);
    }
  });

  test("pipes, reads stdin from a file and writes or appends stdout to a file", async () => {
    const { dir, call } = await workspace({ "in.txt": "b\na\n" });
    const cat = `'process.stdin.pipe(process.stdout)'`;
    const sort = `'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.split("\\n").filter(Boolean).sort().join("\\n")+"\\n"))'`;
    const r = await call("run", { command: `${q} -e ${cat} < in.txt | ${q} -e ${sort}` });
    assert.equal(r.content, "exit 0 (stages: 0, 0)\na\nb");
    const w = await call("run", { command: `${q} -e "console.log('first')" > out/log.txt` });
    assert.equal(w.content, "exit 0\n(no output)\nstdout written to out/log.txt (6 bytes)");
    await call("run", { command: `${q} -e "console.log('second')" >> out/log.txt 2>&1` });
    assert.equal(new TextDecoder().decode(await host.fs.read(join(dir, "out/log.txt"))), "first\nsecond\n");
    assert.equal((await call("run", { command: `${q} -e "console.log('gone')" > /dev/null` })).content, "exit 0\n(no output)");
    assert.match((await call("run", { command: `${q} -e "" > chat.yml` })).content, /cannot be written/);
    assert.match((await call("run", { command: `${q} -e "" < ../x` })).content, /outside the workspace/);
    assert.match((await call("run", { command: `${q} -e "" < nope.txt` })).content, /no such file/);
    assert.match((await call("run", { command: `${q} -e "" > out` })).content, /is a directory/);
  });

  test("$NAME is replaced only for allowed names, and not inside single quotes", async () => {
    const { call } = await workspace();
    const ok = await call("run", { command: `${q} -e ${show} "v=$CT_ALLOWED/\${CT_ALLOWED}" '$CT_OTHER' $CT_ALLOWED` });
    assert.equal(ok.content, "exit 0\nv=yes/yes|$CT_OTHER|yes");
    const denied = await call("run", { command: `${q} -e "" $CT_OTHER` });
    assert.equal(denied.is_error, true);
    assert.match(denied.content, /\$CT_OTHER is not an allowed environment variable \(names are listed under tools\.env in harness\.yml\); for a literal \$ use the script tool/);
    assert.match((await call("run", { command: `${q} -e "" $NOT_THERE` })).content, /\$NOT_THERE is not an allowed/);
    assert.equal(expandEnv("$A-$B", { allow: "*", values: { A: "1", B: "2" } }), "1-2");
    assert.throws(() => expandEnv("$A", { allow: "*", values: {} }), /\$A is not set/);
    assert.equal(expandEnv("plain", undefined), "plain");
  });

  test("unquoted wildcards expand to workspace files as a shell does; quoted ones do not; no match is an error", async () => {
    const { call } = await workspace({ "a.ts": "", "b.ts": "", "c.js": "" });
    assert.equal((await call("run", { command: `${q} -e ${show} *.ts plain` })).content, "exit 0\na.ts|b.ts|plain");
    assert.equal((await call("run", { command: `${q} -e ${show} '*.ts' "*.ts"` })).content, "exit 0\n*.ts|*.ts");
    assert.equal((await call("run", { command: `${q} -e ${show} *.{ts,js}` })).content, "exit 0\na.ts|b.ts|c.js");
    const none = await call("run", { command: `${q} -e ${show} *.md` });
    assert.equal(none.is_error, true);
    assert.match(none.content, /\*\.md: no file matches/);
    assert.match((await call("run", { command: `${q} -e ${show} ../*` })).content, /cannot leave the workspace/);
  });

  test("everyday utilities work as in a shell: pipes between real programs", async () => {
    const { call } = await workspace({ "w.txt": "pear\napple\nfig\napple\n" });
    const r = await call("run", { command: "cat w.txt | sort | uniq -c | sort -rn | head -n 1" });
    assert.equal(r.content, "exit 0 (stages: 0, 0, 0, 0, 0)\n      2 apple");
    assert.equal((await call("run", { command: "grep -c a w.txt" })).content, "exit 0\n3");
    assert.equal((await call("run", { command: "grep -c zzz w.txt" })).is_error, true, "grep exits 1 when nothing matches");
  });

  test("a command that runs too long is killed and the result says so", async () => {
    const { call } = await workspace();
    const t0 = Date.now();
    const r = await call("run", { command: "sleep 30", timeout_seconds: 1 });
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(r.is_error, true);
    assert.match(r.content, /timed out after 1 seconds and was killed/);
  });

  test("an abort stops the command and the result says it did not finish", async () => {
    const { call } = await workspace();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await call("run", { command: "sleep 30" }, ac.signal);
    assert.equal(r.is_error, true);
    assert.match(r.content, /stopped before it finished/);
  });

  test("runs in the workspace, and credentials in the environment are not passed on", async () => {
    const { dir, call } = await workspace();
    process.env["CT_FAKE_API_KEY"] = "k1";
    process.env["CT_PLAIN_VAR"] = "p1";
    try {
      const r = await call("run", { command: `${q} -e "console.log(process.cwd(), process.env.CT_FAKE_API_KEY ?? '-', process.env.CT_PLAIN_VAR ?? '-')"` });
      assert.equal(r.content, `exit 0\n${dir} - p1`);
    } finally {
      delete process.env["CT_FAKE_API_KEY"];
      delete process.env["CT_PLAIN_VAR"];
    }
  });

  test("on a Windows host the utilities are started as busybox applets, and without busybox the model is told", async () => {
    const dir = await tempDir();
    const started: (readonly (readonly string[])[])[] = [];
    const windows = { ...host, platform: "windows" as const, run: async (spec: Parameters<NonNullable<typeof host.run>>[0]) => (started.push(spec.stages), { exitCode: 0, stageCodes: [0], output: new Uint8Array(), dropped: 0, timedOut: false, aborted: false }) };
    const ctx: ToolContext = { signal: new AbortController().signal, callId: "c", workspace: dir, host: windows };
    const withBb = new ToolRegistry(leafTools({ busybox: "C:\\tools\\busybox.exe" })).get("run") as Tool;
    await withBb.execute({ command: "cat a.txt | sort | git status" }, ctx);
    assert.deepEqual(started[0], [["C:\\tools\\busybox.exe", "cat", "a.txt"], ["C:\\tools\\busybox.exe", "sort"], ["git", "status"]]);
    const without = new ToolRegistry(leafTools()).get("run") as Tool;
    const r = (await without.execute({ command: "ls -la" }, ctx)) as ToolOutput;
    assert.equal(r.is_error, true);
    assert.match(r.content, /ls is not available on this Windows machine/);
    assert.equal(started.length, 1, "nothing was started");
  });
});

describe("script", () => {
  test("is POSIX sh everywhere: on a Windows host it is busybox's sh, and without busybox the model is told", async () => {
    const dir = await tempDir();
    const started: (readonly (readonly string[])[])[] = [];
    const windows = { ...host, platform: "windows" as const, run: async (spec: Parameters<NonNullable<typeof host.run>>[0]) => (started.push(spec.stages), { exitCode: 0, stageCodes: [0], output: new Uint8Array(), dropped: 0, timedOut: false, aborted: false }) };
    const ctx: ToolContext = { signal: new AbortController().signal, callId: "c", workspace: dir, host: windows };
    await (new ToolRegistry(leafTools({ busybox: "C:\\bb\\busybox.exe" })).get("script") as Tool).execute({ script: "for i in 1 2; do echo $i; done" }, ctx);
    assert.deepEqual(started[0], [["C:\\bb\\busybox.exe", "sh", "-c", "for i in 1 2; do echo $i; done"]]);
    const r = (await (new ToolRegistry(leafTools()).get("script") as Tool).execute({ script: "echo hi" }, ctx)) as ToolOutput;
    assert.equal(r.is_error, true);
    assert.match(r.content, /script needs a POSIX shell.*fetch-busybox/);
    assert.equal(started.length, 1);
  });

  test("$variables and loops mean what sh says", async () => {
    const { call } = await workspace();
    const r = await call("script", { script: "for i in 1 2 3; do echo $i; done > nums.txt; cat nums.txt" });
    assert.equal(r.content, "exit 0\n1\n2\n3");
  });

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
