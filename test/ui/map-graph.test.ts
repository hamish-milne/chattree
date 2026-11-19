import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import type { LeaseState } from "../../harness/lease.ts";
import { emptySetup } from "../../harness/setup.ts";
import type { TipState } from "../../harness/tip.ts";
import { mapGraph } from "../../ui/controller/map-graph.ts";
import { approvalView, reasoningLevel, statusBar, threadBanner, threadStatus } from "../../ui/controller/map-status.ts";
import { parseEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (t: string) => ({ $tag: "user" as const, content: [{ $tag: "text" as const, text: t }] });

test("a repository with a fork, a merged fork and an archived thread maps to a graph the view accepts", async () => {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, {});
  await convo.append(say("first question"));
  const kept = await convo.fork(undefined, { name: "fork/kept" });
  await kept.conversation?.append(say("in the kept fork"));
  const done = await convo.fork(undefined, { name: "fork/done" });
  await done.conversation?.append(say("in the done fork"));
  assert.ok(done.conversation !== undefined);
  await convo.mergeFork(done.conversation, { summary: "decided" });
  await convo.archive("fork/kept");

  const graph = await readCommitGraph(convo);
  const branches = await convo.listBranches();
  const data = mapGraph({ graph, branches, merged: await convo.mergedBranches(), checkedOut: convo.branch });
  const parsed = parseEvent({ type: "graph.data", data });
  assert.ok(parsed.ok, JSON.stringify(parsed));

  assert.equal(data.trunk, convo.branch);
  const by = Object.fromEntries(data.threads.map((t) => [t.name, t]));
  assert.equal(data.threads[0]?.name, convo.branch, "trunk first");
  assert.equal(by[convo.branch]?.kind, "main");
  assert.equal(by[convo.branch]?.checkedOut, true);
  assert.equal(by[convo.branch]?.title, "first question");
  assert.equal(by["fork/kept"]?.kind, "fork");
  assert.equal(by["fork/kept"]?.archived, true);
  assert.equal(by["fork/kept"]?.merged, undefined);
  assert.equal(by["fork/kept"]?.title, "in the kept fork");
  assert.equal(by["fork/done"]?.merged, true);
  const hashes = new Set(data.commits.map((c) => c.hash));
  for (const t of data.threads) {
    assert.ok(hashes.has(t.tip), `${t.name} tip`);
    if (t.name !== convo.branch) assert.ok(t.from !== undefined && hashes.has(t.from), `${t.name} says where it forked`);
  }
  for (const c of data.commits) for (const p of c.parents) assert.ok(hashes.has(p), "parents are in the graph");
  assert.ok(data.commits.some((c) => c.kind === "fork_merge"));
});

const lease = (o: object): LeaseState => ({ state: "live", owner: o, until: 1, holding: [] });
const self = (o: { session?: string }): boolean => o.session === "me";

test("a thread is running here, elsewhere, awaiting a decision, stopped by an error, or idle", () => {
  const live: TipState = { kind: "running", owner: { session: "me" }, holding: [] };
  const other: TipState = { kind: "running", owner: { session: "you" }, holding: [] };
  const idle: TipState = { kind: "awaiting_user" };
  const ask: TipState = {
    kind: "needs_approval",
    calls: [],
    question: { callId: "c", name: "run", args: { command: "ls" }, status: "ask", keys: null },
  };
  const failed: ChatEntry[] = [{ $tag: "interrupted", id: "01HZ00000000000000000000AA", by: "error", partial: [] }];
  assert.equal(threadStatus({ tip: live, entries: [], self }), "running");
  assert.equal(threadStatus({ tip: other, entries: [], self }), "elsewhere");
  assert.equal(threadStatus({ tip: ask, entries: [], self }), "awaiting");
  assert.equal(threadStatus({ tip: idle, entries: failed, self }), "error");
  assert.equal(threadStatus({ tip: idle, entries: [], lease: { state: "stale", owner: {}, until: 0 }, self }), "error");
  assert.equal(threadStatus({ tip: idle, entries: [], lease: lease({}), self }), "idle");
  assert.equal(approvalView(ask.question).summary, "run ls");
});

test("the banner says what stops the thread: an unapproved config first, then a missing provider", () => {
  const trusted = { state: "trusted" as const, hash: "h" };
  assert.equal(threadBanner({ trust: trusted, hasProvider: true }), undefined);
  assert.deepEqual(threadBanner({ trust: trusted, hasProvider: false }), { kind: "no_provider" });
  assert.deepEqual(threadBanner({ trust: { state: "changed", hash: "h" }, hasProvider: false }), { kind: "untrusted", state: "changed" });
});

test("the status bar shows what is known, and leaves out what is not", () => {
  const setup = { ...emptySetup(), model: { provider: "p", id: "m", resolved: "m-2026", settings: { effort: "high", x: 1 } } };
  const info = { context_window: 200_000, reasoning: { low: { effort: "low" }, high: { effort: "high" } } };
  assert.equal(reasoningLevel(setup.model.settings, info), "high");
  const entries: ChatEntry[] = [
    {
      $tag: "assistant",
      id: "01HZ00000000000000000000AB",
      provider: "p",
      model: "m",
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, cache_read_tokens: 900 },
    },
  ];
  const zero = { usd: 0, requests: 0, unpriced: 0 };
  const bar = statusBar({
    state: "idle",
    setup,
    info,
    entries,
    ledger: { conversation: { usd: 0.5, requests: 2, unpriced: 0 }, turn: zero, byModel: {} },
  });
  assert.deepEqual(bar, {
    state: "idle",
    model: "m-2026",
    provider: "p",
    context: { used: 1000, limit: 200_000 },
    thinking: "high",
    usd: 0.5,
  });
  const none = statusBar({
    state: "idle",
    setup,
    entries: [],
    ledger: { conversation: { usd: 0, requests: 1, unpriced: 1 }, turn: zero, byModel: {} },
  });
  assert.deepEqual(none, { state: "idle", model: "m-2026", provider: "p", unpriced: true });
  assert.equal(
    statusBar({ state: "idle", setup: emptySetup(), entries: [], ledger: { conversation: zero, turn: zero, byModel: {} } }),
    undefined,
  );
});
