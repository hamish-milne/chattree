import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { Conversation } from "../../harness/conversation.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (text: string) => ({ $tag: "user" as const, content: [{ $tag: "text" as const, text }] });

async function rig(pollMs = 0) {
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host, cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml") }, now: Date.now };
  await runInit(env, { dir: project, provider: "none" });
  const events: UiEvent[] = [];
  const view = new ChatModel(() => {});
  const c = new Controller({
    pollMs,
    env,
    folders: [project],
    session: "test",
    send: (e) => {
      assert.ok(parseEvent(e).ok);
      events.push(e);
      view.apply(e);
    },
  });
  c.handle({ type: "ready", view: "graph" });
  c.handle({ type: "ready", view: "chat" });
  await c.idle();
  const texts = () => view.blocks.value.flatMap((b) => (b.type === "user" ? [b.text] : []));
  return { c, project, events, texts, view };
}

describe("the controller sees what other processes do", () => {
  test("a message appended from outside appears in the open chat, and the graph has its commit", async () => {
    const { c, project, events, texts } = await rig();
    const before = events.filter((e) => e.type === "graph.data").length;
    const other = await Conversation.open(host, project);
    await other.append(say("typed in a terminal"));
    await other.close();
    await c.refresh();
    assert.deepEqual(texts(), ["typed in a terminal"]);
    assert.equal(events.filter((e) => e.type === "graph.data").length, before + 1);
    // Nothing changed since: nothing is sent again.
    const n = events.length;
    await c.refresh();
    assert.equal(events.length, n);
    await c.close();
  });

  test("a thread made from outside is in the graph", async () => {
    const { c, project, events } = await rig();
    const other = await Conversation.open(host, project);
    await other.newThread("side", { worktree: join(project, "..", "side-wt"), inheritSetup: true });
    await other.close();
    await c.refresh();
    const g = events.findLast((e) => e.type === "graph.data");
    assert.ok(g?.type === "graph.data");
    assert.ok(g.data.threads.some((t) => t.name === "side"));
    await c.close();
  });

  test("our own change is not announced a second time by the next look", async () => {
    const { c, events } = await rig();
    c.handle({ type: "thread.new" });
    await c.idle();
    const n = events.length;
    await c.refresh();
    assert.equal(events.length, n);
    await c.close();
  });

  test("the timer looks by itself", async () => {
    const { c, project, texts } = await rig(20);
    const other = await Conversation.open(host, project);
    await other.append(say("later"));
    await other.close();
    for (let i = 0; i < 100 && texts().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(texts(), ["later"]);
    await c.close();
  });
});
