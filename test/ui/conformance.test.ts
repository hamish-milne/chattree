import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInit } from "../../app/init.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Controller } from "../../ui/controller/controller.ts";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { parseEvent, type UiEvent, type UiIntent } from "../../ui/model/protocol.ts";
import { answer } from "../cli/support.ts";
import { FakeServer } from "../support/fake-server.ts";
import { tempDir } from "../support/tmp.ts";

/**
 * The views are built against the mock controller and shipped with the real one, so the two have to say the same things: for the
 * same intents, the same kinds of event, each valid by the protocol. What the events contain differs (the mock has fixtures); which
 * events come, and what a view can therefore rely on, must not.
 */
interface Subject {
  /** Send an intent and wait for it to be carried out; the events it caused. */
  step(intent: UiIntent): Promise<UiEvent[]>;
  close(): Promise<void>;
}

async function mock(): Promise<Subject> {
  const events: UiEvent[] = [];
  const c = new MockController({
    emit: (e) => {
      assert.ok(parseEvent(e).ok, JSON.stringify(e));
      events.push(e);
    },
    sleep: () => Promise.resolve(),
  });
  return {
    step: async (intent) => {
      events.length = 0;
      c.handle(intent);
      // The mock's scripted turn stops at an approval, which is waiting for an answer, not working.
      await Promise.race([c.idle(), new Promise((r) => setTimeout(r, 300))]);
      return [...events];
    },
    close: () => Promise.resolve(),
  };
}

async function real(): Promise<Subject & { stop(): Promise<void> }> {
  const server = await FakeServer.start((n) => answer(`reply ${n}`));
  const dir = await tempDir();
  const project = join(dir, "p");
  const env = { host: nodeHost(), cwd: dir, env: { CHATTREE_ENVIRONMENT: "off", CHATTREE_SETTINGS: join(dir, "s.yml") }, now: Date.now };
  await runInit(env, { dir: project, provider: "compatible", baseUrl: `${server.url}/v1`, model: "qwen3:4b", maxOutput: 256, yes: true });
  const events: UiEvent[] = [];
  const c = new Controller({
    pollMs: 0,
    env,
    folders: [project],
    session: "conformance",
    send: (e) => {
      assert.ok(parseEvent(e).ok, JSON.stringify(e));
      events.push(e);
    },
  });
  return {
    step: async (intent) => {
      events.length = 0;
      c.handle(intent);
      await c.idle();
      return [...events];
    },
    close: () => c.close(),
    stop: () => server.close(),
  };
}

const kinds = (events: readonly UiEvent[]): string[] => [...new Set(events.map((e) => e.type))].sort();
/** The thread the graph has selected, from what `ready graph` sent. */
const selected = (events: readonly UiEvent[]): string => {
  const e = events.findLast((x) => x.type === "graph.selected");
  assert.ok(e?.type === "graph.selected" && e.thread !== undefined);
  return e.thread;
};

/**
 * What a view may rely on after each intent: both controllers send at least these. They may send more (the real one tells the
 * graph which thread a chat opened on, the mock plays scripted approvals), so the contract is a floor, not an exact match.
 */
const SCENARIO: { name: string; intent: (main: string) => UiIntent; sends: string[] }[] = [
  { name: "ready graph", intent: () => ({ type: "ready", view: "graph" }), sends: ["graph.data", "graph.repos", "graph.selected"] },
  { name: "ready chat", intent: () => ({ type: "ready", view: "chat" }), sends: ["chat.open", "graph.selected"] },
  { name: "ready config", intent: () => ({ type: "ready", view: "config" }), sends: ["form.set", "instructions.set"] },
  {
    name: "send",
    intent: () => ({ type: "chat.send", text: "say something" }),
    sends: ["chat.append", "chat.composer", "chat.status", "graph.status"],
  },
  { name: "new thread", intent: () => ({ type: "thread.new" }), sends: ["chat.open", "graph.data", "graph.selected"] },
  {
    name: "open the first thread again",
    intent: (main) => ({ type: "thread.open", thread: main }),
    sends: ["chat.open", "graph.selected"],
  },
];

async function lacking(s: Subject): Promise<string[]> {
  const missing: string[] = [];
  let main = "";
  for (const step of SCENARIO) {
    const events = await s.step(step.intent(main));
    if (step.name === "ready graph") main = selected(events);
    const have = new Set(events.map((e) => e.type));
    for (const k of step.sends)
      if (!have.has(k as UiEvent["type"])) missing.push(`${step.name}: no ${k} (sent ${kinds(events).join(", ")})`);
  }
  return missing;
}

describe("the mock and the real controller keep the same promises to the views", () => {
  test("the mock", async () => {
    const m = await mock();
    assert.deepEqual(await lacking(m), []);
  });

  test("the real controller", async () => {
    const r = await real();
    try {
      assert.deepEqual(await lacking(r), []);
    } finally {
      await r.close();
      await r.stop();
    }
  });
});
