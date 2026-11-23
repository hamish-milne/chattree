/** A project on a scripted model, and a controller on it that records what it sends: the rig of the controller's turn tests. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { runInit } from "../../app/init.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { chunk, usageChunk } from "../cli/support.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";
import { nodeHost } from "../../hosts/node.ts";

const host = nodeHost();

export const callTools = (...calls: { id: string; name: string; args: object }[]): Reply => ({
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
export async function rig(script: Reply[], pollMs = 0) {
  const server = await FakeServer.start(script);
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host, cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml") }, now: Date.now };
  await runInit(env, { dir: project, provider: "compatible", baseUrl: `${server.url}/v1`, model: "qwen3:4b", maxOutput: 256, yes: true });
  const events: UiEvent[] = [];
  /** What a chat view would show after every event so far. */
  const view = new ChatModel(() => {});
  const c = new Controller({
    pollMs,
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
  /** A second controller on the same project, as after the editor was reloaded. */
  const reopen = async () => {
    const v = new ChatModel(() => {});
    const c2 = new Controller({
      pollMs,
      env,
      folders: [project],
      session: "test",
      send: (e) => {
        v.apply(e);
      },
    });
    c2.handle({ type: "ready", view: "chat" });
    await c2.idle();
    return { c: c2, view: v };
  };
  return { c, events, project, server, types, finish, matchesSnapshot, view, reopen };
}
