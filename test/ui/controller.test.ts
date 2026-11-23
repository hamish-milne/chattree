import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { writeFile } from "node:fs/promises";
import { Git } from "../../src/index.ts";
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
    pollMs: 0,
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
  test("a workspace opened on an attached repository shows the conversation above it, marked as attached", async () => {
    const dir = await tempDir();
    const env = { host, cwd: dir, env: { CHATTREE_SETTINGS: join(dir, "settings", "settings.yml") }, now: Date.now };
    const person = { name: "p", email: "p@p" };
    const src = join(dir, "code-src");
    const code = await Git.init(host, src, { branch: "main" });
    await writeFile(join(src, "a.txt"), "one\n");
    await code.add(["."]);
    await code.commit({ message: "c1", author: person, committer: person });
    const project = join(dir, "p");
    await runInit(env, { dir: project, provider: "none" });
    const git = await Git.open(host, { cwd: project });
    await git.run(["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", src, "code"]);
    await git.commit({ message: "attach", author: person, committer: person });
    const events: UiEvent[] = [];
    const c = new Controller({ pollMs: 0, env, folders: [join(project, "code")], send: (e) => events.push(e), session: "test" });
    c.handle({ type: "ready", view: "graph" });
    await c.idle();
    const repos = events.find((e) => e.type === "graph.repos");
    assert.ok(repos?.type === "graph.repos");
    assert.deepEqual(
      repos.repos.repos.map((r) => [r.chattree, r.attachedAs]),
      [[true, "code"]],
    );
    assert.ok(
      events.some((e) => e.type === "graph.data"),
      "the conversation above is open",
    );
    await c.close();
  });

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

  test("an intent that cannot be carried out is a notice, not an exception", async () => {
    const { c, events } = await rig();
    c.handle({ type: "chat.model", model: "x/y" });
    await c.idle();
    assert.equal(events.at(-1)?.type, "notice");
    await c.close();
  });

  test("the chat opens on the checked-out thread: its blocks, the banner for a conversation with no provider, a status with no model", async () => {
    const { project, c, take } = await rig();
    const convo = await Conversation.open(host, project);
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "what is in here?" }] });
    await convo.close();
    c.handle({ type: "ready", view: "chat" });
    await c.idle();
    const open = take("chat.open")[0];
    assert.ok(open?.type === "chat.open");
    const s = open.state;
    assert.deepEqual([s.thread.name, s.thread.kind, s.thread.title], ["main", "main", "what is in here?"]);
    assert.deepEqual(
      s.blocks.map((b) => b.type),
      ["user"],
    );
    assert.deepEqual(s.banner, { kind: "no_provider" });
    assert.deepEqual([s.status.model, s.status.state], ["No model yet", "idle"]);
    assert.deepEqual(s.model, { current: "", options: [] });
    await c.close();
  });

  test("opening another thread at a commit shows it and points at the block that commit holds", async () => {
    const { project, c, take } = await rig();
    const convo = await Conversation.open(host, project);
    const first = await convo.append({ $tag: "user", content: [{ $tag: "text", text: "one" }] });
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "two" }] });
    const fork = await convo.fork(first.id, { name: "side" });
    await fork.conversation?.append({ $tag: "user", content: [{ $tag: "text", text: "on the side" }] });
    await convo.close();
    c.handle({ type: "thread.open", thread: "side", commit: first.commit });
    await c.idle();
    const open = take("chat.open")[0];
    assert.ok(open?.type === "chat.open");
    assert.deepEqual([open.state.thread.name, open.state.thread.kind, open.state.thread.title], ["side", "fork", "on the side"]);
    const reveal = take("chat.reveal")[0];
    assert.ok(reveal?.type === "chat.reveal" && reveal.commit === first.commit);
    assert.deepEqual(take("graph.selected")[0], { type: "graph.selected", thread: "side", commit: first.commit });
    await c.close();
  });
});
