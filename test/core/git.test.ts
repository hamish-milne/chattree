import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git, GitError, MIN_GIT_VERSION, compareVersions, formatVersion, parseGitVersion, type ExecOptions, type ExecResult, type Host } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { identity, newRepo, tempDir } from "../support/tmp.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();
const DATE = "2026-10-24T12:00:00+00:00";

async function commitFile(git: Git, name: string, content: string, message = `add ${name}`): Promise<string> {
  await writeFile(join(git.cwd, name), content);
  await git.add([name]);
  return git.commit({ message, date: DATE });
}

describe("versions", () => {
  test("parses the formats git prints", () => {
    assert.deepEqual(parseGitVersion("git version 2.43.0\n"), { major: 2, minor: 43, patch: 0 });
    assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-146)"), { major: 2, minor: 39, patch: 3 });
    assert.deepEqual(parseGitVersion("git version 2.43.0.windows.1"), { major: 2, minor: 43, patch: 0 });
    assert.deepEqual(parseGitVersion("git version 2.40"), { major: 2, minor: 40, patch: 0 });
    assert.equal(parseGitVersion("not git"), undefined);
  });
  test("compares and formats", () => {
    assert.ok(compareVersions({ major: 2, minor: 37, patch: 9 }, MIN_GIT_VERSION) < 0);
    assert.ok(compareVersions({ major: 2, minor: 38, patch: 0 }, MIN_GIT_VERSION) === 0);
    assert.ok(compareVersions({ major: 3, minor: 0, patch: 0 }, MIN_GIT_VERSION) > 0);
    assert.equal(formatVersion(MIN_GIT_VERSION), "2.38.0");
  });
});

describe("open", () => {
  const fake = (stdout: string, exitCode = 0): Host => ({
    ...nodeHost(),
    exec: async (): Promise<ExecResult> => ({ exitCode, stdout: enc.encode(stdout), stderr: new Uint8Array(0) }),
  });
  test("rejects a git that is too old, naming both versions", async () => {
    await assert.rejects(Git.open(fake("git version 2.37.7"), { cwd: "/" }), /2\.37\.7 is too old: 2\.38\.0/);
  });
  test("accepts the minimum", async () => {
    assert.deepEqual((await Git.open(fake("git version 2.38.0"), { cwd: "/" })).version, MIN_GIT_VERSION);
  });
  test("reports output it cannot understand", async () => {
    await assert.rejects(Git.open(fake("hello"), { cwd: "/" }), GitError);
  });
  test("reports a git that cannot be started", async () => {
    const host: Host = { ...nodeHost(), exec: async () => { throw new Error("spawn git ENOENT"); } };
    await assert.rejects(Git.open(host, { cwd: "/" }), /cannot run git: spawn git ENOENT/);
  });
  test("works with the real git", async () => {
    const git = await Git.open(nodeHost(), { cwd: await tempDir() });
    assert.ok(compareVersions(git.version, MIN_GIT_VERSION) >= 0);
  });
});

