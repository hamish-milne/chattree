import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git, LockHeldError, acquireLock, encodeEntry, parseFile, scan } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";
import { CHAT_FILE, Conversation, ConversationError, describeEntry, type NewEntry } from "../../harness/conversation.ts";
import { ULID_RE } from "../../harness/ulid.ts";
import { faultyHost } from "../support/hosts.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const dec = new TextDecoder();

const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const assistantEntry = (text: string, extra: Partial<Extract<NewEntry, { $tag: "assistant" }>> = {}): NewEntry => ({
  $tag: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  blocks: [{ $tag: "text", text }],
  stop_reason: "end_turn",
  ...extra,
});
const toolCall: NewEntry = assistantEntry("running", {
  blocks: [{ $tag: "tool_call", call_id: "c1", name: "run", args: { command: "ls" } }],
  stop_reason: "tool_use",
});
const toolResult = (content: string, call_id = "c1"): NewEntry => ({ $tag: "tool_result", call_id, is_error: false, content });

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}): Promise<{ dir: string; convo: Conversation }> {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(host, dir, opts) };
}

describe("create", () => {
  test("makes a repository with a header entry, attributes and one commit", async () => {
    const { dir, convo } = await fresh();
    assert.equal(convo.branch, "main");
    const entries = await convo.readEntries();
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.ok && entries[0].value.$tag === "header");
    const log = await convo.git.log("HEAD");
    assert.equal(log.length, 1);
    assert.equal(log[0]?.subject, "Start conversation");
    assert.deepEqual(log[0]?.trailers["Chattree-Kind"], ["header"]);
    assert.deepEqual(log[0]?.trailers["Chattree-Offset"], [String(convo.size)]);
    assert.equal(log[0]?.trailers["Chattree-Entry"], undefined, "a header has no id");
    assert.match(await readFile(join(dir, ".gitattributes"), "utf8"), /^chat\.yml merge=ours$/m);
    assert.equal(await convo.git.getConfig("merge.ours.driver"), "true");
    assert.equal(await convo.git.isClean(), true);
    await assertHistoryInvariants(convo);
  });

  test("refuses an existing repository", async () => {
    const { dir } = await fresh();
    await assert.rejects(Conversation.create(host, dir), ConversationError);
  });

  test("the first branch can be named", async () => {
    const { convo } = await fresh({ branch: "trunk" });
    assert.equal(convo.branch, "trunk");
    assert.equal(await convo.git.currentBranch(), "trunk");
  });
});

