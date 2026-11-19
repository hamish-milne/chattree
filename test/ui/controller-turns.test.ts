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
});
