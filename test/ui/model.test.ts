import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatFixture } from "../../ui/fixtures/chat.ts";
import { configFixture } from "../../ui/fixtures/config.ts";
import { THREADS, graphFixture } from "../../ui/fixtures/graph.ts";
import { chatState } from "../../ui/model/chat.ts";
import { formSpec } from "../../ui/model/form.ts";
import { graphData } from "../../ui/model/graph.ts";
import { event, intent, parseEvent, parseIntent } from "../../ui/model/protocol.ts";
import { safeParse } from "../../src/validate.ts";

const ok = (r: { ok: boolean }, what: string): void => assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);

describe("the fixtures are valid data", () => {
  test("the graph, the chat and the config form match their schemas", () => {
    ok(safeParse(graphData, graphFixture()), "graph");
    ok(safeParse(chatState, chatFixture()), "chat");
    ok(safeParse(formSpec, configFixture()), "config");
  });

  test("the graph is consistent: parents first, every thread listed, tips and fork points exist", () => {
    const g = graphFixture();
    const seen = new Set<string>();
    for (const c of g.commits) {
      for (const p of c.parents) assert.ok(seen.has(p), `${c.hash} comes before its parent ${p}`);
      assert.ok(!seen.has(c.hash), `${c.hash} is repeated`);
      seen.add(c.hash);
    }
    const names = new Set(g.threads.map((t) => t.name));
    assert.equal(names.size, g.threads.length);
    assert.equal(g.threads[0]?.name, g.trunk);
    for (const c of g.commits) assert.ok(names.has(c.thread), `${c.hash} is on an unknown thread ${c.thread}`);
    for (const t of g.threads) {
      assert.ok(seen.has(t.tip), `${t.name} has no tip`);
      assert.equal(g.commits.filter((c) => c.thread === t.name).at(-1)?.hash, t.tip, `${t.name}'s tip is its last commit`);
      if (t.from !== undefined) assert.ok(seen.has(t.from), `${t.name} forks from a commit that does not exist`);
    }
  });

  test("the fixture shows every thread state and every kind of thread", () => {
    const g = graphFixture();
    assert.deepEqual(new Set(g.threads.map((t) => t.status)), new Set(["idle", "running", "awaiting", "elsewhere", "error"]));
    assert.deepEqual(new Set(g.threads.map((t) => t.kind)), new Set(["main", "fork", "subagent"]));
    assert.ok(
      g.commits.some((c) => c.parents.length === 2),
      "there is a merge",
    );
    assert.ok(
      g.commits.some((c) => (c.toolCalls ?? 0) > 1),
      "there is a chain of several tool calls",
    );
  });

  test("the chat's blocks have unique ids and point at commits of the graph", () => {
    const chat = chatFixture();
    const hashes = new Set(graphFixture().commits.map((c) => c.hash));
    const ids = chat.blocks.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const b of chat.blocks)
      if (b.commit !== undefined) assert.ok(hashes.has(b.commit), `${b.id} names a commit that is not in the graph`);
    assert.ok(
      chat.blocks.some((b) => b.type === "reasoning" && b.streaming === true),
      "something is streaming",
    );
    assert.equal(chat.thread.name, THREADS.main);
  });
});

describe("the protocol", () => {
  const tip = graphFixture().threads[0]?.tip ?? "";
  const events: unknown[] = [
    { type: "graph.data", data: graphFixture() },
    { type: "graph.status", thread: "main", status: "running" },
    { type: "graph.selected", thread: "main", commit: tip },
    { type: "chat.open", state: chatFixture() },
    { type: "chat.append", blocks: chatFixture().blocks.slice(0, 2) },
    { type: "chat.update", block: chatFixture().blocks[3] },
    { type: "chat.delta", id: "a1", delta: " more" },
    { type: "chat.thread", thread: chatFixture().thread },
    { type: "chat.status", status: chatFixture().status },
    { type: "chat.models", models: chatFixture().model },
    { type: "chat.composer", composer: { draft: "hi", attachments: [] } },
    { type: "chat.approval", approval: { callId: "c9", name: "run", summary: "run rm -rf build", args: "{}" } },
    { type: "form.set", form: configFixture() },
    { type: "notice", level: "warning", message: "the lock is held by another window" },
  ];
  const intents: unknown[] = [
    { type: "ready", view: "chat" },
    { type: "thread.open", thread: "main", commit: tip },
    { type: "thread.fork", thread: "main", commit: tip, name: "idea" },
    { type: "thread.rewind", thread: "main", commit: tip },
    { type: "thread.merge", from: "idea", into: "main" },
    { type: "chat.send", text: "go" },
    { type: "chat.stop" },
    { type: "chat.draft", text: "wip" },
    { type: "chat.attach" },
    { type: "chat.detach", id: "f1" },
    { type: "chat.approve", callId: "c9", allow: false },
    { type: "chat.model", model: "anthropic/claude-haiku-5-5" },
    { type: "form.edit", id: "harness", value: { limits: {} } },
    { type: "form.save", id: "harness" },
    { type: "form.revert", id: "harness" },
  ];
  const typesOf = (schema: { anyOf?: { properties: { type: { const: string } } }[] }): string[] =>
    (schema.anyOf ?? []).map((m) => m.properties.type.const);

  test("one valid example of every event and every intent is accepted", () => {
    for (const e of events) ok(parseEvent(e), `event ${JSON.stringify(e).slice(0, 60)}`);
    for (const i of intents) ok(parseIntent(i), `intent ${JSON.stringify(i).slice(0, 60)}`);
  });

  test("the examples cover every message the schemas define", () => {
    const names = (xs: unknown[]): string[] => xs.map((x) => (x as { type: string }).type).sort();
    assert.deepEqual(names(events), typesOf(event as never).sort());
    assert.deepEqual(names(intents), typesOf(intent as never).sort());
  });

  test("what a compromised or buggy view could send is refused", () => {
    for (const bad of [
      { type: "thread.fork", thread: "main", commit: "not-a-hash" },
      { type: "thread.fork", thread: "", commit: tip },
      { type: "chat.send", text: 5 },
      { type: "chat.approve", callId: "c9" },
      { type: "chat.send", text: "go", extra: true },
      { type: "launch.missiles" },
      "chat.send",
      null,
    ])
      assert.equal(parseIntent(bad).ok, false, JSON.stringify(bad));
    assert.equal(parseEvent({ type: "graph.status", thread: "main", status: "sleeping" }).ok, false);
  });
});