describe("append", () => {
  test("one commit per entry, with ids, trailers, offsets and authors", async () => {
    const { convo } = await fresh({
      committer: { name: "Harness", email: "h@example.com" },
      user: { name: "Ada", email: "ada@example.com" },
    });
    const a = await convo.append(user("Fix the failing test"));
    const b = await convo.append(toolCall);
    const c = await convo.append(toolResult("ok\n"));
    const d = await convo.append(assistantEntry("Done."));
    for (const r of [a, b, c, d]) assert.match(r.id, ULID_RE);
    assert.ok(a.id < b.id && b.id < c.id && c.id < d.id, "ids sort in creation order");
    assert.equal(d.offset, convo.size);

    const log = (await convo.git.log("HEAD")).reverse();
    assert.equal(log.length, 5);
    assert.deepEqual(log.slice(1).map((l) => l.hash), [a, b, c, d].map((r) => r.commit));
    assert.deepEqual(log.slice(1).map((l) => l.trailers["Chattree-Entry"]?.[0]), [a.id, b.id, c.id, d.id]);
    assert.deepEqual(log.slice(1).map((l) => l.trailers["Chattree-Kind"]?.[0]), ["user", "assistant", "tool_result", "assistant"]);
    assert.deepEqual(log.slice(1).map((l) => l.subject), ["user: Fix the failing test", "assistant: tool_use, 1 tool call", "tool_result: c1", "assistant: end_turn"]);
    assert.deepEqual(log.map((l) => l.authorName), ["Harness", "Ada", "claude-sonnet-5-5", "Harness", "claude-sonnet-5-5"]);
    assert.equal(log[2]?.authorEmail, "anthropic@models.chattree.invalid");
    assert.ok(log.every((l) => l.committerName === "Harness"));
    await assertHistoryInvariants(convo);

    const entries = await convo.readEntries();
    assert.deepEqual(entries.map((e) => (e.ok ? e.tag : "invalid")), ["header", "user", "assistant", "tool_result", "assistant"]);
  });

  test("an id supplied by the caller is kept", async () => {
    const { convo } = await fresh();
    const r = await convo.append({ ...user("x"), id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D" });
    assert.equal(r.id, "01K8ZQ3M0A5G2W7Y9C4T1R6B8D");
  });

  test("an invalid entry changes nothing", async () => {
    const { convo } = await fresh();
    const before = await convo.readTranscript();
    const head = await convo.git.head();
    await assert.rejects(convo.append({ $tag: "user", content: [{ $tag: "text", text: 5 }] } as unknown as NewEntry));
    await assert.rejects(convo.append({ $tag: "mystery" } as unknown as NewEntry));
    await assert.rejects(convo.append({ ...user("x"), extra: 1 } as unknown as NewEntry));
    assert.deepEqual(await convo.readTranscript(), before);
    assert.equal(await convo.git.head(), head);
    assert.equal(convo.size, before.length);
    await convo.append(user("still works"));
  });

  test("working-tree changes are committed with the next entry; ignored files are not", async () => {
    const { dir, convo } = await fresh();
    await writeFile(join(dir, ".gitignore"), "scratch.log\n");
    await writeFile(join(dir, "notes.md"), "# notes\n");
    await writeFile(join(dir, "scratch.log"), "noise\n");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "export {}\n");
    const r = await convo.append(user("first"));
    assert.deepEqual((await convo.git.diff(`${r.commit}~1`, r.commit)).map((d) => d.path).sort(), [".gitignore", CHAT_FILE, "notes.md", "src/a.ts"]);
    assert.equal(await convo.git.isClean(), true);
    await writeFile(join(dir, "notes.md"), "# notes\nmore\n");
    const r2 = await convo.append(assistantEntry("edited"));
    assert.deepEqual((await convo.git.diff(`${r2.commit}~1`, r2.commit)).map((d) => d.path).sort(), [CHAT_FILE, "notes.md"]);
  });

  test("large values become blobs committed with the entry that uses them", async () => {
    const { dir, convo } = await fresh({ pipeline: { threshold: 200 } });
    const big = "line of output\n".repeat(200);
    const r = await convo.append(toolResult(big));
    const changed = (await convo.git.diff(`${r.commit}~1`, r.commit)).map((d) => d.path);
    assert.equal(changed.filter((p) => p.startsWith("blobs/")).length, 1);
    assert.ok(changed.includes(CHAT_FILE));
    const entries = await convo.readEntries();
    const last = entries.at(-1);
    assert.ok(last?.ok && last.value.$tag === "tool_result");
    const content = (last.value as { content: { $tag: string; sha256: string } }).content;
    assert.equal(content.$tag, "blob");
    assert.equal(dec.decode(await convo.store.get(content.sha256)), big);
    assert.equal(await convo.git.isClean(), true);
    assert.ok((await convo.readTranscript()).length < 600, "the transcript stays small");
  });

  test("secrets are redacted before they reach the transcript or a blob", async () => {
    const { dir, convo } = await fresh({ pipeline: { threshold: 100, redact: [/sk-[A-Za-z0-9]{16,}/g] } });
    await convo.append(user("my key is sk-ABCDEFGHIJKLMNOP1234"));
    await convo.append(toolResult(`sk-ABCDEFGHIJKLMNOP1234\n${"x\n".repeat(200)}`));
    const all = await readFile(join(dir, CHAT_FILE), "utf8");
    assert.ok(!all.includes("sk-ABCDEFGH"));
    const { stdout } = await host.exec("grep", ["-r", "sk-ABCDEFGH", dir, "--exclude-dir=.git", "-l"], { cwd: dir });
    assert.equal(dec.decode(stdout), "");
  });

  test("concurrent appends are serialized in call order", async () => {
    const { convo } = await fresh();
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => convo.append(user(`message ${i}`))));
    assert.equal(new Set(results.map((r) => r.commit)).size, 15);
    const entries = await convo.readEntries();
    const texts = entries.slice(1).map((e) => (e.ok && e.value.$tag === "user" ? (e.value.content[0] as { text: string }).text : "?"));
    assert.deepEqual(texts, Array.from({ length: 15 }, (_, i) => `message ${i}`));
    assert.deepEqual(results.map((r) => r.offset), results.map((r) => r.offset).sort((a, b) => a - b));
    await assertHistoryInvariants(convo);
  });

  test("a handle whose transcript was changed by someone else refuses to write", async () => {
    const { dir, convo } = await fresh();
    const other = await Conversation.open(host, dir);
    await other.append(user("from the other handle"));
    await assert.rejects(convo.append(user("from the stale handle")), /expected \d+.*reopen/);
    const reopened = await Conversation.open(host, dir);
    await reopened.append(user("after reopening"));
    await assertHistoryInvariants(reopened);
  });

  test("unusual text survives: newlines, quotes, control characters, astral characters", async () => {
    const { convo } = await fresh();
    const text = `tab\there "quoted" 'single'\nsecond line\n\n  indented${String.fromCharCode(27)}[31m ${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x2028)} end\n`;
    await convo.append(user(text));
    const last = (await convo.readEntries()).at(-1);
    assert.ok(last?.ok && last.value.$tag === "user");
    assert.equal((last.value.content[0] as { text: string }).text, text);
    await assertHistoryInvariants(convo);
  });
});