describe("how commands are run", () => {
  test("always the same safety settings, argv only, and read-only commands take no optional locks", async () => {
    const calls: { program: string; args: readonly string[]; opts: ExecOptions }[] = [];
    const inner = nodeHost();
    const host: Host = { ...inner, exec: (program, args, opts) => (calls.push({ program, args, opts }), inner.exec(program, args, opts)) };
    const git = await Git.init(host, join(await tempDir(), "r"), {});
    calls.length = 0;
    await git.status();
    await git.setConfig("user.name", "x");
    const [status, config] = calls;
    assert.ok(status !== undefined && config !== undefined);
    for (const c of [status, config]) {
      assert.equal(c.program, "git");
      for (const kv of ["core.autocrlf=false", "commit.gpgsign=false", "gc.auto=0", `core.hooksPath=${host.nullDevice}`]) assert.ok(c.args.includes(kv), kv);
      assert.equal(c.opts.env?.["GIT_TERMINAL_PROMPT"], "0");
      assert.equal(c.opts.env?.["LC_ALL"], "C");
    }
    assert.equal(status.opts.env?.["GIT_OPTIONAL_LOCKS"], "0");
    assert.equal(config.opts.env?.["GIT_OPTIONAL_LOCKS"], undefined);
  });

  test("hooks run only when asked", async () => {
    const git = await newRepo();
    const hook = join(git.cwd, ".git", "hooks", "pre-commit");
    await mkdir(join(git.cwd, ".git", "hooks"), { recursive: true });
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    await commitFile(git, "a", "1\n"); // would fail if the hook ran
    const withHooks = await Git.open(nodeHost(), { cwd: git.cwd, hooks: true });
    await writeFile(join(git.cwd, "b"), "2\n");
    await withHooks.add(["b"]);
    // --no-verify is passed by commit(), so use the raw command to see the hook fire
    await assert.rejects(withHooks.run(["commit", "-m", "x"]), GitError);
  });

  test("user configuration cannot change behaviour: gpg signing, autocrlf and a failing pre-commit hook", async () => {
    const git = await newRepo();
    await git.setConfig("commit.gpgsign", "true");
    await git.setConfig("user.signingkey", "does-not-exist");
    await git.setConfig("core.autocrlf", "true");
    const first = await commitFile(git, "f.txt", "a\nb\n");
    const blob = await git.readFileAt(first, "f.txt");
    assert.equal(dec.decode(blob), "a\nb\n", "no CRLF conversion");
  });

  test("failures carry the arguments, exit code and stderr", async () => {
    const git = await newRepo();
    await assert.rejects(git.run(["checkout", "no-such-branch"]), (e) => e instanceof GitError && e.exitCode !== 0 && e.args[0] === "checkout" && /no-such-branch/.test(e.stderr));
  });

  test("option-like arguments are rejected before they reach git", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    await assert.rejects(git.revParse("--all"), GitError);
    await assert.rejects(git.createBranch("-x", "HEAD"), GitError);
    await assert.rejects(git.readFileAt("--help", "a"), GitError);
    await assert.rejects(git.deleteBranch("--force"), GitError);
    await assert.rejects(git.log("--all"), GitError);
  });
});

describe("repository basics", () => {
  test("a new repository has no commits, a branch name and a clean status", async () => {
    const git = await newRepo();
    assert.equal(await git.head(), undefined);
    assert.equal(await git.currentBranch(), "main");
    assert.equal(await git.isClean(), true);
    assert.deepEqual(await git.branches(), []);
  });

  test("the initial branch can be chosen", async () => {
    const git = await Git.init(nodeHost(), join(await tempDir(), "r"), { branch: "trunk" });
    assert.equal(await git.currentBranch(), "trunk");
  });

  test("commit returns the hash, records identity, date, message and trailers", async () => {
    const git = await newRepo();
    await writeFile(join(git.cwd, "a"), "1\n");
    await git.add(["a"]);
    const hash = await git.commit({
      message: "assistant: tool_use\n\nSecond paragraph.",
      trailers: [["Chattree-Entry", "01K8ZQ3M0A5G2W7Y9C4T1R6B8D"], ["Chattree-Offset", "1234"], ["Chattree-Entry", "other"]],
      author: { name: "claude-sonnet-5-5", email: "model@example.com" },
      committer: identity,
      date: DATE,
    });
    assert.equal(hash, await git.head());
    const [c] = await git.log("HEAD");
    assert.ok(c !== undefined);
    assert.equal(c.hash, hash);
    assert.deepEqual(c.parents, []);
    assert.equal(c.authorName, "claude-sonnet-5-5");
    assert.equal(c.authorEmail, "model@example.com");
    assert.equal(c.committerName, identity.name);
    assert.equal(c.authorDate, DATE);
    assert.equal(c.subject, "assistant: tool_use");
    assert.deepEqual(c.trailers, { "Chattree-Entry": ["01K8ZQ3M0A5G2W7Y9C4T1R6B8D", "other"], "Chattree-Offset": ["1234"] });
    assert.match(await git.text(["log", "-1", "--format=%B"]), /Second paragraph\.\n\nChattree-Entry: 01K8/);
  });

  test("commit rejects malformed trailers and NULs", async () => {
    const git = await newRepo();
    await writeFile(join(git.cwd, "a"), "1\n");
    await git.add(["a"]);
    await assert.rejects(git.commit({ message: "x", trailers: [["bad key", "v"]] }), GitError);
    await assert.rejects(git.commit({ message: "x", trailers: [["K", "two\nlines"]] }), GitError);
    await assert.rejects(git.commit({ message: "x", trailers: [["K", " "]] }), GitError);
    await assert.rejects(git.commit({ message: "x\u0000y" }), GitError);
  });

  test("an empty commit needs allowEmpty", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    await assert.rejects(git.commit({ message: "nothing" }), GitError);
    assert.ok(await git.commit({ message: "nothing", allowEmpty: true }));
  });

  test("messages with unusual content survive verbatim", async () => {
    const git = await newRepo();
    const subject = "# not a comment — \"quotes\" and 'more' \u{1F600}";
    await writeFile(join(git.cwd, "a"), "1\n");
    await git.add(["a"]);
    await git.commit({ message: subject });
    assert.equal((await git.log("HEAD"))[0]?.subject, subject);
  });

  test("log walks history, honours maxCount and first-parent", async () => {
    const git = await newRepo();
    const h1 = await commitFile(git, "a", "1\n");
    const h2 = await commitFile(git, "b", "2\n");
    const h3 = await commitFile(git, "c", "3\n");
    assert.deepEqual((await git.log("HEAD")).map((c) => c.hash), [h3, h2, h1]);
    assert.deepEqual((await git.log("HEAD", { maxCount: 2 })).map((c) => c.hash), [h3, h2]);
    assert.deepEqual((await git.log("HEAD", { firstParent: true })).map((c) => c.hash), [h3, h2, h1]);
    assert.deepEqual((await git.log("HEAD", { paths: ["b"] })).map((c) => c.hash), [h2]);
    assert.deepEqual((await git.log(h2))[0]?.parents, [h1]);
  });

  test("revParse, isAncestor and mergeBase", async () => {
    const git = await newRepo();
    const h1 = await commitFile(git, "a", "1\n");
    const h2 = await commitFile(git, "b", "2\n");
    assert.equal(await git.revParse("HEAD~1"), h1);
    assert.equal(await git.revParse("nothing"), undefined);
    assert.equal(await git.revParse(h2.slice(0, 10)), h2);
    assert.equal(await git.isAncestor(h1, h2), true);
    assert.equal(await git.isAncestor(h2, h1), false);
    assert.equal(await git.mergeBase(h1, h2), h1);
  });
});

