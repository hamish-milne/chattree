import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { chunk, usageChunk, answer } from "../cli/support.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { nodeHost } from "../../hosts/node.ts";

const host = nodeHost();

const callTools = (...calls: { id: string; name: string; args: object }[]): Reply => ({
  acts: [
    ...calls.map((c, i) =>
      chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }),
    ),
    chunk({}, "tool_calls"),
    usageChunk(30, 8),
    "data: [DONE]\n\n",
  ],
});

/** A project on a scripted model, and a controller on it that records everything it sends. */
async function rig(script: Reply[]) {
  const server = await FakeServer.start(script);
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host, cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml") }, now: Date.now };
  await runInit(env, { dir: project, provider: "compatible", baseUrl: `${server.url}/v1`, model: "qwen3:4b", maxOutput: 256, yes: true });
  const events: UiEvent[] = [];
  /** What a chat view would show after every event so far. */
  const view = new ChatModel(() => {});
  const c = new Controller({
    pollMs: 0,
    env,
    folders: [project],
    session: "test",
    send: (e) => {
      const r = parseEvent(e);
      assert.ok(r.ok, JSON.stringify(r));
      events.push(e);
      view.apply(e);
    },
  });
  c.handle({ type: "ready", view: "chat" });
  await c.idle();
  const types = () => events.map((e) => e.type);
  /** The view built from events must be what opening the thread afresh shows. */
  const matchesSnapshot = async () => {
    const built = structuredClone(view.blocks.value);
    const before = events.length;
    c.handle({ type: "ready", view: "chat" });
    await c.idle();
    const open = events.slice(before).find((e) => e.type === "chat.open");
    assert.ok(open?.type === "chat.open");
    assert.deepEqual(built, open.state.blocks);
  };
  const finish = async () => {
    await c.close();
    await server.close();
  };
  return { c, events, project, server, types, finish, matchesSnapshot, view };
}

