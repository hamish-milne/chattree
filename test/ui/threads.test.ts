import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { THREADS, graphFixture } from "../../ui/fixtures/graph.ts";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { actionsFor, withoutArchived } from "../../ui/model/graph-actions.ts";
import type { GraphData } from "../../ui/model/graph.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { GraphModel } from "../../ui/model/graph-model.ts";
import { parseEvent, type UiEvent, type UiIntent } from "../../ui/model/protocol.ts";

const archive = (data: GraphData, ...names: string[]): GraphData => ({
  ...data,
  threads: data.threads.map((t) => (names.includes(t.name) ? { ...t, archived: true } : t)),
});
const tipOf = (d: GraphData, name: string): string => d.threads.find((t) => t.name === name)?.tip ?? "";

describe("archiving threads", () => {
  test("the menu offers to archive a thread that is idle and not the trunk or the one checked out, and to unarchive an archived one", () => {
    const d = graphFixture();
    const on = (name: string, data = d) => actionsFor(data, tipOf(data, name));
    assert.equal(on(THREADS.old).find((a) => a.id === "archive")?.enabled, true);
    assert.match(on(THREADS.main).find((a) => a.id === "archive")?.reason ?? "", /trunk/);
    assert.match(on(THREADS.lint).find((a) => a.id === "archive")?.reason ?? "", /answer/);
    const gone = archive(d, THREADS.old);
    assert.equal(on(THREADS.old, gone).find((a) => a.id === "unarchive")?.enabled, true);
    assert.equal(
      on(THREADS.old, gone).some((a) => a.id === "archive"),
      false,
    );
  });

  test("archived threads and their commits leave the graph; a commit that had one as a parent loses that parent", () => {
    const d = graphFixture();
    const { data, hidden } = withoutArchived(archive(d, THREADS.old));
    assert.equal(hidden, 1);
    assert.equal(
      data.threads.some((t) => t.name === THREADS.old),
      false,
    );
    assert.equal(
      data.commits.some((c) => c.thread === THREADS.old),
      false,
    );
    const known = new Set(data.commits.map((c) => c.hash));
    for (const c of data.commits) for (const p of c.parents) assert.ok(known.has(p), "no parent points at a hidden commit");
    assert.equal(withoutArchived(d).data, d, "nothing archived: the same graph");
  });

  test("a thread that a shown thread was forked from stays, however it was archived", () => {
    const d = graphFixture();
    const base = d.commits.find((c) => c.thread === THREADS.sqlite)?.hash;
    assert.ok(base);
    const nested: GraphData = { ...d, threads: d.threads.map((t) => (t.name === THREADS.old ? { ...t, from: base } : t)) };
    const kept = withoutArchived(archive(nested, THREADS.sqlite));
    assert.equal(kept.hidden, 0);
    assert.ok(kept.data.threads.some((t) => t.name === THREADS.sqlite));
    const both = withoutArchived(archive(nested, THREADS.sqlite, THREADS.old));
    assert.equal(both.hidden, 2, "once the fork is hidden too, so is its parent");
  });

  test("the model counts archived threads, hides them until asked, and sends the intents from the menu", () => {
    const sent: UiIntent[] = [];
    const g = new GraphModel((i) => sent.push(i));
    g.apply({ type: "graph.data", data: archive(graphFixture(), THREADS.old) });
    assert.equal(g.archivedCount.value, 1);
    assert.equal(
      g.shown.value?.threads.some((t) => t.name === THREADS.old),
      false,
    );
    g.toggleArchived();
    assert.equal(
      g.shown.value?.threads.some((t) => t.name === THREADS.old),
      true,
    );
    const tip = tipOf(graphFixture(), THREADS.old);
    g.act("unarchive", tip);
    g.act("archive", tip);
    assert.deepEqual(sent, [{ type: "thread.unarchive", thread: THREADS.old }]);
    g.apply({ type: "graph.data", data: graphFixture() });
    g.act("archive", tip);
    assert.deepEqual(sent.at(-1), { type: "thread.archive", thread: THREADS.old });
  });
});

describe("the mock controller: new and archived threads", () => {
  const rig = () => {
    const events: UiEvent[] = [];
    const graph: InstanceType<typeof GraphModel> = new GraphModel((i) => controller.handle(i));
    const chat: InstanceType<typeof ChatModel> = new ChatModel((i) => controller.handle(i));
    const controller: MockController = new MockController({
      emit: (e) => {
        events.push(e);
        graph.apply(e);
        chat.apply(e);
      },
      sleep: async () => {},
    });
    controller.handle({ type: "ready", view: "graph" });
    controller.handle({ type: "ready", view: "chat" });
    return { events, graph, chat, controller };
  };

  test("a new thread starts from the trunk's latest commit and the chat opens on it", () => {
    const { graph, chat, events } = rig();
    const trunkTip = tipOf(graph.data.value as GraphData, THREADS.main);
    events.length = 0;
    graph.newThread();
    const t = graph.data.value?.threads.at(-1);
    assert.equal(t?.from, trunkTip);
    assert.equal(t?.title, "New thread");
    assert.equal(chat.thread.value?.name, t?.name);
    assert.equal(graph.selected.value.thread, t?.name);
    for (const e of events) assert.equal(parseEvent(e).ok, true, e.type);
  });

  test("an archived thread leaves the graph; unarchiving brings it back; the trunk and the thread that is working refuse", () => {
    const { graph, controller, events } = rig();
    controller.handle({ type: "thread.archive", thread: THREADS.old });
    assert.equal(graph.archivedCount.value, 1);
    assert.equal(
      graph.shown.value?.threads.some((t) => t.name === THREADS.old),
      false,
    );
    controller.handle({ type: "thread.unarchive", thread: THREADS.old });
    assert.equal(graph.archivedCount.value, 0);
    events.length = 0;
    controller.handle({ type: "thread.archive", thread: THREADS.main });
    controller.handle({ type: "thread.archive", thread: THREADS.lint });
    assert.deepEqual(
      events.map((e) => e.type),
      ["notice", "notice"],
    );
    assert.equal(graph.archivedCount.value, 0);
  });
});