describe("files and status", () => {
  test("readFileAt reads any revision without touching the worktree, and reports missing files", async () => {
    const git = await newRepo();
    const h1 = await commitFile(git, "a", "one\n");
    await commitFile(git, "a", "two\n");
    assert.equal(dec.decode(await git.readFileAt(h1, "a")), "one\n");
    assert.equal(dec.decode(await git.readFileAt("HEAD", "a")), "two\n");
    assert.equal(await git.readFileAt("HEAD", "missing"), undefined);
    assert.equal(await git.readFileAt(h1, "dir/also-missing"), undefined);
    assert.equal(await readFile(join(git.cwd, "a"), "utf8"), "two\n");
  });

  test("readFileAt returns binary content exactly", async () => {
    const git = await newRepo();
    const bytes = Uint8Array.from({ length: 512 }, (_, i) => i % 256);
    await writeFile(join(git.cwd, "bin"), bytes);
    await git.add(["bin"]);
    await git.commit({ message: "bin" });
    assert.deepEqual(await git.readFileAt("HEAD", "bin"), bytes);
  });

  test("status reports changes, untracked files and awkward names", async () => {
    const git = await newRepo();
    await commitFile(git, "tracked", "1\n");
    await commitFile(git, "gone", "1\n");
    await writeFile(join(git.cwd, "tracked"), "changed\n");
    await writeFile(join(git.cwd, "new file with spaces"), "x");
    const quoted = process.platform === "win32" ? "café 'q'.txt" : "café \"q\".txt"; // Windows has no " in file names
    await writeFile(join(git.cwd, quoted), "x");
    await mkdir(join(git.cwd, "dir"));
    await writeFile(join(git.cwd, "dir", "inner"), "x");
    await git.run(["rm", "--quiet", "gone"]);
    const status = (await git.status()).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(status, [
      { code: "??", path: quoted },
      { code: "??", path: "dir/inner" },
      { code: "D.", path: "gone" },
      { code: "??", path: "new file with spaces" },
      { code: ".M", path: "tracked" },
    ].sort((a, b) => a.path.localeCompare(b.path)));
    assert.equal(await git.isClean(), false);
  });

  test("add stages deletions, restore discards changes", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    await commitFile(git, "b", "2\n");
    await git.run(["rm", "--quiet", "--cached", "b"]);
    await writeFile(join(git.cwd, "a"), "dirty\n");
    await git.restore(["a"]);
    assert.equal(await readFile(join(git.cwd, "a"), "utf8"), "1\n");
    await git.restore(["b"]);
    assert.equal(await git.isClean(), true);
    await git.add(["a"]);
    assert.equal(await git.isClean(), true);
  });

  test("diff lists added, modified and deleted files between revisions", async () => {
    const git = await newRepo();
    await commitFile(git, "keep", "1\n");
    await commitFile(git, "edit", "1\n");
    await commitFile(git, "drop", "1\n");
    const base = (await git.head()) as string;
    await writeFile(join(git.cwd, "edit"), "2\n");
    await writeFile(join(git.cwd, "added file"), "x\n");
    await git.run(["rm", "--quiet", "drop"]);
    await git.add(["edit", "added file"]);
    const tip = await git.commit({ message: "change" });
    const d = (await git.diff(base, tip)).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(d, [{ status: "A", path: "added file" }, { status: "D", path: "drop" }, { status: "M", path: "edit" }]);
    assert.deepEqual(await git.diff(base, tip, [":(exclude)edit", ":(exclude)drop"]), [{ status: "A", path: "added file" }]);
    assert.deepEqual(await git.diff(base, base), []);
  });

  test("gitDir and commonDir are absolute", async () => {
    const git = await newRepo();
    assert.equal(await git.gitDir(), join(git.cwd, ".git"));
    assert.equal(await git.commonDir(), join(git.cwd, ".git"));
  });
});

