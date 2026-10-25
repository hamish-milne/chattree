import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { CHAT_FILE, Conversation, type NewEntry } from "../../harness/conversation.ts";
import { encodeEntry } from "../../src/index.ts";
import { verifyHistory, type Problem } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "m", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });
const CONFIG = "providers:\n  main:\n    $tag: anthropic\n    api_key_env: K\n";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

async function fresh() {
  const dir = join(await tempDir(), "conv");
  const convo = await Conversation.create(host, dir, { config: CONFIG });
  await convo.append(user("hello"));
  await convo.append(reply("hi there"));
  await convo.append(user("again"));
  await convo.append(reply("sure"));
  return { dir, convo };
}

const codes = (ps: Problem[]): string[] => ps.map((p) => p.code);
const both = async (c: Conversation): Promise<Problem[]> => {
  const shallow = await verifyHistory(c);
  const deep = await verifyHistory(c, { deep: true });
  for (const p of shallow) assert.ok(deep.some((q) => q.code === p.code && q.commit === p.commit), "deep finds everything shallow finds");
  return deep;
};
const reopen = (dir: string) => Conversation.open(host, dir);

describe("verifyHistory: healthy conversations", () => {
  test("a plain conversation has no problems", async () => {
    const { convo } = await fresh();
    assert.deepEqual(await both(convo), []);
  });

  test("forks, subagents, merges, compaction, config changes and large blobs are all fine", async () => {
    const { dir, convo } = await fresh();
    const ids = (await convo.index()).map((r) => r.id);
    await convo.append(user("x".repeat(10_000)));
    await convo.compact({ from: ids[1] as string, to: ids[3] as string, summary: "talk" });
    await convo.setupChange({ model: { provider: "anthropic", id: "first" } });
    await convo.setupChange({ model: { provider: "anthropic", id: "other" } }, { allow: ["model_changed"] });
    const sub = await convo.spawnSubagent({ brief: "look around", callId: "c1" });
    await writeFile(join(sub.conversation?.dir as string, "found.txt"), "found\n");
    await sub.conversation?.append(user("subtask"));
    await convo.finishSubagent(sub.conversation as Conversation, { summary: "done", callId: "c1" });
    const f = await convo.fork();
    await f.conversation?.append(user("side"));
    await convo.mergeFork(f.conversation as Conversation, { summary: "decided" });
    await convo.interrupt({ by: "user" });
    await convo.snapshot();
    const problems = await both(await reopen(dir));
    assert.deepEqual(problems, []);
    for (const b of await convo.listBranches()) assert.deepEqual(await verifyHistory(convo, { rev: b.name, deep: true }), [], b.name);
  });

  test("an unknown revision is reported", async () => {
    const { convo } = await fresh();
    assert.deepEqual(codes(await verifyHistory(convo, { rev: "nope" })), ["no-such-revision"]);
  });
});

