import { effect } from "@preact/signals-core";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatFixture } from "../../ui/fixtures/chat.ts";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { THREADS } from "../../ui/fixtures/graph.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { GraphModel } from "../../ui/model/graph-model.ts";
import { parseEvent, type UiEvent, type UiIntent } from "../../ui/model/protocol.ts";
import type { Block } from "../../ui/model/transcript.ts";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("the chat model", () => {
  const make = () => {
    const sent: UiIntent[] = [];
    const chat = new ChatModel((i) => sent.push(i));
    chat.apply({ type: "chat.open", state: chatFixture() });
    return { chat, sent };
  };

  test("opening a thread shows all of it, and a stream adds to the block it names", () => {
    const { chat } = make();
    assert.equal(chat.thread.value?.name, THREADS.main);
    const streaming = chat.blocks.value.find((b) => b.type === "reasoning" && b.streaming === true);
    assert.ok(streaming);
    const before = chat.blocks.value.length;
    chat.apply({ type: "chat.delta", id: streaming.id, delta: " and so on" });
    const after = chat.blocks.value.find((b) => b.id === streaming.id);
    assert.ok(after?.type === "reasoning" && after.text.endsWith(" and so on"));
    assert.equal(chat.blocks.value.length, before);
    chat.apply({ type: "chat.delta", id: "nothing", delta: "x" });
    assert.equal(chat.blocks.value.length, before);
  });

  test("an update replaces the block with the same id and an unknown one is added", () => {
    const { chat } = make();
    const first = chat.blocks.value[1];
    assert.ok(first?.type === "user");
    chat.apply({ type: "chat.update", block: { ...first, text: "edited" } });
    assert.equal((chat.blocks.value[1] as { text: string }).text, "edited");
    chat.apply({ type: "chat.update", block: { type: "notice", id: "new", kind: "info" as never, level: "info", title: "x" } as Block });
    assert.equal(chat.blocks.value.at(-1)?.id, "new");
  });

  test("busy, the context gauge and whether there is anything to send follow the state", () => {
    const { chat } = make();
    assert.equal(chat.busy.value, true, "the fixture is mid-request");
    assert.ok((chat.contextFraction.value ?? 0) > 0.1 && (chat.contextFraction.value ?? 1) < 0.2);
    assert.equal(chat.canSend.value, false);
    chat.setDraft("  ");
    assert.equal(chat.canSend.value, false, "blank is nothing");
    chat.setDraft("go");
    assert.equal(chat.canSend.value, true);
    const status = chatFixture().status;
    chat.apply({ type: "chat.status", status: { ...status, state: "idle", context: { used: 5 } } });
    assert.equal(chat.busy.value, false);
    assert.equal(chat.contextFraction.value, undefined, "an unknown limit is not a number");
  });

  test("sending clears the draft, and while the thread works the message is marked queued", () => {
    const { chat, sent } = make();
    chat.setDraft("  hello  ");
    chat.send();
    assert.deepEqual(sent.slice(-1), [{ type: "chat.send", text: "hello", queued: true }]);
    assert.equal(chat.composer.value.draft, "");
    chat.apply({ type: "chat.status", status: { ...chatFixture().status, state: "idle" } });
    chat.setDraft("again");
    chat.send();
    assert.deepEqual(sent.slice(-1), [{ type: "chat.send", text: "again" }]);
    chat.send();
    assert.equal(sent.at(-1)?.type, "chat.send");
    assert.equal(sent.filter((i) => i.type === "chat.send").length, 2, "nothing to send, nothing sent");
  });

  test("reasoning is open while it streams; a failed or waiting call is open; the person's toggle inverts that", () => {
    const { chat } = make();
    const reasoning = chat.blocks.value.find((b) => b.type === "reasoning" && b.streaming === true) as Block;
    const failed = chat.blocks.value.find((b) => b.type === "tool" && b.status === "error") as Block;
    const fine = chat.blocks.value.find((b) => b.type === "tool" && b.status === "ok") as Block;
    assert.deepEqual(
      [chat.openBlocks.value.has(reasoning.id), chat.openBlocks.value.has(failed.id), chat.openBlocks.value.has(fine.id)],
      [true, true, false],
    );
    chat.toggle(fine.id);
    chat.toggle(failed.id);
    assert.deepEqual([chat.openBlocks.value.has(fine.id), chat.openBlocks.value.has(failed.id)], [true, false]);
    chat.toggle(fine.id);
    assert.equal(chat.openBlocks.value.has(fine.id), false);
  });

  test("a block can be rewound to when it has a commit that is not the tip and nothing is running", () => {
    const { chat, sent } = make();
    const committed = chat.blocks.value.find((b) => b.commit !== undefined) as Block;
    assert.equal(chat.rewindable.value.has(committed.id), false, "the thread is busy");
    chat.apply({ type: "chat.status", status: { ...chatFixture().status, state: "idle" } });
    assert.equal(chat.rewindable.value.has(committed.id), true);
    assert.equal(
      chat.rewindable.value.has(chat.blocks.value.find((b) => b.commit === chat.thread.value?.tip)?.id ?? ""),
      false,
      "that is the tip",
    );
    assert.equal(
      chat.rewindable.value.has(chat.blocks.value.find((b) => b.commit === undefined)?.id ?? "no-such-block"),
      false,
      "no commit yet",
    );
    chat.rewind(committed.commit ?? "");
    chat.fork(committed.commit ?? "");
    assert.deepEqual(
      sent.map((i) => i.type),
      ["thread.rewind", "thread.fork"],
    );
  });

  test("approval and the model choice send what they should, and choosing the current model sends nothing", () => {
    const { chat, sent } = make();
    chat.apply({ type: "chat.approval", approval: { callId: "c1", name: "run", summary: "run x", args: "{}" } });
    chat.approve(true);
    chat.chooseModel("anthropic/claude-sonnet-5-5");
    chat.chooseModel("anthropic/claude-haiku-5-5");
    assert.deepEqual(sent, [
      { type: "chat.approve", callId: "c1", allow: true },
      { type: "chat.model", model: "anthropic/claude-haiku-5-5" },
    ]);
    chat.apply({ type: "chat.approval" });
    chat.approve(false);
    assert.equal(sent.length, 2, "no pending call, nothing to answer");
  });
  test("a block opened or closed by the person redraws whoever read openBlocks, every time", () => {
    const { chat } = make();
    const fine = chat.blocks.value.find((b) => b.type === "tool" && b.status === "ok") as Block;
    const seen: boolean[] = [];
    const stop = effect(() => void seen.push(chat.openBlocks.value.has(fine.id)));
    chat.toggle(fine.id);
    chat.toggle(fine.id);
    chat.toggle(fine.id);
    stop();
    assert.deepEqual(seen, [false, true, false, true]);
  });

  test("rewindable follows the thread going idle and its tip moving", () => {
    const { chat } = make();
    const committed = chat.blocks.value.find((b) => b.commit !== undefined) as Block;
    const seen: boolean[] = [];
    const stop = effect(() => void seen.push(chat.rewindable.value.has(committed.id)));
    chat.apply({ type: "chat.status", status: { ...chatFixture().status, state: "idle" } });
    chat.apply({ type: "chat.status", status: { ...chatFixture().status, state: "running" } });
    stop();
    assert.deepEqual(seen, [false, true, false]);
  });
});