describe("staging helpers", () => {
  test("stageContent commits file content that differs from the worktree", async () => {
    const git = await newRepo();
    await commitFile(git, "log", "one\n");
    await writeFile(join(git.cwd, "log"), "one\ntwo\nthree\n");
    const sha = await git.hashObject(enc.encode("one\ntwo\n"));
    await git.stageContent("log", sha);
    const commit = await git.commit({ message: "prefix" });
    assert.equal(dec.decode(await git.readFileAt(commit, "log")), "one\ntwo\n");
    assert.equal(await readFile(join(git.cwd, "log"), "utf8"), "one\ntwo\nthree\n", "the worktree is untouched");
    assert.deepEqual(await git.status(), [{ code: ".M", path: "log" }]);
  });

  test("hashObject is stable and addAll stages new, changed and deleted files", async () => {
    const git = await newRepo();
    assert.equal(await git.hashObject(enc.encode("x")), await git.hashObject(enc.encode("x")));
    await commitFile(git, "gone", "1\n");
    await writeFile(join(git.cwd, "new"), "n\n");
    await (await import("node:fs/promises")).rm(join(git.cwd, "gone"));
    await git.addAll();
    await git.commit({ message: "all" });
    assert.equal(await git.isClean(), true);
    assert.equal(await git.readFileAt("HEAD", "gone"), undefined);
    assert.ok(await git.readFileAt("HEAD", "new"));
  });
});

