import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { answer } from "../cli/support.ts";
import type { Reply } from "../support/fake-server.ts";
import { callTools, rig } from "../support/turns-rig.ts";

describe("the controller, turns that start other threads", () => {
  test("the model is offered fork and merge; a fork it makes is a thread that carries on at once from its brief", async () => {
    const { c, server, events, view, finish } = await rig([
      callTools({ id: "c1", name: "fork", args: { name: "topic-a", message: "Look into topic A" } }),
      answer("Started."),
      answer("Topic A: where shall we begin?"),
    ]);
    try {
      c.handle({ type: "chat.send", text: "split this up" });
      await c.idle();
      const offered = (JSON.parse(server.seen[0]?.body ?? "{}") as { tools?: { function: { name: string } }[] }).tools?.map(
        (t) => t.function.name,
      );
      assert.ok(offered?.includes("fork") && offered.includes("merge"), `offered: ${offered?.join(",")}`);
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      const graph = events.findLast((e) => e.type === "graph.data");
      assert.ok(graph?.type === "graph.data" && JSON.stringify(graph).includes("topic-a"), "the fork is in the graph");
      c.handle({ type: "thread.open", thread: "topic-a" });
      await c.idle();
      assert.equal(view.composer.value.draft, "", "no draft is left: the fork carries on by itself");
      const texts = view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.ok(texts.includes("Topic A: where shall we begin?"), `the fork spoke first: ${texts.join(" | ")}`);
      assert.equal(view.status.value?.stalled, undefined, "not stopped partway");
      const told = server.seen.at(-1)?.body ?? "";
      assert.match(told, /You are now in the fork topic-a[\s\S]*Look into topic A/);
    } finally {
      await finish();
    }
  });

  const handBack = (summary: string): Reply => callTools({ id: "m1", name: "merge", args: { summary } });

  test("a subagent runs in the background, and when it hands back the parent carries on by itself", async () => {
    const { c, server, view, finish } = await rig([
      callTools({ id: "s1", name: "subagent", args: { brief: "count the files", name: "counter" } }),
      handBack("counted 3 files"),
      answer("The subagent counted 3 files."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "delegate" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "s1", allow: true });
      await c.idle();
      assert.equal(server.seen.length, 3, "parent, child, then the parent again");
      const texts = view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.ok(texts.includes("The subagent counted 3 files."), `the parent answered: ${texts.join(" | ")}`);
      assert.equal(view.status.value?.stalled, undefined);
      assert.equal(view.activity.value, undefined);
    } finally {
      await finish();
    }
  });

  test("a question in a subagent shows in the parent, with a way to go there; answering it there lets the work go on", async () => {
    const { c, server, view, events, finish } = await rig([
      callTools({ id: "s1", name: "subagent", args: { brief: "write the file", name: "writer" } }),
      callTools({ id: "r1", name: "run", args: { command: "echo hi > out.txt" } }),
      handBack("wrote it"),
      answer("It is written."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "delegate" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "s1", allow: true });
      await c.idle();
      assert.equal(server.seen.length, 2, "the child is waiting for an answer, and so is everything above it");
      assert.equal(view.blocks.value.length > 0, true);
      const parent = view.thread.value?.name ?? "";
      const q = view.forwarded.value[0];
      assert.ok(q !== undefined && q.tool === "run", `the parent shows the child's question: ${JSON.stringify(view.forwarded.value)}`);
      assert.match(q.summary, /echo hi/);
      assert.equal(view.activity.value?.phase, "blocked", "and says it waits for the child");
      assert.match(view.activity.value?.detail ?? "", /writer/);
      assert.equal(view.status.value?.stalled, undefined, "waiting is not stalling");
      const graph = events.findLast((e) => e.type === "graph.data");
      assert.ok(JSON.stringify(graph).includes('"awaiting"'), "the graph shows who is asking");

      c.handle({ type: "thread.open", thread: q.thread });
      await c.idle();
      assert.equal(view.thread.value?.name, q.thread);
      assert.equal(view.approval.value?.callId, "r1", "the child's own question is the approval there");
      c.handle({ type: "chat.approve", callId: "r1", allow: true });
      await c.idle();
      assert.equal(server.seen.length, 4);
      c.handle({ type: "thread.open", thread: parent });
      await c.idle();
      const texts = view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.ok(texts.includes("It is written."), `the parent went on: ${texts.join(" | ")}`);
      assert.deepEqual(view.forwarded.value, []);
    } finally {
      await finish();
    }
  });

  test("a fork made while the pump is watching does not stall the tool call", async () => {
    const { c, view, finish } = await rig(
      [callTools({ id: "c1", name: "fork", args: { name: "topic-a", message: "Look into topic A" } }), answer("Started.")],
      Number(process.env.POLL ?? 50),
    );
    try {
      c.handle({ type: "chat.send", text: "split this up" });
      await c.idle();
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(view.approval.value?.callId, "c1", "the call waits for the person, and the view shows it");
      assert.equal(view.status.value?.state, "awaiting");
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      const deadline = Date.now() + 15000;
      const texts = (): string[] => view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      while (!texts().includes("Started.") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        texts().includes("Started."),
        `the call finished and the model went on: ${JSON.stringify(view.blocks.value.map((b) => b.type))}`,
      );
    } finally {
      await finish();
    }
  });

  test("several forks made in one turn, with the pump watching, all come out", async () => {
    const { c, view, finish } = await rig(
      [
        callTools(
          { id: "c1", name: "fork", args: { name: "topic-a", message: "A" } },
          { id: "c2", name: "fork", args: { name: "topic-b", message: "B" } },
          { id: "c3", name: "fork", args: { message: "C" } },
        ),
        answer("Started."),
      ],
      20,
    );
    try {
      c.handle({ type: "chat.send", text: "split this up" });
      await c.idle();
      for (const id of ["c1", "c2", "c3"]) {
        const deadline = Date.now() + 5000;
        while (view.approval.value?.callId !== id && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        c.handle({ type: "chat.approve", callId: id, allow: true });
      }
      const deadline = Date.now() + 20000;
      const texts = (): string[] => view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      while (!texts().includes("Started.") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(texts().includes("Started."), `finished: ${JSON.stringify(view.blocks.value.map((b) => b.type))}`);
    } finally {
      await finish();
    }
  });

  test("a background job with no time limit shows in the jobs list and the graph, its terminal fills, and stopping it does not wake the model", async () => {
    const { c, events, server, view, finish } = await rig([
      callTools({
        id: "c1",
        name: "run",
        args: { command: 'node -e "setTimeout(() => {}, 30000)"', background: true, timeout_seconds: 0, name: "waiter" },
      }),
      answer("Started."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      assert.deepEqual(
        view.jobs.value.map((j) => [j.id, j.name, j.daemon, j.status]),
        [["j1", "waiter", true, "running"]],
      );
      const graphJobs = events.filter((e) => e.type === "graph.jobs").at(-1);
      assert.ok(graphJobs?.type === "graph.jobs" && graphJobs.jobs?.count === 1 && !graphJobs.jobs.timed);
      view.watched.value = "j1"; // the view's own state when the person opens the terminal; the rig's view sends nothing
      c.handle({ type: "job.watch", job: "j1" });
      await c.idle();
      assert.match(view.log.value.chunks[0]?.text ?? "", /^\$ node -e /);
      const requests = server.seen.length;
      c.handle({ type: "job.stop", job: "j1" });
      for (let i = 0; i < 100 && view.jobs.value[0]?.status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
      await c.idle();
      assert.equal(view.jobs.value[0]?.status, "stopped");
      const ended = events.filter((e) => e.type === "graph.jobs").at(-1);
      assert.ok(ended?.type === "graph.jobs" && ended.jobs === undefined, "the graph no longer shows a running job");
      assert.equal(server.seen.length, requests, "no request was made for it");
    } finally {
      await finish();
    }
  });

  test("a file the model read and the person then changed is told to the model with the next message, as a diff", async () => {
    const { c, server, project, finish } = await rig([
      callTools({ id: "c1", name: "read", args: { path: "a.txt" } }),
      answer("Read it."),
      answer("Noted."),
    ]);
    try {
      await writeFile(join(project, "a.txt"), "alpha\nbeta\ngamma\n");
      c.handle({ type: "chat.send", text: "read a.txt" });
      await c.idle();
      assert.equal(server.seen.length, 2);
      await writeFile(join(project, "a.txt"), "alpha\nBETA\ngamma\n");
      c.handle({ type: "chat.send", text: "I edited it" });
      await c.idle();
      assert.equal(server.seen.length, 3);
      const last = server.seen.at(-1)?.body ?? "";
      assert.match(last, /changed outside your own file tools/);
      assert.match(last, /-beta/);
      assert.match(last, /\+BETA/);
    } finally {
      await finish();
    }
  });

  test("allowing with a grant offers the keys and covers the next like call", async () => {
    const { c, events, finish } = await rig([
      callTools({ id: "c1", name: "run", args: { command: "echo one" } }),
      callTools({ id: "c2", name: "run", args: { command: "echo one" } }),
      answer("Done."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      const ask = events.findLast((e) => e.type === "chat.approval");
      assert.ok(ask?.type === "chat.approval" && ask.approval?.callId === "c1");
      assert.ok((ask.approval.keys ?? []).length > 0, "keys are offered");
      c.handle({ type: "chat.approve", callId: "c1", allow: true, grant: { seconds: 300, scope: "thread" } });
      await c.idle();
      const last = events.filter((e) => e.type === "chat.approval").at(-1);
      assert.ok(last?.type === "chat.approval" && last.approval === undefined, "the second call needed no answer");
      assert.ok(!events.some((e) => e.type === "chat.approval" && e.approval?.callId === "c2"));
    } finally {
      await finish();
    }
  });

  test("a question a fork asks while the pump runs it is asked when the person goes there", async () => {
    const { c, view, finish } = await rig([
      callTools({ id: "c1", name: "fork", args: { name: "topic-a", message: "Look into topic A" } }),
      answer("Started."),
      callTools({ id: "k1", name: "run", args: { command: "echo from the fork" } }),
      answer("Done there."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "split this up" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      c.handle({ type: "thread.open", thread: "topic-a" });
      await c.idle();
      assert.equal(view.approval.value?.callId, "k1", "the fork's question is shown");
      const call = view.blocks.value.find((b) => b.type === "tool" && b.id === "k1");
      assert.ok(call?.type === "tool" && call.status === "awaiting_approval", "on the call, where the buttons are");
      c.handle({ type: "chat.approve", callId: "k1", allow: true });
      await c.idle();
      const texts = view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.ok(texts.includes("Done there."), `the fork went on: ${texts.join(" | ")}`);
    } finally {
      await finish();
    }
  });

  test("a call that waits for approval is asked again after a reload, wherever the person goes", async () => {
    const { c, finish, reopen } = await rig([
      callTools({ id: "c1", name: "fork", args: { name: "topic-a", message: "Look into topic A" } }),
      answer("Started."),
      callTools({ id: "k1", name: "run", args: { command: "echo from the fork" } }),
      answer("Done there."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "split this up" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      await c.close();
      const again = await reopen();
      again.c.handle({ type: "thread.open", thread: "topic-a" });
      await again.c.idle();
      assert.equal(again.view.approval.value?.callId, "k1", "the question is there again, though nothing was running");
      const call = again.view.blocks.value.find((b) => b.type === "tool" && b.id === "k1");
      assert.ok(
        call?.type === "tool" && call.status === "awaiting_approval",
        "and the call it is about shows it, which is where the buttons are",
      );
      again.c.handle({ type: "chat.approve", callId: "k1", allow: true });
      await again.c.idle();
      const texts = again.view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.ok(texts.includes("Done there."), texts.join(" | "));
      await again.c.close();
    } finally {
      await finish();
    }
  });
});
