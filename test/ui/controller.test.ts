import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { Conversation } from "../../harness/conversation.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { parseEvent, type UiEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();

/** A project with no provider (init needs no network for that) and a controller on it. */
async function rig(extra: string[] = []) {
  const dir = await tempDir();
  const env = { host, cwd: dir, env: { CHATTREE_SETTINGS: join(dir, "settings", "settings.yml") }, now: Date.now };
  const project = join(dir, "p");
  await runInit(env, { dir: project, provider: "none" });
  const events: UiEvent[] = [];
  const c = new Controller({
    env,
    folders: [project, ...extra.map((e) => join(dir, e))],
    send: (e) => {
      // Everything the controller sends must be something the views accept.
      const r = parseEvent(e);
      assert.ok(r.ok, JSON.stringify(r));
      events.push(e);
    },
    session: "test",
  });
  const take = (type: UiEvent["type"]) => events.filter((e) => e.type === type);
  return { dir, project, c, events, take };
}

describe("the controller, reading", () => {
  test("the graph view gets the repositories, the graph and the selected thread", async () => {
    const { project, c, events } = await rig();
    c.handle({ type: "ready", view: "graph" });
    await c.idle();
    assert.deepEqual(
      events.map((e) => e.type),
      ["graph.repos", "graph.data", "graph.selected"],
    );
    const [repos, data] = events;
    assert.ok(repos?.type === "graph.repos" && data?.type === "graph.data");
    assert.deepEqual(
      repos.repos.repos.map((r) => [r.id, r.chattree]),
      [[project, true]],
    );
    assert.equal(repos.repos.current, project);
    assert.equal(data.data.threads.length, 1);
    assert.equal(data.data.threads[0]?.checkedOut, true);
    await c.close();
  });

  test("a fork made by someone else shows up on the next snapshot, merged and archived flags included", async () => {
    const { project, c, events } = await rig();
    const convo = await Conversation.open(host, project);
    await convo.fork(undefined, { name: "idea" });
    await convo.close();
    c.handle({ type: "ready", view: "graph" });
    await c.idle();
    const data = events.find((e) => e.type === "graph.data");
    assert.deepEqual(data?.type === "graph.data" && data.data.threads.map((t) => t.name).sort(), ["idea", "main"]);
    await c.close();
  });

  test("a folder with no conversation is listed with how it can start one, and cannot be selected", async () => {
    const { c, events, take } = await rig(["empty"]);
    c.handle({ type: "ready", view: "graph" });
    c.handle({ type: "repo.select", id: "nope" });
    await c.idle();
    const repos = take("graph.repos")[0];
    assert.ok(repos?.type === "graph.repos");
    const empty = repos.repos.repos.find((r) => r.name === "empty");
    assert.ok(empty !== undefined && !empty.chattree);
    assert.match(events.at(-1)?.type === "notice" ? (events.at(-1) as { message: string }).message : "", /no folder nope/);
    await c.close();
  });

  test("what is not built yet is a notice, not an exception", async () => {
    const { c, events } = await rig();
    c.handle({ type: "chat.stop" });
    await c.idle();
    assert.equal(events.at(-1)?.type, "notice");
    await c.close();
  });
});
