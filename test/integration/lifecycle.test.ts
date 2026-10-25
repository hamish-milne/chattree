import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { contextEntries } from "../../harness/context.ts";
import { Conversation, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import { readCommitGraph, toMermaid } from "../../harness/graph.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { faultyHost } from "../support/hosts.ts";
import { tempDir } from "../support/tmp.ts";

/**
 * One conversation that uses everything: a working session with tool calls and large outputs, a bulk import,
 * a compaction, a config change, an interruption, a fork that is merged back with a conflict, a fork that is
 * abandoned, two subagents (one clean, one conflicting), and a crash in the middle of an append that the next
 * open repairs. At the end every branch must verify, the events must match the history, and the history is
 * drawn as a commit graph (set CHATTREE_GRAPH_OUT to a path ending in .md to keep it).
 */

const COMMITTER = { name: "chattree", email: "chattree@localhost.invalid" };
const CONFIG = "# which model drives this conversation\nversion: 1\nmodel:\n  provider: anthropic\n  model: claude-sonnet-5-5\ntools:\n  - write_file\n  - run\n";

const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const say = (text: string, ...calls: [id: string, name: string, args: Record<string, unknown>][]): NewEntry => ({
  $tag: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  blocks: [{ $tag: "text", text }, ...calls.map(([call_id, name, args]) => ({ $tag: "tool_call" as const, call_id, name, args }))],
  stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
});
const result = (call_id: string, content: string): NewEntry => ({ $tag: "tool_result", call_id, is_error: false, content });

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
}
const read = (dir: string, name: string): Promise<string | undefined> => readFile(join(dir, name), "utf8").catch(() => undefined);