async function writeAll(git: Git, files: Record<string, string | null>): Promise<void> {
  const fsp = await import("node:fs/promises");
  for (const [name, content] of Object.entries(files)) {
    const full = join(git.cwd, name);
    if (content === null) await fsp.rm(full, { recursive: true, force: true });
    else {
      await fsp.mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  }
}

/** main and child diverge from a common base: the child edits f, deletes g, edits h, adds files; main edits f and g, deletes h. */
async function diverged(): Promise<{ git: Git; base: string; main: string; child: string }> {
  const git = await newRepo();
  await writeAll(git, { f: "a\nb\nc\n", g: "x\n", h: "y\n", ok: "k\n", "d/inner": "1\n" });
  await git.addAll();
  const base = await git.commit({ message: "base" });
  await git.run(["checkout", "--quiet", "-b", "child"]);
  await writeAll(git, { f: "a\nB-child\nc\n", g: null, h: "child h\n", "new-child": "n\n", d: null });
  await writeAll(git, { d: "now a file\n" });
  await git.addAll();
  const child = await git.commit({ message: "child" });
  await git.run(["checkout", "--quiet", "main"]);
  await writeAll(git, { f: "a\nB-main\nc\n", g: "main g\n", h: null, "new-main": "m\n", "d/inner2": "2\n" });
  await git.addAll();
  const main = await git.commit({ message: "main" });
  return { git, base, main, child };
}

describe("merging in memory", () => {
  test("a clean merge returns the merged tree without touching anything", async () => {
    const git = await newRepo();
    await writeAll(git, { a: "1\n", b: "2\n" });
    await git.addAll();
    await git.commit({ message: "base" });
    await git.run(["checkout", "--quiet", "-b", "side"]);
    await writeAll(git, { a: "1 side\n", "only-side": "s\n" });
    await git.addAll();
    const side = await git.commit({ message: "side" });
    await git.run(["checkout", "--quiet", "main"]);
    await writeAll(git, { b: "2 main\n" });
    await git.addAll();
    const main = await git.commit({ message: "main" });
    const r = await git.mergeTree(main, side);
    assert.equal(r.clean, true);
    assert.deepEqual(r.conflictedPaths, []);
    assert.ok(r.messages.every((m) => m.type === "Auto-merging" || !m.type.startsWith("CONFLICT")));
    const tip = await git.commitTree(r.tree, [main, side], { message: "merge" });
    assert.equal(dec.decode(await git.readFileAt(tip, "a")), "1 side\n");
    assert.equal(dec.decode(await git.readFileAt(tip, "b")), "2 main\n");
    assert.deepEqual((await git.log(tip))[0]?.parents, [main, side]);
    assert.equal(await git.head(), main);
    assert.equal(await git.isClean(), true);
  });

  test("conflicts are reported by path and kind", async () => {
    const { git, main, child } = await diverged();
    const r = await git.mergeTree(main, child);
    assert.equal(r.clean, false);
    // the file/directory conflict moves the file aside under a name that includes the other side's label
    assert.deepEqual(r.conflictedPaths.map((p) => p.replace(/^d~.+$/, "d~side")).sort(), ["d~side", "f", "g", "h"]);
    const kinds = Object.fromEntries(r.messages.filter((m) => m.type.startsWith("CONFLICT")).flatMap((m) => m.paths.map((p) => [p, m.type])));
    assert.equal(kinds["f"], "CONFLICT (contents)");
    assert.equal(kinds["g"], "CONFLICT (modify/delete)");
    assert.equal(kinds["h"], "CONFLICT (modify/delete)");
    assert.equal(kinds["d"], "CONFLICT (file/directory)");
    assert.ok(r.messages.some((m) => m.type === "Auto-merging" && m.paths[0] === "f"));
  });

  test("taking the trunk's version of each conflicted path gives a tree where the trunk wins and the rest merges", async () => {
    const { git, main, child } = await diverged();
    const r = await git.mergeTree(main, child);
    const tree = await git.rewriteTree(r.tree, r.conflictedPaths.map((path) => ({ path, from: main })));
    const merged = await git.commitTree(tree, [main, child], { message: "trunk wins" });
    const at = async (p: string): Promise<string | undefined> => {
      const b = await git.readFileAt(merged, p);
      return b === undefined ? undefined : dec.decode(b);
    };
    assert.equal(await at("f"), "a\nB-main\nc\n");
    assert.equal(await at("g"), "main g\n");
    assert.equal(await at("h"), undefined, "main deleted it");
    assert.equal(await at("d~child"), undefined);
    assert.equal(await at("d/inner2"), "2\n", "main's directory survives the file/directory conflict");
    assert.equal(await at("new-child"), "n\n", "non-conflicting child work is merged");
    assert.equal(await at("new-main"), "m\n");
    assert.equal(await at("ok"), "k\n");
  });
});

describe("tree edits", () => {
  test("write, remove and restore edits, without touching the repository", async () => {
    const git = await newRepo();
    await writeAll(git, { a: "1\n", "dir/x": "x\n", "dir/y": "y\n", keep: "k\n" });
    await git.addAll();
    const c1 = await git.commit({ message: "one" });
    await writeAll(git, { a: "2\n", "dir/x": null, "dir/z": "z\n" });
    await git.addAll();
    const c2 = await git.commit({ message: "two" });
    const before = await git.status();

    const tree = await git.rewriteTree(await git.treeOf(c2), [
      { path: "new file", data: enc.encode("created\n") },
      { path: "a", data: enc.encode("replaced\n") },
      { path: "keep", remove: true },
      { path: "dir", from: c1 },
    ]);
    const c3 = await git.commitTree(tree, [c2], { message: "edited" });
    const at = async (p: string): Promise<string | undefined> => {
      const b = await git.readFileAt(c3, p);
      return b === undefined ? undefined : dec.decode(b);
    };
    assert.equal(await at("new file"), "created\n");
    assert.equal(await at("a"), "replaced\n");
    assert.equal(await at("keep"), undefined);
    assert.equal(await at("dir/x"), "x\n", "restored from the earlier commit");
    assert.equal(await at("dir/z"), undefined, "restoring a directory removes what the source lacks");
    assert.deepEqual(await git.status(), before);
    assert.equal(await git.head(), c2);
  });

  test("a file replaced by a directory and back", async () => {
    const git = await newRepo();
    await writeAll(git, { p: "file\n" });
    await git.addAll();
    const c1 = await git.commit({ message: "file" });
    const t = await git.rewriteTree(await git.treeOf(c1), [{ path: "p", remove: true }, { path: "p/inner", data: enc.encode("i\n") }]);
    const c2 = await git.commitTree(t, [c1], { message: "dir" });
    assert.equal(dec.decode(await git.readFileAt(c2, "p/inner")), "i\n");
    const back = await git.rewriteTree(await git.treeOf(c2), [{ path: "p", from: c1 }]);
    assert.equal(dec.decode(await git.readFileAt(await git.commitTree(back, [c2], { message: "back" }), "p")), "file\n");
  });

  test("paths that look like globs are taken literally", async () => {
    const git = await newRepo();
    await writeAll(git, { "a[bc]": "class\n", ab: "ab\n" }); // * is not allowed in Windows file names; [ is a glob character too
    await git.addAll();
    const c1 = await git.commit({ message: "x" });
    const t = await git.rewriteTree(await git.treeOf(c1), [{ path: "a[bc]", remove: true }]);
    const c2 = await git.commitTree(t, [c1], { message: "y" });
    assert.equal(await git.readFileAt(c2, "a[bc]"), undefined);
    assert.equal(dec.decode(await git.readFileAt(c2, "ab")), "ab\n");
  });
});

describe("fast-forward", () => {
  test("moves the branch and worktree to a descendant, keeping unrelated local changes", async () => {
    const git = await newRepo();
    await writeAll(git, { a: "1\n", b: "1\n" });
    await git.addAll();
    const c1 = await git.commit({ message: "one" });
    const t = await git.rewriteTree(await git.treeOf(c1), [{ path: "a", data: enc.encode("2\n") }]);
    const c2 = await git.commitTree(t, [c1], { message: "two" });
    await writeAll(git, { b: "local edit\n" });
    await git.fastForward(c2);
    assert.equal(await git.head(), c2);
    assert.equal(await readFile(join(git.cwd, "a"), "utf8"), "2\n");
    assert.equal(await readFile(join(git.cwd, "b"), "utf8"), "local edit\n");
  });

  test("refuses when a local change would be overwritten, or the commit is not a descendant", async () => {
    const git = await newRepo();
    await writeAll(git, { a: "1\n" });
    await git.addAll();
    const c1 = await git.commit({ message: "one" });
    const t = await git.rewriteTree(await git.treeOf(c1), [{ path: "a", data: enc.encode("2\n") }]);
    const c2 = await git.commitTree(t, [c1], { message: "two" });
    await writeAll(git, { a: "dirty\n" });
    await assert.rejects(git.fastForward(c2), GitError);
    assert.equal(await git.head(), c1);
    await git.restore(["a"]);
    const orphan = await git.commitTree(await git.treeOf(c1), [], { message: "unrelated root" });
    await assert.rejects(git.fastForward(orphan), GitError);
  });
});

describe("batched object reads", () => {
  test("objectInfo and readObjects answer many questions in one command, in order, with missing ones undefined", async () => {
    const git = await newRepo();
    const c1 = await commitFile(git, "a", "one\n");
    const c2 = await commitFile(git, "a", "one\ntwo\n");
    await commitFile(git, "b", "x".repeat(10_000));
    const specs = [`${c1}:a`, `${c2}:a`, `${c1}:b`, "HEAD:b", `${c1}:a`];
    const info = await git.objectInfo(specs);
    assert.deepEqual(info.map((i) => i?.size), [4, 8, undefined, 10_000, 4]);
    assert.deepEqual(info.map((i) => i?.type), ["blob", "blob", undefined, "blob", "blob"]);
    const data = await git.readObjects(specs);
    assert.deepEqual(data.map((d) => (d === undefined ? undefined : dec.decode(d).slice(0, 8))), ["one\n", "one\ntwo\n", undefined, "xxxxxxxx", "one\n"]);
    assert.equal(data[3]?.length, 10_000);
    assert.deepEqual(await git.objectInfo([]), []);
    await assert.rejects(git.objectInfo(["-x"]), GitError);
    await assert.rejects(git.readObjects(["a\nb"]), GitError);
  });

  test("binary content with newlines inside survives", async () => {
    const git = await newRepo();
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);
    await writeFile(join(git.cwd, "bin"), bytes);
    await git.addAll();
    const c = await git.commit({ message: "bin" });
    const [got, again] = await git.readObjects([`${c}:bin`, `${c}:bin`]);
    assert.deepEqual(got, bytes);
    assert.deepEqual(again, bytes);
  });
});

