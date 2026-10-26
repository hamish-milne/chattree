import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (t: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text: t }] });
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const MODEL = { provider: "main", id: "m", settings: { max_output_tokens: 100 } };

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await host.exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

describe("adopt", () => {
  async function repo(files: Record<string, string> = { "app.txt": "code\n" }) {
    const dir = join(await tempDir(), "r");
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q", "--initial-branch=work");
    for (const [f, t] of Object.entries(files)) {
      await mkdir(join(dir, f, ".."), { recursive: true });
      await writeFile(join(dir, f), t);
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "their history");
    return dir;
  }

  test("starts a conversation on the current branch of an existing repository, keeping its history and its ignore and attribute files", async () => {
    const dir = await repo({ "app.txt": "code\n", ".gitignore": "node_modules\n", ".gitattributes": "*.png binary\n" });
    const convo = await Conversation.adopt(host, dir, { config: "limits: { max_request_usd: 1 }\n" });
    assert.equal(convo.branch, "work");
    assert.equal(await git(dir, "rev-list", "--count", "HEAD"), "2");
    assert.match(await readFile(join(dir, ".gitignore"), "utf8"), /^node_modules\n[\s\S]*\/\.chattree\//);
    const attrs = await readFile(join(dir, ".gitattributes"), "utf8");
    assert.match(attrs, /^\*\.png binary\n/);
    assert.match(attrs, /\/chat\.yml -text merge=ours/);
    assert.doesNotMatch(attrs, /^\* -text/m, "the user's other files are not touched by the attributes");
    await convo.setupChange({ model: MODEL });
    await convo.append(say("hello"));
    assert.deepEqual(await verifyHistory(convo), []);
    const again = await Conversation.open(host, dir);
    assert.equal((await entries(again)).length, 3);
  });

  test("refuses a dirty tree, a detached HEAD, a subdirectory, a second conversation and a non-repository", async () => {
    const dirty = await repo();
    await writeFile(join(dirty, "app.txt"), "changed\n");
    await assert.rejects(Conversation.adopt(host, dirty), /uncommitted change/);
    const detached = await repo();
    await git(detached, "checkout", "-q", "--detach");
    await assert.rejects(Conversation.adopt(host, detached), /detached/);
    const sub = await repo({ "sub/app.txt": "x\n" });
    await assert.rejects(Conversation.adopt(host, join(sub, "sub")), ConversationError);
    const twice = await repo();
    await Conversation.adopt(host, twice);
    await assert.rejects(Conversation.adopt(host, twice), /already has a conversation/);
    const plain = join(await tempDir(), "plain");
    await mkdir(plain, { recursive: true });
    await assert.rejects(Conversation.adopt(host, plain), /not a git repository/);
  });

  test("works in a repository with no commits yet", async () => {
    const dir = join(await tempDir(), "empty");
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "-q", "--initial-branch=main");
    const convo = await Conversation.adopt(host, dir);
    await convo.append(say("first"));
    assert.deepEqual(await verifyHistory(convo), []);
  });
});

describe("archiving threads", () => {
  async function fresh() {
    const convo = await Conversation.create(host, join(await tempDir(), "c"));
    await convo.setupChange({ model: MODEL });
    await convo.append(say("hello"));
    return convo;
  }

  test("a zero-diff commit marks a thread archived; any later commit un-archives it", async () => {
    const convo = await fresh();
    const side = await convo.fork(undefined, { name: "side" });
    assert.equal((await convo.listBranches()).find((b) => b.name === "side")?.archived, false);
    const treeBefore = await git(convo.dir, "rev-parse", "side^{tree}");
    assert.equal(await convo.archive("side"), true);
    assert.equal(await convo.archive("side"), false, "already archived");
    assert.equal(await git(convo.dir, "rev-parse", "side^{tree}"), treeBefore, "the commit changes nothing");
    const listed = await convo.listBranches();
    assert.deepEqual(listed.map((b) => [b.name, b.archived]).sort(), [["main", false], ["side", true]]);
    assert.ok(listed.every((b) => b.lastActivity !== "" && b.running === false));
    // the entry index and the transcript are unaffected, and the worktree on the branch stays clean
    const thread = side.conversation as Conversation;
    assert.deepEqual(await git(thread.dir, "status", "--porcelain"), "");
    assert.equal((await thread.index()).filter((r) => r.tag === "branch_start").length, 1);
    await thread.append(say("back to life"));
    assert.equal((await convo.listBranches()).find((b) => b.name === "side")?.archived, false);
    assert.equal(await convo.unarchive("side"), false);
    await assertHistoryInvariants(thread);
    assert.deepEqual(await verifyHistory(thread), []);
  });

  test("the current thread can be archived (an append then adopts the marker), unarchive writes a commit, and the graph shows markers only on request", async () => {
    const convo = await fresh();
    assert.equal(await convo.archive(), true);
    assert.equal((await convo.listBranches())[0]?.archived, true);
    await convo.append(say("still works"));
    assert.equal((await convo.listBranches())[0]?.archived, false);
    await convo.archive();
    assert.equal(await convo.unarchive(), true);
    assert.equal((await convo.listBranches())[0]?.archived, false);
    await assert.rejects(convo.archive("nope"), /no such branch/);
    assert.ok(!(await readCommitGraph(convo)).commits.some((c) => c.kind === "archive" && false));
    await assertHistoryInvariants(convo);
  });

  test("merged: a fork that was merged back is reported, a fresh fork and the thread it came from are not", async () => {
    const convo = await fresh();
    const fork = await convo.fork(undefined, { name: "side" });
    await (fork.conversation as Conversation).append(say("in the fork"));
    await convo.fork(undefined, { name: "unused" });
    assert.deepEqual([...(await convo.mergedBranches())], []);
    await convo.mergeFork(fork.conversation as Conversation, { summary: "decided" });
    assert.deepEqual([...(await convo.mergedBranches())].sort(), ["side"]);
  });
});

describe("new threads", () => {
  test("an empty conversation in its own worktree, with the setup inherited, sharing the repository and its config", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), { config: "limits: { max_request_usd: 2 }\n" });
    await convo.setupChange({ model: MODEL });
    await convo.append(say("the first thread's message"));
    await writeFile(join(convo.dir, "notes.txt"), "workspace edit\n");
    const thread = await convo.newThread("ideas");
    assert.notEqual(thread.dir, convo.dir);
    assert.equal(thread.branch, "ideas");
    const es = await entries(thread);
    assert.deepEqual(es.map((e) => e.$tag), ["header", "branch_start", "agent_setup"]);
    assert.deepEqual((await thread.setup()).model?.id, "m");
    assert.equal((await readFile(join(thread.dir, "harness.yml"), "utf8")).includes("max_request_usd: 2"), true);
    await assert.rejects(readFile(join(thread.dir, "notes.txt")), /ENOENT/, "workspace edits belong to the thread they were made in");
    await thread.append(say("only here"));
    assert.equal((await entries(convo)).filter((e) => e.$tag === "user").length, 1);
    await assertHistoryInvariants(thread);
    assert.deepEqual(await verifyHistory(thread), []);
  });

  test("setup inheritance can be turned off; names must be new and valid", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "c"));
    await convo.setupChange({ model: MODEL });
    const bare = await convo.newThread("bare", { inheritSetup: false });
    assert.equal((await bare.setup()).model, undefined);
    await assert.rejects(convo.newThread("bare"), ConversationError);
    await assert.rejects(convo.newThread("bad name~"), ConversationError);
  });
});