test("a whole conversation: work, import, compaction, forks, subagents, a crash, and verification", { timeout: 300_000 }, async () => {
  const real = nodeHost();
  const host = faultyHost(real, Infinity); // counts only, until we arm it for the crash
  const events: ConversationEvent[] = [];
  const opts = { committer: COMMITTER, onEvent: (e: ConversationEvent) => void events.push(e) };
  const dir = join(await tempDir(), "wc-agent");

  // ---- 1. a session of work -----------------------------------------------------------------------------------
  let main = await Conversation.create(host, dir, { ...opts, config: CONFIG });
  await put(dir, { "README.md": "# wc\nCounts words.\n", "notes.md": "plan:\n- parse args\n- count\n", "src/wc.ts": "export const wc = (s: string) => s.split(/\\s+/).length;\n" });
  await main.append(user("Build a command-line word counter."));
  const plan = await main.append(say("I'll write the counter and its entry point.", ["t1", "write_file", { path: "src/cli.ts" }]));
  await put(dir, { "src/cli.ts": "import { wc } from './wc.ts';\nconsole.log(wc(process.argv[2] ?? ''));\n" });
  const bigOutput = Array.from({ length: 400 }, (_, i) => `line ${i}: ok`).join("\n");
  await main.append(result("t1", bigOutput)); // large: becomes a blob
  await main.append(say("Done. `node src/cli.ts 'a b c'` prints 3."));
  assert.ok((await main.index()).length >= 5);
  assert.ok((await main.git.text(["ls-tree", "-r", "--name-only", "HEAD", "--", "blobs"])).length > 0, "the large tool output is a blob in the tree");

  // ---- 2. import an earlier exchange in bulk, then compact it ---------------------------------------------------
  const imported = await main.appendMany([
    user("(imported) What encoding should it assume?"),
    say("UTF-8, and treat any Unicode whitespace as a separator."),
    user("(imported) Should it read stdin too?"),
    say("Yes, when no argument is given."),
  ]);
  assert.equal(imported.length, 4);
  await main.compact({ from: imported[0]!.id, to: imported[3]!.id, summary: "Decided: UTF-8, Unicode whitespace, read stdin when no argument." });
  const values = (await main.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const seen = contextEntries(values);
  assert.ok(!seen.some((e) => "id" in e && e.id === imported[1]!.id), "imported turns are summarised away");

  // ---- 3. config change, interruption ---------------------------------------------------------------------------
  await main.changeConfig((doc) => doc.setIn(["model", "model"], "claude-opus-5-5"));
  assert.match((await read(dir, "harness.yml")) ?? "", /# which model drives/);
  await main.append(user("Now add a --lines flag."));
  await main.interrupt({ by: "user", partial: [{ $tag: "text", text: "Sure, I'll start by" }] });
  await main.append(user("Sorry, hit enter early. Add the --lines flag please."));
  await main.append(say("Adding it.", ["t2", "write_file", { path: "src/cli.ts" }]));
  await put(dir, { "src/cli.ts": "import { wc } from './wc.ts';\nconst lines = process.argv.includes('--lines');\nconsole.log(lines ? 1 : wc(process.argv[2] ?? ''));\n" });
  await main.append(result("t2", "ok"));
  const afterFlag = await main.append(say("The flag is in."));

  // ---- 4. fork from an earlier message ("what if I'd asked differently?"), abandon another ----------------------------
  const rethink = await main.fork(plan.id, { name: "fork/rethink" });
  const rethinkConvo = rethink.conversation!;
  await put(rethinkConvo.dir, { "notes.md": "plan:\n- parse args\n- STREAM the input\n", "fork-only.txt": "design sketch\n" });
  await rethinkConvo.append(user("Wait: what if we stream the input instead of reading it all?"));
  await rethinkConvo.append(say("Streaming works: count words per chunk and carry the partial word over."));
  const abandoned = await main.fork(afterFlag.id, { name: "fork/abandoned" });
  await abandoned.conversation!.append(user("Rewrite it in Rust?"));
  await abandoned.conversation!.append(say("Possible, but out of scope here."));

  // main moves on and touches the same file the fork changed
  await put(dir, { "notes.md": "plan:\n- parse args\n- count\n- flags\n" });
  await main.append(user("Let's keep the simple version for now."));
  const forkOutcome = await main.mergeFork(rethinkConvo, { summary: "Discussed streaming; decided to keep reading whole input for now, sketch kept in fork-only.txt." });
  assert.deepEqual(forkOutcome.report.added, ["fork-only.txt"]);
  assert.deepEqual(forkOutcome.report.discarded, ["notes.md"], "both sides edited notes.md: the trunk's version won");
  assert.equal(await read(dir, "notes.md"), "plan:\n- parse args\n- count\n- flags\n");
  assert.equal(await read(dir, "fork-only.txt"), "design sketch\n");

  // ---- 5. two subagents running while the conversation continues ------------------------------------------------------
  await put(dir, { "src/util.ts": "export const words = (s: string) => s.trim().split(/\\s+/);\n" }); // uncommitted work the subagents must see
  const tests = await main.spawnSubagent({ brief: "Write tests for wc().", callId: "t3", name: "sub/tests" });
  const docs = await main.spawnSubagent({ brief: "Document the CLI in the README.", callId: "t4", name: "sub/docs" });
  await put(tests.conversation!.dir, { "test/wc.test.ts": "import { wc } from '../src/wc.ts';\nif (wc('a b') !== 2) throw new Error();\n" });
  await tests.conversation!.append(say("Writing tests.", ["c1", "write_file", { path: "test/wc.test.ts" }]));
  await tests.conversation!.append(result("c1", "ok"));
  await put(docs.conversation!.dir, { "README.md": "# wc\nCounts words.\n\n## Usage\n`wc <text> [--lines]`\n" });
  await docs.conversation!.append(say("Documenting usage.", ["d1", "write_file", { path: "README.md" }]));
  await docs.conversation!.append(result("d1", "ok"));
  await put(dir, { "README.md": "# wc\nA word counter.\n" }); // main edits the README too
  await main.append(user("How are the helpers doing?"));
  const testsOutcome = await main.finishSubagent(tests.conversation!, { summary: "Added a test for wc().", callId: "t3" });
  const docsOutcome = await main.finishSubagent(docs.branch, { summary: "Wrote a Usage section.", callId: "t4" });
  assert.equal(await read(tests.conversation!.dir, "src/util.ts"), "export const words = (s: string) => s.trim().split(/\\s+/);\n", "the subagent started from the snapshot of the workspace");
  assert.deepEqual(testsOutcome.report.added, ["test/wc.test.ts"]);
  assert.deepEqual(docsOutcome.report.discarded, ["README.md"], "the README conflict resolved to the trunk's version");
  assert.equal(await read(dir, "README.md"), "# wc\nA word counter.\n");
  assert.equal(await read(dir, "test/wc.test.ts"), "import { wc } from '../src/wc.ts';\nif (wc('a b') !== 2) throw new Error();\n");

  // ---- 6. a crash in the middle of an append -----------------------------------------------------------------------------
  events.length = 0;
  host.arm(3); // taking the lock and the write to the transcript succeeds, then everything fails, as when a process is killed before it can commit
  await assert.rejects(main.append(say("Both helpers are done; tests and docs are in.")), /injected fault/);
  const torn = await readFile(join(dir, "chat.yml"), "utf8");
  assert.match(torn, /Both helpers are done/, "the entry reached the transcript but never the history");
  appendFileSync(join(dir, "chat.yml"), '- !user\n  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV"\n  content:\n  - !text\n    text: half a sent mes'); // and a torn write after it

  const now = Date.now() + 120_000; // the dead process's lock has gone stale
  main = await Conversation.open(real, dir, { ...opts, now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
  assert.equal(main.recovery.recovered.length, 1);
  assert.ok(main.recovery.truncatedBytes > 0);
  await main.flushEvents();
  assert.deepEqual(events.map((e) => e.type), ["recovery", "entry"]);
  await main.append(user("Great, ship it."));
  await main.append(say("Shipped."));

  // ---- 7. housekeeping: leftovers from the failed append, finished worktrees, helper processes -----------------------------------
  await main.append(user("(a later turn, so the orphan below is swept into a commit)"));
  await main.store.put(new TextEncoder().encode("x".repeat(6000))); // what a failed append would have left behind
  await main.append(user("Tidy up."));
  const gc = await main.gcBlobs();
  assert.equal(gc.tracked.length, 1);
  assert.ok(gc.commit !== undefined);
  const cleanup = await main.pruneWorktrees();
  assert.deepEqual(cleanup.removed.map((r) => r.branch).sort(), ["fork/rethink", "sub/docs", "sub/tests"]);
  assert.deepEqual(cleanup.kept.map((k) => k.branch), ["fork/abandoned"], "an unmerged branch keeps its worktree");
  const objects = await main.git.catFile(); // a long-lived reader left open on purpose
  assert.ok((await objects.read("HEAD:chat.yml")) !== undefined);
  await main.close(); // ends it

  // ---- 8. everything agrees --------------------------------------------------------------------------------------------------
  await main.flushEvents();
  await assertHistoryInvariants(main);
  const branches = (await main.listBranches()).map((b) => b.name).sort();
  assert.deepEqual(branches, ["fork/abandoned", "fork/rethink", "main", "sub/docs", "sub/tests"]);
  for (const b of branches) assert.deepEqual(await verifyHistory(main, { rev: b, deep: true }), [], `branch ${b} verifies`);
  await real.exec("git", ["fsck", "--strict", "--no-dangling"], { cwd: dir }).then((r) => assert.equal(r.exitCode, 0, new TextDecoder().decode(r.stderr)));

  // The events, delivered across a crash and a reopen, add up to the history of every branch.
  const entryEvents = (b: string) => events.filter((e): e is Extract<ConversationEvent, { type: "entry" }> => e.type === "entry" && e.branch === b);
  const mainIds = (await main.index()).map((r) => r.id).filter((x): x is string => x !== undefined);
  assert.ok(entryEvents("main").length > 0);
  assert.deepEqual(entryEvents("main").map((e) => e.entry.id), mainIds.slice(-entryEvents("main").length), "the events seen after the reopen are the tail of main");
  const merges = events.filter((e) => e.type === "merge");
  assert.equal(merges.length, 0, "the merges happened before events were cleared for the crash");

  // The index survives in the cache and matches a from-scratch rebuild.
  await main.flushIndex();
  const cached = await Conversation.open(real, dir);
  const scratch = await Conversation.open(real, dir, { indexCache: false });
  assert.deepEqual(await cached.index(), await scratch.index());

  // The final context: compaction applied, the merges are present as single entries.
  const final = contextEntries((await main.readEntries()).flatMap((e) => (e.ok ? [e.value] : [])));
  const kinds = final.map((e) => e.$tag);
  assert.ok(kinds.includes("compaction") && kinds.includes("fork_merge") && kinds.filter((k) => k === "subagent_result").length === 2);
  assert.ok(!kinds.includes("branch_start"), "a branch's own start marker is not part of the trunk");
  assert.equal(final.filter((e) => e.$tag === "interrupted").length, 1);

  // ---- 9. the picture ------------------------------------------------------------------------------------------------------------
  const graph = await readCommitGraph(main);
  const mermaid = toMermaid(graph);
  assert.equal(graph.commits.filter((c) => c.parents.length > 1).length, 3, "one merge commit per merged branch");
  assert.equal(graph.commits.filter((c) => c.recovered).length, 1);
  assert.equal(graph.commits.filter((c) => c.kind === "snapshot").length > 0, true);
  assert.equal((mermaid.match(/^ {2}merge /gm) ?? []).length, 3);
  assert.equal((mermaid.match(/^ {2}branch /gm) ?? []).length, 4);
  for (const name of ["fork/rethink", "fork/abandoned", "sub/tests", "sub/docs"]) assert.ok(mermaid.includes(`"${name}"`));
  assert.ok(mermaid.includes('tag: "blob gc"') && mermaid.includes('tag: "recovered"') && mermaid.includes('tag: "compaction"') && mermaid.includes('tag: "config"') && mermaid.includes('tag: "interrupted"'));

  const out = process.env["CHATTREE_GRAPH_OUT"];
  if (out !== undefined) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out.replace(/\.md$/, ".mmd"), mermaid);
    await writeFile(out, ["```mermaid", mermaid.trimEnd(), "```", ""].join("\n"));
  }
});