describe("locking", () => {
  const lockOpts = { owner: "test", timeoutMs: 0 };

  test("a held lock blocks writers with an error that names the holder", async () => {
    const { dir, convo } = await fresh({ lock: { timeoutMs: 0 } });
    const lockPath = join(dir, ".git", "chattree", "locks", "main.lock");
    const held = await acquireLock(host.fs, lockPath, lockOpts);
    await assert.rejects(convo.append(user("blocked")), (e) => e instanceof LockHeldError && /test/.test(e.message));
    await held.release();
    await convo.append(user("now fine"));
  });

  test("a stale lock is taken over", async () => {
    let now = 1_000_000;
    const { dir, convo } = await fresh({ now: () => now, lock: { timeoutMs: 0, staleAfterMs: 30_000 } });
    const lockPath = join(dir, ".git", "chattree", "locks", "main.lock");
    await acquireLock(host.fs, lockPath, { owner: "crashed", now: () => now, timeoutMs: 0 }); // never released
    await assert.rejects(convo.append(user("too soon")), LockHeldError);
    now += 31_000;
    await convo.append(user("after the lock went stale"));
  });

  test("an unreadable lock file is not ours and is replaced", async () => {
    const { dir, convo } = await fresh({ lock: { timeoutMs: 0 } });
    await writeFile(join(dir, ".git", "chattree", "locks", "main.lock"), "garbage");
    await convo.append(user("ok"));
  });

  test("release does nothing if the lock was taken over meanwhile", async () => {
    let now = 0;
    const { dir } = await fresh();
    const path = join(dir, "x.lock");
    const first = await acquireLock(host.fs, path, { owner: "a", now: () => now, timeoutMs: 0 });
    now += 100_000;
    const second = await acquireLock(host.fs, path, { owner: "b", now: () => now, timeoutMs: 0, staleAfterMs: 1000 });
    assert.equal(await first.release(), false);
    assert.equal(await host.fs.stat(path) !== undefined, true, "the new holder's lock is intact");
    assert.equal(await second.release(), true);
  });

  test("waiting acquires the lock once it is released", async () => {
    const { dir } = await fresh();
    const path = join(dir, "y.lock");
    const held = await acquireLock(host.fs, path, lockOpts);
    const waiter = acquireLock(host.fs, path, { owner: "waiter", timeoutMs: 5000, retryMs: 10 });
    setTimeout(() => void held.release(), 60);
    const got = await waiter;
    assert.equal(got.info.owner, "waiter");
    await got.release();
  });
});