describe("config", () => {
  test("setConfig and getConfig", async () => {
    const git = await newRepo();
    assert.equal(await git.getConfig("chattree.none"), undefined);
    await git.setConfig("chattree.value", "a b=c");
    assert.equal(await git.getConfig("chattree.value"), "a b=c");
    await assert.rejects(git.setConfig("--bad", "x"), GitError);
  });
});

describe("branches", () => {
  test("create, list by prefix, delete", async () => {
    const git = await newRepo();
    const h = await commitFile(git, "a", "1\n");
    await git.createBranch("fork/one", h);
    await git.createBranch("fork/two", "HEAD");
    await git.createBranch("sub/x", "HEAD");
    assert.deepEqual((await git.branches()).map((b) => b.ref).sort(), ["refs/heads/fork/one", "refs/heads/fork/two", "refs/heads/main", "refs/heads/sub/x"]);
    assert.deepEqual((await git.branches("fork/")).map((b) => b.ref).sort(), ["refs/heads/fork/one", "refs/heads/fork/two"]);
    assert.ok((await git.branches("fork/")).every((b) => b.hash === h));
    await git.deleteBranch("fork/one");
    assert.deepEqual((await git.branches("fork/")).map((b) => b.ref), ["refs/heads/fork/two"]);
    await assert.rejects(git.createBranch("fork/two", h), GitError, "existing branch");
    assert.deepEqual((await git.branches("fork/t")).map((b) => b.ref), ["refs/heads/fork/two"], "a prefix may end inside a path component");
    assert.deepEqual(await git.branches("fork/*"), [], "glob characters are literal");
  });

  test("invalid names are refused", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    for (const bad of ["", "-x", "a b", "a..b", "a~1", "a:b", "x.lock", "/x", "x/", "@"]) {
      assert.equal(await git.isValidBranchName(bad), false, JSON.stringify(bad));
      await assert.rejects(git.createBranch(bad, "HEAD"), GitError);
    }
    assert.equal(await git.isValidBranchName("fork/01K8ZQ3M0A5G2W7Y9C4T1R6B8D"), true);
  });

  test("deleting an unmerged branch needs force", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    await git.createBranch("side", "HEAD");
    const side = git.withCwd(git.cwd);
    await side.run(["checkout", "--quiet", "side"]);
    await commitFile(side, "b", "2\n");
    await side.run(["checkout", "--quiet", "main"]);
    await assert.rejects(git.deleteBranch("side"), GitError);
    await git.deleteBranch("side", { force: true });
    assert.deepEqual(await git.branches("side"), []);
  });
});