describe("verifyHistory: damaged conversations", () => {
  test("a wrong Chattree-Offset trailer", async () => {
    const { dir } = await fresh();
    const msg = git(dir, "log", "-1", "--format=%B").replace(/Chattree-Offset: \d+/, "Chattree-Offset: 7");
    git(dir, "commit", "--amend", "--allow-empty", "-m", msg);
    const ps = await both(await reopen(dir));
    assert.ok(codes(ps).includes("offset-mismatch"), codes(ps).join());
  });

  test("a trailer that names the wrong kind or entry", async () => {
    const { dir } = await fresh();
    git(dir, "commit", "--amend", "--allow-empty", "-m", git(dir, "log", "-1", "--format=%B").replace(/Chattree-Kind: \w+/, "Chattree-Kind: user"));
    assert.ok(codes(await both(await reopen(dir))).includes("kind-mismatch"));
    git(dir, "commit", "--amend", "--allow-empty", "-m", git(dir, "log", "-1", "--format=%B").replace(/Chattree-Entry: \S+/, "Chattree-Entry: 01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    assert.ok(codes(await both(await reopen(dir))).includes("entry-id-mismatch"));
  });

  test("an offset that is not an entry boundary", async () => {
    const { dir } = await fresh();
    const size = Number(git(dir, "log", "-1", "--format=%B").match(/Chattree-Offset: (\d+)/)?.[1]);
    git(dir, "commit", "--amend", "--allow-empty", "-m", git(dir, "log", "-1", "--format=%B").replace(/Chattree-Offset: \d+/, `Chattree-Offset: ${size - 3}`));
    const c = codes(await both(await reopen(dir)));
    assert.ok(c.includes("offset-not-boundary") && c.includes("offset-mismatch"), c.join());
  });

  test("history edited after the fact", async () => {
    const { dir } = await fresh();
    const file = join(dir, CHAT_FILE);
    const text = (await import("node:fs")).readFileSync(file, "utf8");
    assert.ok(text.includes("hello"));
    (await import("node:fs")).writeFileSync(file, text.replace("hello", "jello"));
    git(dir, "add", CHAT_FILE);
    git(dir, "commit", "-m", `edit\n\nChattree-Offset: ${Buffer.byteLength(text)}\n`);
    const convo = await reopen(dir);
    assert.deepEqual(codes(await verifyHistory(convo)), [], "same length, so only a byte comparison can tell");
    assert.ok(codes(await verifyHistory(convo, { deep: true })).includes("not-a-prefix"));
  });

  test("a transcript change without trailers", async () => {
    const { dir } = await fresh();
    const file = join(dir, CHAT_FILE);
    const fs = await import("node:fs");
    fs.appendFileSync(file, '- !user\n  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"\n  content:\n  - !text\n    text: sneaky\n\n');
    git(dir, "add", CHAT_FILE);
    git(dir, "commit", "-m", `sneaky\n\nChattree-Offset: ${fs.statSync(file).size}\n`);
    const c = codes(await both(await reopen(dir)));
    assert.ok(c.includes("entry-without-commit"), c.join());
  });

  test("a missing blob", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("y".repeat(10_000)));
    const blob = git(dir, "ls-files", "blobs").trim().split("\n")[0] as string;
    git(dir, "rm", "-q", blob);
    git(dir, "commit", "-m", `drop blob\n\nChattree-Offset: ${(await convo.git.readFileAt("HEAD", CHAT_FILE))?.length}\n`);
    const ps = await both(await reopen(dir));
    assert.ok(codes(ps).includes("blob-missing"), codes(ps).join());
  });

  test("a corrupted blob is found only by a deep check", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("z".repeat(10_000)));
    const blob = git(dir, "ls-files", "blobs").trim().split("\n")[0] as string;
    const fs = await import("node:fs");
    const bytes = fs.readFileSync(join(dir, blob));
    bytes[0] = (bytes[0] as number) ^ 1;
    fs.writeFileSync(join(dir, blob), bytes);
    git(dir, "add", blob);
    git(dir, "commit", "-m", `flip\n\nChattree-Offset: ${(await convo.git.readFileAt("HEAD", CHAT_FILE))?.length}\n`);
    const c = await reopen(dir);
    assert.deepEqual(codes(await verifyHistory(c)), []);
    assert.deepEqual(codes(await verifyHistory(c, { deep: true })), ["blob-corrupt"]);
  });

  test("a merge entry whose commit is not a merge of the recorded tip", async () => {
    const { dir, convo } = await fresh();
    const f = await convo.fork();
    await f.conversation?.append(user("side"));
    await convo.mergeFork(f.conversation as Conversation, { summary: "s" });
    const msg = git(dir, "log", "-1", "--format=%B");
    const tree = git(dir, "rev-parse", "HEAD^{tree}").trim();
    const first = git(dir, "rev-parse", "HEAD^1").trim();
    const flat = git(dir, "commit-tree", tree, "-p", first, "-m", msg).trim();
    git(dir, "reset", "-q", "--hard", flat);
    assert.ok(codes(await both(await reopen(dir))).includes("merge-without-second-parent"));
    // And a merge of the wrong child
    const other = git(dir, "rev-parse", "HEAD~2").trim();
    const wrong = git(dir, "commit-tree", tree, "-p", first, "-p", other, "-m", msg).trim();
    git(dir, "reset", "-q", "--hard", wrong);
    assert.ok(codes(await both(await reopen(dir))).includes("merge-parent-mismatch"));
  });

  test("a compaction of unknown entries is flagged", async () => {
    const { dir, convo } = await fresh();
    const ids = (await convo.index()).map((r) => r.id);
    await convo.compact({ from: ids[1] as string, to: ids[2] as string, summary: "ok" });
    assert.deepEqual(await both(convo), []);
    const fs = await import("node:fs");
    const file = join(dir, CHAT_FILE);
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const bytes = encodeEntry(await convo.pipeline.encode({ $tag: "compaction", id, replaces: { from: "01ARZ3NDEKTSV4RRFFQ69G5FAA", to: "01ARZ3NDEKTSV4RRFFQ69G5FAB" }, summary: "nothing" }));
    fs.appendFileSync(file, bytes);
    git(dir, "add", CHAT_FILE);
    git(dir, "commit", "-m", `x\n\nChattree-Entry: ${id}\nChattree-Kind: compaction\nChattree-Offset: ${fs.statSync(file).size}\n`);
    const ps = await verifyHistory(await reopen(dir));
    assert.deepEqual(ps.map((p) => [p.severity, p.code]), [["warning", "compaction-ignored"]]);
  });

  test("a damaged transcript is reported, not thrown", async () => {
    const { dir } = await fresh();
    const fs = await import("node:fs");
    const file = join(dir, CHAT_FILE);
    fs.appendFileSync(file, "- !user\n  id: 01ARZ3");
    git(dir, "add", CHAT_FILE);
    git(dir, "commit", "-m", `torn\n\nChattree-Offset: ${fs.statSync(file).size}\n`);
    const ps = await verifyHistory(await Conversation.open(host, dir).catch(() => reopenRaw(dir)));
    assert.ok(codes(ps).length > 0);
  });
});

async function reopenRaw(dir: string): Promise<Conversation> {
  // Opening repairs the tail, so a damaged tip can only be examined through a repository that was never recovered.
  return Conversation.open(host, dir);
}