describe("failed writes are rolled back", () => {
  test("a failing commit leaves the transcript and HEAD as they were", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("one"));
    const before = await convo.readTranscript();
    const head = await convo.git.head();

    // Make the next commit fail: an index.lock makes git refuse.
    const lockFile = join(dir, ".git", "index.lock");
    await writeFile(lockFile, "");
    await assert.rejects(convo.append(user("doomed")));
    await rm(lockFile);

    assert.deepEqual(await convo.readTranscript(), before);
    assert.equal(await convo.git.head(), head);
    assert.equal(convo.size, before.length);
    await convo.append(user("works again"));
    await assertHistoryInvariants(convo);
  });
});

describe("open and recovery", () => {
  test("reopening a clean conversation changes nothing", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("x"));
    const head = await convo.git.head();
    const reopened = await Conversation.open(host, dir);
    assert.deepEqual(reopened.recovery, { truncatedBytes: 0, recovered: [] });
    assert.equal(reopened.size, convo.size);
    assert.equal(await reopened.git.head(), head);
  });

  test("an incomplete entry at the end is removed", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("kept"));
    const good = await convo.readTranscript();
    await appendFile(join(dir, CHAT_FILE), "- !assistant\n  id: \"01K8ZQ3N7E4H0X2P5V9J3S1K6F\"\n  prov");
    const reopened = await Conversation.open(host, dir);
    assert.ok(reopened.recovery.truncatedBytes > 0);
    assert.deepEqual(reopened.recovery.recovered, []);
    assert.deepEqual(await reopened.readTranscript(), good);
    await reopened.append(user("after repair"));
    await assertHistoryInvariants(reopened);
  });

  test("a cut in the middle of a multi-byte character is repaired the same way", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("kept"));
    const good = await convo.readTranscript();
    const partial = new TextEncoder().encode('- !user\n  id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F"\n  content:\n  - !text\n    text: "caf' + String.fromCodePoint(0xe9));
    await appendFile(join(dir, CHAT_FILE), partial.subarray(0, partial.length - 1));
    const reopened = await Conversation.open(host, dir);
    assert.deepEqual(await reopened.readTranscript(), good);
  });

  test("complete entries that were never committed are committed, one commit each", async () => {
    const { dir, convo } = await fresh();
    const a = await convo.append(user("committed"));
    // A crash after the append but before the commit leaves complete entries in the file, uncommitted.
    for (const input of [user("lost one"), assistantEntry("lost two")]) {
      const withId = { ...input, id: `01K8ZQ3N7E4H0X2P5V9J3S1K${input.$tag === "user" ? "6F" : "6G"}` };
      await appendFile(join(dir, CHAT_FILE), encodeEntry(await convo.pipeline.encode(withId)));
    }

    const reopened = await Conversation.open(host, dir);
    assert.equal(reopened.recovery.truncatedBytes, 0);
    assert.deepEqual(reopened.recovery.recovered.map((r) => r.tag), ["user", "assistant"]);
    const log = await reopened.git.log("HEAD");
    assert.equal(log.length, 4);
    assert.deepEqual(log[0]?.trailers["Chattree-Recovered"], ["true"]);
    assert.deepEqual(log[1]?.trailers["Chattree-Recovered"], ["true"]);
    assert.equal(log[2]?.hash, a.commit);
    assert.deepEqual(log.slice(0, 2).reverse().map((l) => l.trailers["Chattree-Entry"]?.[0]), reopened.recovery.recovered.map((r) => r.id));
    await assertHistoryInvariants(reopened);
    assert.equal(await reopened.git.isClean(), true);
  });

  test("an uncommitted entry that does not validate stops open and changes nothing", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("ok"));
    const bad = '- !user\n  id: "not-a-ulid"\n  content: []\n\n';
    await appendFile(join(dir, CHAT_FILE), bad);
    const head = await convo.git.head();
    await assert.rejects(Conversation.open(host, dir), /uncommitted entry 3.*not valid/);
    assert.equal(await convo.git.head(), head);
    assert.ok((await readFile(join(dir, CHAT_FILE), "utf8")).endsWith(bad));
  });

  test("an uncommitted entry that is not in canonical form stops open too", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("ok"));
    await appendFile(join(dir, CHAT_FILE), '- !user\n  id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F"\n  content: []   # comment\n\n');
    await assert.rejects(Conversation.open(host, dir), /uncommitted entry 3 .*not valid/);
  });

  test("a transcript edited in place is refused", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("original"));
    const text = await readFile(join(dir, CHAT_FILE), "utf8");
    await writeFile(join(dir, CHAT_FILE), text.replace("original", "tampered"));
    await assert.rejects(Conversation.open(host, dir), /does not extend the version at HEAD/);
  });

  test("a transcript shortened behind our back is refused", async () => {
    const { dir, convo } = await fresh();
    await convo.append(user("x"));
    await truncate(join(dir, CHAT_FILE), convo.size - 10);
    await assert.rejects(Conversation.open(host, dir), ConversationError);
  });

  test("repositories that are not conversations, or are in an odd state, are refused", async () => {
    const empty = join(await tempDir(), "plain");
    await Git.init(host, empty, {});
    await assert.rejects(Conversation.open(host, empty), /not a conversation repository|unknown revision|bad revision/);

    const { dir, convo } = await fresh();
    await convo.git.run(["checkout", "--quiet", "--detach"]);
    await assert.rejects(Conversation.open(host, dir), /detached/);
  });
});