describe("worktrees", () => {
  test("a new branch in a linked worktree, committed to independently of the main one", async () => {
    const git = await newRepo();
    const base = await commitFile(git, "a", "1\n");
    const wtPath = join(await tempDir(), "wt");
    await git.addWorktree(wtPath, { newBranch: "sub/one", start: base });
    const wt = git.withCwd(wtPath);
    assert.equal(await wt.currentBranch(), "sub/one");
    assert.equal(await wt.version.minor, git.version.minor);
    await commitFile(wt, "child", "c\n");
    assert.equal(await git.readFileAt("HEAD", "child"), undefined);
    assert.ok(await git.readFileAt("sub/one", "child"));
    assert.equal(await git.currentBranch(), "main");
    assert.equal(await wt.commonDir(), await git.commonDir());
    assert.notEqual(await wt.gitDir(), await git.gitDir());

    const list = await git.worktrees();
    assert.deepEqual(list.map((w) => [w.path, w.branch]).sort(), [[git.cwd, "refs/heads/main"], [wtPath, "refs/heads/sub/one"]].sort());
    assert.ok(list.every((w) => !w.bare && !w.detached && !w.locked && !w.prunable));
    assert.equal(list.find((w) => w.path === wtPath)?.head, await wt.head());
  });

  test("an existing branch can be checked out, but not in two worktrees", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    await git.createBranch("topic", "HEAD");
    const p1 = join(await tempDir(), "one");
    await git.addWorktree(p1, { branch: "topic" });
    await assert.rejects(git.addWorktree(join(await tempDir(), "two"), { branch: "topic" }), GitError);
    await assert.rejects(git.addWorktree(join(await tempDir(), "three"), { branch: "main" }), GitError);
  });

  test("remove, then prune", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    const p = join(await tempDir(), "wt");
    await git.addWorktree(p, { newBranch: "tmp", start: "HEAD" });
    await writeFile(join(p, "untracked"), "x");
    await assert.rejects(git.removeWorktree(p), GitError, "refuses with untracked files unless forced");
    await git.removeWorktree(p, { force: true });
    assert.equal((await git.worktrees()).length, 1);
    await git.pruneWorktrees();
    assert.equal((await git.branches("tmp")).length, 1, "the branch outlives its worktree");
  });

  test("a worktree directory deleted behind git's back shows as prunable", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    const p = join(await tempDir(), "wt");
    await git.addWorktree(p, { newBranch: "gone", start: "HEAD" });
    await (await import("node:fs/promises")).rm(p, { recursive: true });
    assert.equal((await git.worktrees()).find((w) => w.path === p)?.prunable, true);
    await git.pruneWorktrees();
    assert.equal((await git.worktrees()).length, 1);
  });

  test("paths with spaces and non-ASCII characters", async () => {
    const git = await newRepo();
    await commitFile(git, "a", "1\n");
    const p = join(await tempDir(), "w t é 中");
    await git.addWorktree(p, { newBranch: "odd", start: "HEAD" });
    assert.ok((await git.worktrees()).some((w) => w.path === p));
  });
});

