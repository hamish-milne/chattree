import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { THREADS, graphFixture } from "../../ui/fixtures/graph.ts";
import type { GraphData } from "../../ui/model/graph.ts";
import { actionsFor, canDragThread, canDropOn } from "../../ui/model/graph-actions.ts";
import { GraphModel } from "../../ui/model/graph-model.ts";
import { layoutGraph, type FoldRow } from "../../ui/model/graph-layout.ts";
import type { UiIntent } from "../../ui/model/protocol.ts";

const folds = (rows: ReturnType<typeof layoutGraph>["rows"]): FoldRow[] => rows.filter((r): r is FoldRow => r.type === "fold");

describe("layout", () => {
  const data = graphFixture();
  const layout = layoutGraph(data);

  test("rows run newest first and every commit is shown by exactly one row", () => {
    const shown = layout.rows.flatMap((r) => (r.type === "fold" ? r.commits.map((c) => c.hash) : [r.id]));
    assert.deepEqual([...shown].sort(), data.commits.map((c) => c.hash).sort());
    assert.equal(layout.rows[0]?.thread, data.commits.at(-1)?.thread);
    for (const c of data.commits) assert.ok(layout.rowOf.has(c.hash));
  });

  test("a chain of tool calls and results is one row, counted by calls", () => {
    const all = folds(layout.rows);
    assert.ok(all.length >= 5);
    const big = all.find((f) => f.thread === THREADS.main && f.calls === 8);
    assert.equal(big?.commits.length, 14, "the first task's rounds of calls and results fold together");
    assert.ok(all.every((f) => f.commits.length >= 2));
  });

  test("a commit another thread points at is never hidden inside a fold", () => {
    const pointedAt = new Set(
      data.commits.flatMap((c) => c.parents.filter((p, i) => i > 0 || data.commits.find((x) => x.hash === p)?.thread !== c.thread)),
    );
    for (const f of folds(layout.rows))
      for (const c of f.commits.slice(0, -1)) assert.ok(!pointedAt.has(c.hash), `${c.hash} is inside a fold`);
    for (const t of data.threads) assert.ok(layout.rowOf.has(t.tip), `${t.name}'s tip has a row`);
  });

  test("a fold that ends at a thread's tip carries the thread", () => {
    const auth = layout.rows.find((r) => r.tipOf === THREADS.auth);
    assert.equal(auth?.type, "fold");
  });

  test("the trunk is lane 0, and a merged thread's lane is reused", () => {
    for (const r of layout.rows) if (r.thread === data.trunk) assert.equal(r.lane, 0);
    const lane = (t: string): number => layout.rows.find((r) => r.thread === t)?.lane ?? -1;
    assert.equal(lane(THREADS.sqlite), 1);
    assert.equal(lane(THREADS.auth), 1, "the subagent starts after the fork was merged, so it takes the freed lane");
    assert.deepEqual(new Set([lane(THREADS.lint), lane(THREADS.bench), lane(THREADS.old)]).size, 3);
    assert.equal(layout.lanes, 5);
  });

  test("edges go from a newer row to an older one, a fork bends at the parent and a merge at the child", () => {
    for (const e of layout.edges) assert.ok(e.from < e.to, "from is above to");
    const merge = layout.edges.find((e) => e.bend === "top");
    assert.ok(merge, "there is a merge edge");
    assert.equal(merge.thread, THREADS.sqlite, "a merge is coloured as the thread merged in");
    assert.equal(merge.fromLane, 0);
    const fork = layout.edges.find((e) => e.thread === THREADS.lint && e.fromLane !== e.toLane);
    assert.equal(fork?.bend, "bottom");
    assert.equal(fork?.toLane, 0);
  });

  test("expanding a fold shows its commits as rows that remember the fold", () => {
    const big = folds(layout.rows).find((f) => f.calls === 8);
    assert.ok(big);
    const opened = layoutGraph(data, new Set([big.id]));
    assert.equal(opened.rows.length, layout.rows.length - 1 + big.commits.length);
    assert.ok(big.commits.every((c) => opened.rows.some((r) => r.type === "commit" && r.id === c.hash && r.foldId === big.id)));
    for (const e of opened.edges) assert.ok(e.from < e.to);
  });

  test("an empty graph and a single commit lay out", () => {
    const one: GraphData = {
      trunk: "main",
      threads: [{ name: "main", kind: "main", status: "idle", tip: "abc1234" }],
      commits: [{ hash: "abc1234", parents: [], thread: "main", kind: "header", summary: "start", time: "2026-11-17T09:00:00.000Z" }],
    };
    assert.equal(layoutGraph(one).rows.length, 1);
    assert.equal(layoutGraph({ ...one, threads: [], commits: [] }).rows.length, 0);
  });
});