describe("describeEntry", () => {
  test("subjects are single, bounded lines", () => {
    const long = `first line\nsecond ${"x".repeat(200)}`;
    const s = describeEntry({ $tag: "user", id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D", content: [{ $tag: "text", text: long }] });
    assert.ok(!s.includes("\n"));
    assert.ok(Array.from(s).length <= 66);
    assert.match(s, /^user: first line second/);
  });
});

describe("crash at every step", () => {
  /**
   * Run `act` on a host that dies at the Nth side-effecting operation, for every N, then reopen with a healthy
   * host (as a restarted process would) and check the repository: valid history at every commit, the
   * transcript committed in full, the interrupted entry either wholly present or wholly absent, and the
   * conversation still usable.
   */
  async function sweep(name: string, setup: (c: Conversation) => Promise<void>, act: (c: Conversation) => Promise<unknown>): Promise<void> {
    const probeDir = join(await tempDir(), "probe");
    const probeHost = faultyHost(host, Infinity);
    const probe = await Conversation.create(probeHost, probeDir);
    await setup(probe);
    probeHost.arm(Infinity);
    const opsBefore = probeHost.ops;
    await act(probe);
    const total = probeHost.ops - opsBefore;
    assert.ok(total >= 4, `${name}: expected several operations, saw ${total}`);

    for (let k = 1; k <= total; k++) {
      const dir = join(await tempDir(), `crash-${k}`);
      const h = faultyHost(host, Infinity);
      const victim = await Conversation.create(h, dir);
      await setup(victim);
      const before = (await victim.readEntries()).length;

      h.arm(k);
      await assert.rejects(act(victim), (e) => e instanceof Error && /injected fault/.test(e.message), `${name}: operation ${k} of ${total} should have failed`);
      const trail = h.log.join(" | ");

      // Restart: the dead process's lock file is old by now.
      const now = Date.now() + 120_000;
      const restarted = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(restarted);
      const after = (await restarted.readEntries()).length;
      assert.ok(after === before || after === before + 1, `${name} @${k}/${total}: ${before} -> ${after} entries (${trail})`);
      const status = await restarted.git.status();
      const unexpected = status.filter((s) => s.path === CHAT_FILE || (!s.path.startsWith("blobs/") && s.path !== "work.txt"));
      assert.deepEqual(unexpected, [], `${name} @${k}/${total}: the transcript must be committed (${trail})`);
      await restarted.append(user("life goes on"));
      await assertHistoryInvariants(restarted);
      assert.equal((await restarted.readEntries()).length, after + 1);
    }
  }

  test("appending a user entry", async () => {
    await sweep("user entry", async (c) => void (await c.append(user("before"))), (c) => c.append(user("the interrupted one")));
  });

  test("appending a tool result that creates a blob and a workspace file", async () => {
    await sweep(
      "large result",
      async (c) => void (await c.append(user("before"))),
      async (c) => {
        await writeFile(join(c.dir, "work.txt"), "work\n");
        return c.append(toolResult("big\n".repeat(2000)));
      },
    );
  });
});
