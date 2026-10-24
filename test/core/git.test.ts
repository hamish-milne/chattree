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
    assert.ok(compareVersions({ major: 2, minor: 39, patch: 9 }, MIN_GIT_VERSION) < 0);
    assert.ok(compareVersions({ major: 2, minor: 40, patch: 0 }, MIN_GIT_VERSION) === 0);
    assert.ok(compareVersions({ major: 3, minor: 0, patch: 0 }, MIN_GIT_VERSION) > 0);
    assert.equal(formatVersion(MIN_GIT_VERSION), "2.40.0");
  });
});

describe("open", () => {
  const fake = (stdout: string, exitCode = 0): Host => ({
    ...nodeHost(),
    exec: async (): Promise<ExecResult> => ({ exitCode, stdout: enc.encode(stdout), stderr: new Uint8Array(0) }),
  });
  test("rejects a git that is too old, naming both versions", async () => {
    await assert.rejects(Git.open(fake("git version 2.39.3"), { cwd: "/" }), /2\.39\.3 is too old: 2\.40\.0/);
  });
  test("accepts the minimum", async () => {
    assert.deepEqual((await Git.open(fake("git version 2.40.0"), { cwd: "/" })).version, MIN_GIT_VERSION);
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
    await writeFile(join(git.cwd, "café \"q\".txt"), "x");
    await mkdir(join(git.cwd, "dir"));
    await writeFile(join(git.cwd, "dir", "inner"), "x");
    await git.run(["rm", "--quiet", "gone"]);
    const status = (await git.status()).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(status, [
      { code: "??", path: "café \"q\".txt" },
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