describe("actions", () => {
  const data = graphFixture();
  const tipOf = (t: string): string => data.threads.find((x) => x.name === t)?.tip ?? "";
  const byId = (hash: string) => Object.fromEntries(actionsFor(data, hash).map((a) => [a.id, a]));

  test("any commit can be opened and forked", () => {
    const a = byId(data.commits[3]?.hash ?? "");
    assert.equal(a["open"]?.enabled, true);
    assert.equal(a["fork"]?.enabled, true);
    assert.equal(a["rewind"]?.enabled, true);
    assert.equal(a["merge"], undefined, "merge is offered on a fork's tip only");
  });

  test("rewinding to the tip is pointless and says so", () => {
    const a = byId(tipOf(THREADS.main));
    assert.equal(a["rewind"]?.enabled, false);
    assert.match(a["rewind"]?.reason ?? "", /latest/);
  });

  test("a working, waiting or held thread is not rewound or merged, and the reason names why", () => {
    const first = (t: string): string => data.commits.find((c) => c.thread === t && c.kind !== "branch_start")?.hash ?? "";
    assert.match(byId(first(THREADS.auth))["rewind"]?.reason ?? "", /stop/);
    assert.match(byId(first(THREADS.lint))["rewind"]?.reason ?? "", /answer/);
    assert.match(byId(first(THREADS.bench))["rewind"]?.reason ?? "", /another window/);
    assert.match(byId(tipOf(THREADS.lint))["merge"]?.reason ?? "", /answer/);
  });

  test("a finished fork can be merged; a merged one cannot be again; the trunk has no merge", () => {
    assert.equal(byId(tipOf(THREADS.old))["merge"]?.enabled, true);
    assert.equal(byId(tipOf(THREADS.sqlite))["merge"]?.reason, "already merged");
    assert.equal(byId(tipOf(THREADS.main))["merge"], undefined);
    assert.equal(byId(tipOf(THREADS.old))["merge"]?.label, "Merge into main");
  });

  test("an unknown commit has no actions", () => {
    assert.deepEqual(actionsFor(data, "deadbeef"), []);
  });
});

describe("the graph model", () => {
  const make = () => {
    const sent: UiIntent[] = [];
    const model = new GraphModel((i) => sent.push(i));
    model.apply({ type: "graph.data", data: graphFixture() });
    return { sent, model };
  };

  test("it lays out what the controller sent and follows status changes", () => {
    const { model } = make();
    assert.ok((model.layout.value?.rows.length ?? 0) > 10);
    model.apply({ type: "graph.status", thread: THREADS.auth, status: "idle" });
    assert.equal(model.data.value?.threads.find((t) => t.name === THREADS.auth)?.status, "idle");
    assert.equal(model.apply({ type: "chat.delta", id: "x", delta: "" }), false, "events for other views are not its business");
  });

  test("toggling a fold relays the graph and toggling again puts it back", () => {
    const { model } = make();
    const before = model.layout.value?.rows.length ?? 0;
    const fold = model.layout.value?.rows.find((r) => r.type === "fold");
    assert.ok(fold);
    model.toggleFold(fold.id);
    assert.ok((model.layout.value?.rows.length ?? 0) > before);
    model.toggleFold(fold.id);
    assert.equal(model.layout.value?.rows.length, before);
  });

  test("an available action sends its intent; an unavailable one sends nothing", () => {
    const { model, sent } = make();
    const data = model.data.value;
    const tip = data?.threads.find((t) => t.name === THREADS.old)?.tip ?? "";
    model.openMenu(tip, 10, 20);
    assert.deepEqual(
      model.menuActions.value.map((a) => [a.id, a.enabled]),
      [
        ["open", true],
        ["fork", true],
        ["rewind", false],
        ["merge", true],
      ],
      "an unavailable action stays in the menu, greyed out",
    );
    model.act("merge", tip);
    assert.deepEqual(sent, [{ type: "thread.merge", from: THREAD_OLD, into: "main" }]);
    assert.equal(model.menu.value, undefined, "the menu closes");
    sent.length = 0;
    model.act("rewind", tip); // it is the tip: refused
    model.act("merge", data?.threads.find((t) => t.name === THREADS.sqlite)?.tip ?? ""); // already merged
    assert.deepEqual(sent, []);
    model.act("fork", tip);
    assert.deepEqual(sent, [{ type: "thread.fork", thread: THREAD_OLD, commit: tip }]);
  });

  test("a click opens the commit's thread at that commit", () => {
    const { model, sent } = make();
    const c = model.data.value?.commits.find((x) => x.thread === THREADS.lint && x.kind === "user");
    model.open(c?.hash ?? "");
    assert.deepEqual(sent, [{ type: "thread.open", thread: THREADS.lint, commit: c?.hash }]);
  });
});