describe("the mock controller, with the models on top of it", () => {
  const rig = () => {
    const events: UiEvent[] = [];
    const graph = new GraphModel((i) => controller.handle(i));
    const chat = new ChatModel((i) => controller.handle(i));
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
  const untilApproval = async (chat: InstanceType<typeof ChatModel>): Promise<void> => {
    for (let i = 0; i < 50 && chat.approval.value === undefined; i++) await tick();
    assert.ok(chat.approval.value, "the turn asked for approval");
  };
  const tools = (chat: InstanceType<typeof ChatModel>) =>
    chat.blocks.value.filter((b): b is Extract<Block, { type: "tool" }> => b.type === "tool");

  test("every event it sends is valid", async () => {
    const { events, chat, controller } = rig();
    chat.setDraft("make the retry count 5");
    chat.send();
    await untilApproval(chat);
    chat.approve(true);
    await controller.idle();
    assert.ok(events.length > 30);
    for (const e of events) assert.equal(parseEvent(e).ok, true, JSON.stringify(e).slice(0, 120));
  });

  test("a turn streams, waits for approval, runs a failing test, replies and leaves the thread idle", async () => {
    const { graph, chat, controller } = rig();
    const commits = graph.data.value?.commits.length ?? 0;
    chat.setDraft("make the retry count 5");
    chat.send();
    await untilApproval(chat);
    assert.equal(chat.status.value?.state, "awaiting");
    assert.equal(graph.data.value?.threads.find((t) => t.name === THREADS.main)?.status, "awaiting");
    assert.equal(chat.blocks.value.find((b) => b.type === "tool" && b.status === "awaiting_approval") !== undefined, true);
    chat.approve(true);
    await controller.idle();
    const [edit, run] = tools(chat).slice(-2);
    assert.equal(edit?.status, "ok");
    assert.equal(run?.status, "error");
    const kinds = chat.blocks.value.slice(-7).map((b) => b.type);
    assert.deepEqual(kinds, ["user", "reasoning", "assistant", "tool", "tool", "assistant", "turn_end"]);
    assert.ok(
      chat.blocks.value.every((b) => (b.type !== "assistant" && b.type !== "reasoning") || b.streaming !== true),
      "nothing is left streaming",
    );
    const user = chat.blocks.value.at(-7);
    assert.ok(user?.type === "user" && user.commit !== undefined);
    assert.equal(chat.status.value?.state, "idle");
    assert.equal(chat.approval.value, undefined);
    assert.ok((graph.data.value?.commits.length ?? 0) > commits + 3, "the turn's commits are in the graph");
    const tip = graph.data.value?.threads.find((t) => t.name === THREADS.main)?.tip;
    assert.equal(chat.thread.value?.tip, tip, "the chat header follows the graph");
    assert.equal(graph.data.value?.threads.find((t) => t.name === THREADS.main)?.status, "idle");
  });

  test("declining the call means it did not run, and the reply says so", async () => {
    const { chat, controller } = rig();
    chat.setDraft("go");
    chat.send();
    await untilApproval(chat);
    chat.approve(false);
    await controller.idle();
    assert.equal(tools(chat).at(-2)?.status, "did_not_run");
    assert.match((chat.blocks.value.at(-2) as { markdown: string }).markdown, /did not change anything/);
  });

  test("stopping at the approval ends the turn with an interruption and an idle thread", async () => {
    const { chat, graph, controller } = rig();
    chat.setDraft("go");
    chat.send();
    await untilApproval(chat);
    chat.stop();
    await controller.idle();
    const last = chat.blocks.value.at(-1);
    assert.ok(last?.type === "notice" && last.kind === "interrupted");
    assert.equal(chat.status.value?.state, "idle");
    assert.equal(chat.approval.value, undefined);
    assert.equal(graph.data.value?.commits.at(-1)?.kind, "interrupted");
  });

  test("a message sent while the thread works is queued, shown as queued, then handled in turn", async () => {
    const { chat, controller } = rig();
    chat.setDraft("first");
    chat.send();
    await untilApproval(chat);
    chat.setDraft("second");
    chat.send();
    const second = chat.blocks.value.find((b) => b.type === "user" && b.text === "second");
    assert.ok(second?.type === "user" && second.queued === true && second.commit === undefined);
    const firstCall = chat.approval.value?.callId;
    chat.approve(true);
    for (let i = 0; i < 50 && (chat.approval.value === undefined || chat.approval.value.callId === firstCall); i++) await tick();
    assert.notEqual(chat.approval.value?.callId, firstCall, "the queued message's turn asks in its turn");
    chat.approve(true);
    await controller.idle();
    const handled = chat.blocks.value.find((b) => b.type === "user" && b.text === "second");
    assert.ok(handled?.type === "user" && handled.queued !== true && handled.commit !== undefined);
  });

  test("clicking a commit in the graph opens that thread in the chat, and it can be answered there", async () => {
    const { graph, chat, controller } = rig();
    const lint = graph.data.value?.commits.find((c) => c.thread === THREADS.lint && c.kind === "user");
    graph.open(lint?.hash ?? "");
    assert.equal(chat.thread.value?.name, THREADS.lint);
    assert.equal(graph.selected.value.thread, THREADS.lint);
    assert.ok(chat.blocks.value.some((b) => b.type === "user" && /lint warnings/.test(b.text)));
    assert.equal(chat.status.value?.state, "awaiting");
    chat.setDraft("hi");
    chat.send();
    await tick();
    assert.ok(chat.blocks.value.some((b) => b.type === "user" && b.text === "hi"));
    chat.stop();
    await controller.idle();
  });

  test("clicking a commit reveals its block in the chat, also in the thread that is already open", () => {
    const { graph, chat } = rig();
    const toolBlock = chat.blocks.value.find((b) => b.type === "tool" && b.commit !== undefined);
    assert.ok(toolBlock?.commit);
    graph.open(toolBlock.commit);
    assert.equal(chat.reveal.value?.commit, toolBlock.commit);
    const first = chat.reveal.value?.n ?? 0;
    graph.open(toolBlock.commit);
    assert.equal(chat.reveal.value?.n, first + 1, "asking again shows again");
    assert.equal(chat.thread.value?.name, THREADS.main, "the open chat was not reset");
  });

  test("a commit that has no block of its own reveals the nearest block before it", () => {
    const { graph, chat } = rig();
    const result = graph.data.value?.commits.find((c) => c.thread === THREADS.main && c.kind === "tool_result");
    assert.ok(result);
    graph.open(result.hash);
    const shown = chat.reveal.value?.commit;
    assert.ok(shown !== undefined && chat.blocks.value.some((b) => b.commit === shown));
  });

  test("fork makes a thread from a block's commit and opens it; rewinding a message puts its text back in the draft", async () => {
    const { graph, chat, controller } = rig();
    const msg = chat.blocks.value.find((b) => b.type === "user" && b.commit !== undefined);
    assert.ok(msg?.type === "user");
    chat.fork(msg.commit ?? "");
    const fork = chat.thread.value;
    assert.ok(fork && fork.name !== THREADS.main && fork.kind === "fork");
    assert.ok(graph.data.value?.threads.some((t) => t.name === fork.name));
    assert.ok(chat.blocks.value.at(-1)?.type === "notice");
    chat.setDraft("do something else");
    chat.send();
    await untilApproval(chat);
    chat.approve(true);
    await controller.idle();
    const mine = chat.blocks.value.filter((b) => b.type === "user" && b.commit !== undefined).at(-1);
    assert.ok(mine?.type === "user");
    const before = graph.data.value?.commits.length ?? 0;
    chat.rewind(mine.commit ?? "");
    assert.equal(chat.composer.value.draft, "do something else");
    assert.ok((graph.data.value?.commits.length ?? 0) < before);
    assert.ok(!chat.blocks.value.some((b) => b.type === "user" && b.text === "do something else"));
  });

  test("dragging a fork onto the trunk merges it, and the trunk's chat and the graph show the merge", async () => {
    const { graph, controller } = rig();
    const before = graph.data.value?.commits.length ?? 0;
    const tip = graph.data.value?.threads.find((t) => t.name === THREADS.old)?.tip ?? "";
    assert.ok(graph.startDrag(tip));
    graph.dragOver(graph.data.value?.trunk);
    assert.ok(graph.drop());
    await controller.idle();
    assert.equal(graph.data.value?.commits.length, before + 1);
    assert.equal(graph.data.value?.threads.find((t) => t.name === THREADS.old)?.merged, true);
    assert.equal(graph.data.value?.commits.find((c) => c.kind === "fork_merge" && c.summary.includes("undici")) !== undefined, true);
  });

  test("deleting a thread removes it and the commits only it had, and the chat falls back to the trunk", async () => {
    const { graph, chat, controller } = rig();
    graph.open(graph.data.value?.commits.find((c) => c.thread === THREADS.old)?.hash ?? "");
    assert.equal(chat.thread.value?.name, THREADS.old);
    const before = graph.data.value?.commits.length ?? 0;
    const tip = graph.data.value?.threads.find((t) => t.name === THREADS.old)?.tip ?? "";
    graph.act("delete", tip);
    graph.confirmDelete();
    await controller.idle();
    assert.ok(!graph.data.value?.threads.some((t) => t.name === THREADS.old));
    assert.equal(before - (graph.data.value?.commits.length ?? 0), 4, "its own commits, but not the history it forked from");
    assert.equal(chat.thread.value?.name, THREADS.main);
  });

  test("choosing another repository swaps the graph and the chat, and coming back finds the first as it was", async () => {
    const { events, graph, chat, controller } = rig();
    assert.equal(graph.repos.value?.current, "retry-client");
    graph.selectRepo("legacy-api");
    assert.equal(graph.repos.value?.current, "retry-client", "a repository that is not a conversation cannot be chosen");
    graph.selectRepo("docs-site");
    assert.equal(graph.repos.value?.current, "docs-site");
    assert.equal(graph.data.value?.trunk, "master");
    assert.equal(chat.thread.value?.name, "master");
    chat.setDraft("hello");
    chat.send();
    await tick();
    chat.stop();
    await controller.idle();
    graph.selectRepo("retry-client");
    assert.equal(graph.data.value?.trunk, THREADS.main);
    assert.equal(chat.thread.value?.name, THREADS.main);
    assert.ok(events.every((e) => parseEvent(e) !== undefined));
  });

  test("a thread that others were forked from cannot be rewound past them, and says why", () => {
    const { chat, events } = rig();
    const early = chat.blocks.value.find((b) => b.type === "assistant" && b.commit !== undefined);
    chat.rewind(early?.commit ?? "");
    const note = events.findLast((e) => e.type === "notice");
    assert.ok(note?.type === "notice" && note.level === "warning" && /forked/.test(note.message));
  });

  test("merging a finished fork adds a merge commit to the trunk", () => {
    const { graph } = rig();
    const old = graph.data.value?.threads.find((t) => t.name === THREADS.old);
    graph.act("merge", old?.tip ?? "");
    const d = graph.data.value;
    assert.equal(d?.threads.find((t) => t.name === THREADS.old)?.merged, true);
    assert.equal(
      d?.commits.find((c) => c.kind === "fork_merge" && c.parents.includes(old?.tip ?? "x") && c.thread === "main") !== undefined,
      true,
    );
  });

  test("changing the model is an entry on the thread, and the picker and status follow", () => {
    const { chat, graph } = rig();
    const commits = graph.data.value?.commits.length ?? 0;
    chat.chooseModel("anthropic/claude-haiku-5-5");
    assert.equal(chat.models.value?.current, "anthropic/claude-haiku-5-5");
    assert.equal(chat.status.value?.model, "Claude Haiku 5.5");
    const note = chat.blocks.value.at(-1);
    assert.ok(note?.type === "notice" && /Haiku/.test(note.title) && note.commit !== undefined);
    assert.equal(graph.data.value?.commits.length, commits + 1);
  });

  test("model settings are checked as they are edited, and saving makes an entry", () => {
    const { chat, events } = rig();
    const form = chat.settings.value;
    assert.ok(form);
    form.set(["temperature"], 5);
    assert.deepEqual(
      form.spec.value.issues.map((i) => i.message),
      ["must be at most 2"],
    );
    form.save();
    assert.equal(events.findLast((e) => e.type === "notice")?.type, "notice");
    assert.equal(
      chat.blocks.value.at(-1)?.type === "notice" && /changed/.test((chat.blocks.value.at(-1) as { title: string }).title),
      false,
      "no entry while it is wrong",
    );
    form.set(["temperature"], 0.5);
    assert.deepEqual(form.spec.value.issues, []);
    form.save();
    const note = chat.blocks.value.at(-1);
    assert.ok(note?.type === "notice" && note.title === "Model settings changed" && /0\.5/.test(note.detail ?? ""));
    assert.equal(form.spec.value.dirty, false);
  });

  test("the harness.yml form catches a rule across fields, and revert undoes the edit", () => {
    const { controller, events } = rig();
    controller.handle({ type: "ready", view: "config" });
    const first = events.findLast((e) => e.type === "form.set");
    assert.ok(first?.type === "form.set");
    controller.handle({
      type: "form.edit",
      id: "harness",
      value: { ...first.form.value, limits: { max_turn_usd: 80, max_conversation_usd: 50 } },
    });
    const bad = events.findLast((e) => e.type === "form.set");
    assert.ok(bad?.type === "form.set" && bad.form.issues.some((i) => i.path === "limits.max_turn_usd") && bad.form.dirty);
    controller.handle({ type: "form.save", id: "harness" });
    const refused = events.findLast((e) => e.type === "notice");
    assert.ok(refused?.type === "notice" && refused.level === "error");
    controller.handle({ type: "form.revert", id: "harness" });
    const reverted = events.findLast((e) => e.type === "form.set");
    assert.ok(reverted?.type === "form.set" && !reverted.form.dirty);
    controller.handle({
      type: "form.edit",
      id: "harness",
      value: { ...first.form.value, limits: { max_turn_usd: 5, max_conversation_usd: 50 } },
    });
    controller.handle({ type: "form.save", id: "harness" });
    const saved = events.findLast((e) => e.type === "notice");
    assert.ok(saved?.type === "notice" && saved.level === "info" && /committed/.test(saved.message));
  });
});

describe("the mock switches the workspace", () => {
  const rig = () => {
    const events: UiEvent[] = [];
    const graph = new GraphModel((i) => controller.handle(i));
    const controller: MockController = new MockController({
      emit: (e) => {
        events.push(e);
        graph.apply(e);
      },
      sleep: async () => {},
    });
    controller.handle({ type: "ready", view: "graph" });
    return { events, graph, controller };
  };
  const checkedOut = (g: InstanceType<typeof GraphModel>): string[] =>
    (g.data.value?.threads ?? []).filter((t) => t.checkedOut === true).map((t) => t.name);

  test("changes made by hand are asked about first; yes snapshots them on the thread they were on, then switches", () => {
    const { graph, controller, events } = rig();
    controller.handle({ type: "workspace.switch", thread: THREADS.old });
    assert.deepEqual(checkedOut(graph), ["main"], "nothing moved yet");
    assert.deepEqual(graph.switching.value?.files, ["src/http.ts", "notes.md"]);
    controller.handle({ type: "workspace.switch", thread: THREADS.old, uncommitted: "snapshot" });
    assert.deepEqual(checkedOut(graph), [THREADS.old]);
    const snap = graph.data.value?.commits.findLast((c) => c.thread === "main");
    assert.match(snap?.summary ?? "", /snapshot: 2 uncommitted files/);
    // Back again: nothing is uncommitted now, so nothing is asked.
    events.length = 0;
    controller.handle({ type: "workspace.switch", thread: "main" });
    assert.deepEqual(checkedOut(graph), ["main"]);
    assert.equal(
      events.some((e) => e.type === "workspace.uncommitted"),
      false,
    );
  });

  test("remembering the choice stops the question being asked again", () => {
    const { graph, controller, events } = rig();
    controller.handle({ type: "workspace.switch", thread: THREADS.old, uncommitted: "snapshot", remember: true });
    assert.deepEqual(checkedOut(graph), [THREADS.old]);
    assert.ok(events.some((e) => e.type === "notice" && /without asking/.test(e.message)));
  });

  test("a thread that is working cannot be switched to", () => {
    const { graph, controller, events } = rig();
    controller.handle({ type: "workspace.switch", thread: THREADS.lint });
    assert.deepEqual(checkedOut(graph), ["main"]);
    const note = events.findLast((e) => e.type === "notice");
    assert.ok(note?.type === "notice" && note.level === "warning" && /answer/.test(note.message));
  });
});