describe("staging while another handle writes files", () => {
  test("a temp file renamed away between git's listing and its read does not fail the add", async () => {
    const git = await newRepo();
    const host = nodeHost();
    const dir = join(git.cwd, "blobs", "ab");
    await mkdir(dir, { recursive: true });
    let writing = true;
    const writer = (async () => {
      for (let i = 0; writing; i++) await host.fs.writeAtomic(join(dir, `f${i % 40}`), enc.encode(`${i}`.repeat(50)));
    })();
    try {
      for (let i = 0; i < 60; i++) await git.addAll();
    } finally {
      writing = false;
      await writer;
    }
  });

  test("only a vanished temp file is retried", async () => {
    const { isVanishedTempFile } = await import("../../src/git/git.ts");
    const err = (stderr: string) => new GitError("git add failed", { args: [], exitCode: 128, stderr });
    assert.equal(isVanishedTempFile(err("fatal: unable to stat 'blobs/4a/10046c.tmp-838af81d7ec1': No such file or directory")), true);
    assert.equal(isVanishedTempFile(err("fatal: unable to stat 'chat.yml': No such file or directory")), false);
    // Windows words it differently
    assert.equal(isVanishedTempFile(err('error: open("blobs/ab/f24.tmp-d4ac90ea26ec"): No such file or directory\nerror: unable to index file \'blobs/ab/f24.tmp-d4ac90ea26ec\'\nfatal: adding files failed')), true);
    assert.equal(isVanishedTempFile(err("error: open(\"blobs/ab/f1.tmp-d4ac90ea26ec\"): Permission denied")), true);
    assert.equal(isVanishedTempFile(err("error: open(\"chat.yml\"): Permission denied")), false, "not a temp file");
    assert.equal(isVanishedTempFile(new Error("boom")), false);
  });
});