const THREAD_OLD = THREADS.old;

describe("what is lit in the graph", () => {
  test("the commit under the pointer and its thread are lit, and a context menu keeps them lit when the pointer leaves", () => {
    const g = new GraphModel(() => {});
    g.apply({ type: "graph.data", data: graphFixture() });
    const c = g.data.value?.commits.find((x) => x.thread === THREADS.lint);
    assert.ok(c);
    const lit = () => g.lit.value;
    assert.deepEqual(lit(), { commit: undefined, thread: undefined });
    g.setHover(c.hash);
    assert.deepEqual(lit(), { commit: c.hash, thread: THREADS.lint });
    g.openMenu(c.hash, 5, 5);
    g.setHover(undefined);
    assert.deepEqual(lit(), { commit: c.hash, thread: THREADS.lint }, "lit while the menu is open");
    g.closeMenu();
    assert.equal(lit().commit, undefined);
  });
});

describe("dragging a thread to merge it", () => {
  const make = () => {
    const sent: UiIntent[] = [];
    const g = new GraphModel((i) => sent.push(i));
    g.apply({ type: "graph.data", data: graphFixture() });
    const tip = (name: string): string => g.data.value?.threads.find((t) => t.name === name)?.tip ?? "";
    return { g, sent, tip };
  };

  test("the trunk, a merged thread and a busy one cannot be picked up, and the reason says why", () => {
    const { g } = make();
    const data = graphFixture();
    assert.match(canDragThread(data, data.trunk).reason ?? "", /trunk/);
    const merged = data.threads.find((t) => t.merged === true);
    assert.ok(merged);
    assert.match(canDragThread(data, merged.name).reason ?? "", /merged/);
    assert.match(canDragThread(data, THREADS.lint).reason ?? "", /answer/);
    assert.equal(canDragThread(data, THREADS.old).ok, true);
    assert.equal(g.startDrag(graphFixture().commits.find((c) => c.thread === THREADS.lint)?.hash ?? ""), false);
    assert.equal(g.drag.value, undefined);
  });

  test("a drop is allowed on another idle thread, not on itself, a merged or a busy thread", () => {
    const data = graphFixture();
    assert.equal(canDropOn(data, THREADS.old, data.trunk).ok, true);
    assert.equal(canDropOn(data, THREADS.old, THREADS.old).ok, false);
    assert.match(canDropOn(data, THREADS.old, THREADS.lint).reason ?? "", /answer/);
    const merged = data.threads.find((t) => t.merged === true);
    assert.match(canDropOn(data, THREADS.old, merged?.name ?? "").reason ?? "", /already merged/);
  });

  test("dropping on a valid thread sends the merge; dropping elsewhere, or cancelling, sends nothing", () => {
    const { g, sent, tip } = make();
    assert.ok(g.startDrag(tip(THREADS.old)));
    g.setHover(tip(THREADS.old));
    assert.equal(g.lit.value.commit, undefined, "nothing is lit by the pointer while dragging");
    g.dragOver(THREADS.lint);
    assert.equal(g.dropTarget.value?.ok, false);
    assert.equal(g.drop(), false);
    assert.deepEqual(sent, []);
    assert.equal(g.drag.value, undefined, "the drag ends either way");

    assert.ok(g.startDrag(tip(THREADS.old)));
    g.dragOver(g.data.value?.trunk);
    assert.deepEqual(g.dropTarget.value, { thread: g.data.value?.trunk, ok: true });
    assert.equal(g.drop(), true);
    assert.deepEqual(sent, [{ type: "thread.merge", from: THREADS.old, into: g.data.value?.trunk }]);

    assert.ok(g.startDrag(tip(THREADS.old)));
    g.cancelDrag();
    assert.equal(g.drop(), false);
    assert.equal(sent.length, 1);
  });
});