describe("the controller, turns", () => {
  test("a message gets an answer: the user block, the stream, then the committed blocks in its place", async () => {
    const { c, events, view, matchesSnapshot, finish } = await rig([answer("Hello there.")]);
    try {
      events.length = 0;
      c.handle({ type: "chat.send", text: "hi" });
      await c.idle();
      const kinds = events.map((e) => e.type);
      assert.ok(kinds.includes("chat.delta"), "streamed");
      const lastBlocks = events.findLast((e) => e.type === "chat.replace" || e.type === "chat.append");
      assert.ok(lastBlocks !== undefined);
      const swapped = events.find((e) => e.type === "chat.replace");
      assert.ok(swapped?.type === "chat.replace" && swapped.from === "live.text", "the stream's block gave way to the committed ones");
      assert.deepEqual(
        view.blocks.value.map((b) => b.type).filter((t) => t !== "notice"),
        ["user", "assistant", "turn_end"],
      );
      await matchesSnapshot();
      const status = events.findLast((e) => e.type === "chat.status");
      assert.ok(status?.type === "chat.status" && status.status.state === "idle");
      const gstat = events.filter((e) => e.type === "graph.status").map((e) => (e as { status: string }).status);
      assert.deepEqual([gstat[0], gstat.at(-1)], ["running", "idle"]);
    } finally {
      await finish();
    }
  });

  test("a call nothing covers waits for the person; yes runs it, and the result and the answer follow", async () => {
    const { c, events, project, matchesSnapshot, finish } = await rig([
      callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }),
      answer("Done."),
    ]);
    try {
      events.length = 0;
      c.handle({ type: "chat.send", text: "write it" });
      await c.idle();
      const ask = events.findLast((e) => e.type === "chat.approval");
      assert.ok(ask?.type === "chat.approval" && ask.approval?.callId === "c1", "asked");
      assert.match(ask.approval.summary, /echo hi/);
      const awaiting = events.findLast((e) => e.type === "graph.status");
      assert.ok(awaiting?.type === "graph.status" && awaiting.status === "awaiting");
      await assert.rejects(readFile(join(project, "out.txt")), /ENOENT/, "not run yet");

      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      assert.equal((await readFile(join(project, "out.txt"), "utf8")).trim(), "hi");
      const cleared = events.filter((e) => e.type === "chat.approval").at(-1);
      assert.ok(cleared?.type === "chat.approval" && cleared.approval === undefined);
      const tool = events
        .flatMap((e) => (e.type === "chat.replace" ? e.blocks : e.type === "chat.update" ? [e.block] : []))
        .findLast((b) => b.type === "tool");
      assert.ok(tool?.type === "tool" && tool.status === "ok");
      assert.deepEqual(
        events.findLast((e) => e.type === "graph.status"),
        { type: "graph.status", thread: "main", status: "idle" },
      );
      await matchesSnapshot();
    } finally {
      await finish();
    }
  });

  test("no ends the call without running it, and the model is told", async () => {
    const { c, project, server, view, matchesSnapshot, finish } = await rig([
      callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }),
      answer("Understood."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "write it" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: false });
      await c.idle();
      await assert.rejects(readFile(join(project, "out.txt")), /ENOENT/);
      assert.equal(server.seen.length, 2);
      const tool = view.blocks.value.find((b) => b.type === "tool");
      assert.ok(tool?.type === "tool" && tool.status === "did_not_run", "declined: the call did not run, and the model was told");
      await matchesSnapshot();
    } finally {
      await finish();
    }
  });

  test("stop at a question ends the turn and leaves the call unrun", async () => {
    const { c, events, view, matchesSnapshot, finish } = await rig([
      callTools({ id: "c1", name: "run", args: { command: "echo hi > out.txt" } }),
      answer("x"),
    ]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      c.handle({ type: "chat.stop" });
      await c.idle();
      const st = events.findLast((e) => e.type === "chat.status");
      assert.ok(st?.type === "chat.status" && st.status.state === "idle");
      const tool = view.blocks.value.find((b) => b.type === "tool");
      assert.ok(tool?.type === "tool" && tool.status !== "awaiting_approval" && tool.status !== "running");
      await matchesSnapshot();
    } finally {
      await finish();
    }
  });

  test("a message with no model to send to is a notice, and nothing is written", async () => {
    const { c, events, finish } = await rig([answer("unused")]);
    try {
      c.handle({ type: "chat.send", text: "" });
      await c.idle();
      assert.ok(!events.some((e) => e.type === "chat.append"));
    } finally {
      await finish();
    }
  });

  test("the setup and environment notes show while the model is still thinking, not after", async () => {
    const { c, view, finish } = await rig([{ acts: [{ hang: true }] }]);
    try {
      c.handle({ type: "chat.send", text: "hi" });
      const shown = () => view.blocks.value.map((b) => b.type);
      const afterUser = () => shown().slice(shown().indexOf("user") + 1);
      const deadline = Date.now() + 5000;
      while ((!shown().includes("user") || afterUser().length === 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(
        afterUser(),
        ["notice"],
        `the notes are committed before the request, so they show before any token: ${shown().join(",")}`,
      );
      c.handle({ type: "chat.stop" });
    } finally {
      await finish();
    }
  });

  const bad: Reply = { status: 400, acts: [JSON.stringify({ error: { message: "a thought signature is missing" } })] };
  const thread = (view: InstanceType<typeof ChatModel>): string => view.thread.value?.name ?? "";

  test("a request that fails after a tool result leaves the thread stalled, and Continue carries on without a message", async () => {
    const { c, events, view, server, finish } = await rig([
      callTools({ id: "c1", name: "run", args: { command: "echo hi" } }),
      bad,
      answer("All done."),
    ]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      assert.equal(server.seen.length, 2, "the continuation was tried and refused");
      const stalled = view.status.value?.stalled;
      assert.match(stalled ?? "", /result/, "the person is told why it stopped");
      assert.equal(view.activity.value, undefined, "nothing is shown as going on");

      events.length = 0;
      c.handle({ type: "chat.resume" });
      await c.idle();
      assert.equal(server.seen.length, 3);
      assert.equal(view.status.value?.stalled, undefined);
      assert.equal(view.blocks.value.filter((b) => b.type === "user").length, 1, "no message was added");
      const last = view.blocks.value.findLast((b) => b.type === "assistant");
      assert.ok(last?.type === "assistant" && last.markdown === "All done.");
    } finally {
      await finish();
    }
  });

  test("a thread rewound to a message of the person's is stalled the same way, and can be continued", async () => {
    const { c, view, server, finish } = await rig([answer("First."), answer("Second.")]);
    try {
      c.handle({ type: "chat.send", text: "hello" });
      await c.idle();
      assert.equal(view.status.value?.stalled, undefined, "an answered thread is finished, not stalled");
      const user = view.blocks.value.find((b) => b.type === "user");
      assert.ok(user?.commit !== undefined);
      c.handle({ type: "thread.rewind", thread: thread(view), commit: user.commit });
      await c.idle();
      assert.match(view.status.value?.stalled ?? "", /message/);
      c.handle({ type: "chat.resume" });
      await c.idle();
      assert.equal(server.seen.length, 2);
      const texts = view.blocks.value.flatMap((b) => (b.type === "assistant" ? [b.markdown] : []));
      assert.deepEqual(texts, ["Second."], "the old answer is gone, and the model answered again");
      assert.equal(view.status.value?.stalled, undefined);
    } finally {
      await finish();
    }
  });

  test("a thread the person stopped is not stalled", async () => {
    const { c, view, finish } = await rig([callTools({ id: "c1", name: "run", args: { command: "echo hi" } })]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      c.handle({ type: "chat.stop" });
      await c.idle();
      assert.equal(view.status.value?.stalled, undefined);
    } finally {
      await finish();
    }
  });

  test("rewinding a message goes to before it and puts its text in the composer; forking does the same on the new thread", async () => {
    const { c, view, events, finish } = await rig([answer("Yes."), answer("Again.")]);
    try {
      c.handle({ type: "chat.send", text: "a question" });
      await c.idle();
      const user = view.blocks.value.find((b) => b.type === "user");
      assert.ok(user?.commit !== undefined);
      const name = thread(view);

      c.handle({ type: "thread.fork", thread: name, commit: user.commit, before: true });
      await c.idle();
      assert.notEqual(thread(view), name, "the chat moved to the fork");
      assert.equal(view.composer.value.draft, "a question");
      assert.ok(!view.blocks.value.some((b) => b.type === "user"), "the fork starts before the message");
      assert.equal(view.status.value?.stalled, undefined, "nothing is owed on it");

      c.handle({ type: "thread.open", thread: name });
      await c.idle();
      assert.equal(view.composer.value.draft, "");
      c.handle({ type: "chat.draft", text: "half typed" });
      c.handle({ type: "thread.rewind", thread: name, commit: user.commit, before: true });
      await c.idle();
      assert.ok(!view.blocks.value.some((b) => b.type === "user" || b.type === "assistant"));
      assert.equal(view.composer.value.draft, "a question\n\nhalf typed", "what was being typed is kept below it");
      assert.ok(events.length > 0);
      c.handle({ type: "chat.send", text: view.composer.value.draft });
      await c.idle();
      assert.equal(view.blocks.value.filter((b) => b.type === "user").length, 1);
    } finally {
      await finish();
    }
  });

  test("the transcript is told what the call is doing: waiting, then streaming, and nothing once it ends", async () => {
    const { c, events, finish } = await rig([
      { acts: [{ wait: 250 }, chunk({ content: "Hi" }), { wait: 50 }, chunk({}, "stop"), usageChunk(10, 2), "data: [DONE]\n\n"] },
    ]);
    try {
      events.length = 0;
      c.handle({ type: "chat.send", text: "hi" });
      await c.idle();
      const phases = events.flatMap((e) => (e.type === "chat.activity" ? [e.activity?.phase ?? "none"] : []));
      assert.deepEqual([...new Set(phases)], ["preparing", "waiting", "streaming", "none"]);
    } finally {
      await finish();
    }
  });

  test("a provider failure that is retried shows as retrying, with the reason and when the next try starts", async () => {
    const { c, events, view, finish } = await rig([
      { status: 503, headers: { "retry-after": "1" }, acts: ["overloaded"] },
      answer("Fine."),
    ]);
    try {
      events.length = 0;
      c.handle({ type: "chat.send", text: "hi" });
      await c.idle();
      const retry = events.flatMap((e) => (e.type === "chat.activity" && e.activity?.phase === "retrying" ? [e.activity] : []))[0];
      assert.ok(retry !== undefined, "the wait was shown");
      assert.match(retry.detail ?? "", /503/);
      assert.ok((retry.until ?? 0) > retry.since && retry.attempt === 2);
      const answered = view.blocks.value.findLast((b) => b.type === "assistant");
      assert.ok(answered?.type === "assistant" && answered.markdown === "Fine.");
    } finally {
      await finish();
    }
  });

  test("what a server attaches to a tool call (Gemini's thought signature) goes back with the call, and its error is shown", async () => {
    const sig = { google: { thought_signature: "c2lnbmF0dXJl" } };
    const { c, server, events, finish } = await rig([
      {
        acts: [
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "c1",
                type: "function",
                function: { name: "run", arguments: JSON.stringify({ command: "echo hi" }) },
                extra_content: sig,
              },
            ],
          }),
          chunk({}, "tool_calls"),
          usageChunk(30, 8),
          "data: [DONE]\n\n",
        ],
      },
      {
        status: 400,
        acts: [
          JSON.stringify([{ error: { code: 400, message: "Function call is missing a thought_signature", status: "INVALID_ARGUMENT" } }]),
        ],
      },
    ]);
    try {
      c.handle({ type: "chat.send", text: "go" });
      await c.idle();
      c.handle({ type: "chat.approve", callId: "c1", allow: true });
      await c.idle();
      const sent = JSON.parse(server.seen[1]?.body ?? "{}") as { messages: { role: string; tool_calls?: { extra_content?: unknown }[] }[] };
      const call = sent.messages.find((m) => m.role === "assistant" && m.tool_calls !== undefined)?.tool_calls?.[0];
      assert.deepEqual(call?.extra_content, sig, "the signature was given back");
      const note = events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
      assert.ok(
        note.some((n) => /thought_signature/.test(n)),
        `the failure says what the server said: ${note.join(" | ")}`,
      );
    } finally {
      await finish();
    }
  });

  test("the model is offered fork and merge; a fork it makes is a thread with its first message waiting in the composer", async () => {
    const { c, server, events, view, finish } = await rig([
      callTools({ id: "c1", name: "fork", args: { name: "topic-a", message: "Look into topic A" } }),
      answer("Started."),
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
      assert.equal(view.composer.value.draft, "Look into topic A");
    } finally {
      await finish();
    }
  });
});
