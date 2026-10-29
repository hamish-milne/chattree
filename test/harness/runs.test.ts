import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { syncTools, type LoopEvent } from "../../harness/loop.ts";
import { ThreadRuns } from "../../harness/runs.ts";
import { ToolRegistry } from "../../harness/tools.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import { ProviderError, type Completed } from "../../providers/types.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
type Reply = Completed | ((signal: AbortSignal) => Promise<Completed>);
let queue: Reply[] = [];
const usage = { input_tokens: 1, output_tokens: 1 };
const answer = (t: string): Completed => ({ blocks: [{ type: "text", text: t }], stop_reason: "end_turn", usage, observed: { model: "m1" }, ext: {} });
const hang = (signal: AbortSignal): Promise<Completed> => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError({ kind: "aborted", message: "aborted" })), { once: true }));

const adapters = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    models: () => ({}),
    create: () => ({
      $tag: "fake",
      async *stream(req) {
        const next = queue.shift();
        if (next === undefined) throw new Error("the test queued no reply");
        if (req.signal.aborted) throw new ProviderError({ kind: "aborted", message: "aborted" });
        return typeof next === "function" ? await next(req.signal) : next;
      },
      retrieve: () => Promise.resolve(undefined),
    }),
  }),
);

async function fresh() {
  const convo = await Conversation.create(host, join(await tempDir(), "c"), { providers: { registry: adapters, secrets: envSource({}) }, config: "providers:\n  f:\n    $tag: fake\n" });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  const registry = new ToolRegistry();
  await syncTools(convo, registry);
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
  return { convo, registry };
}

describe("ThreadRuns", () => {
  test("a run goes through cycles: running, idle, resumed; watchers see events, late ones get the replay", async () => {
    const { convo, registry } = await fresh();
    const runs = new ThreadRuns();
    queue = [answer("one")];
    const run = runs.start(convo, { system: "s", cost: false, registry }, { kind: "test" });
    assert.equal(run.state, "running");
    const live: string[] = [];
    run.subscribe((e) => void live.push(e.type));
    const end = await run.cycleEnd();
    assert.equal(end?.result?.status, "completed");
    assert.equal(run.state, "idle");
    assert.ok(live.includes("request.start") && live.includes("request.end"));
    const late: LoopEvent[] = [];
    run.subscribe((e) => void late.push(e), { replay: true });
    assert.ok(late.length > 0, "replayed");
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "more" }] });
    queue = [answer("two")];
    run.resume();
    assert.equal(run.state, "running");
    const second = await run.cycleEnd({ next: true });
    assert.equal(second?.result?.status, "completed");
    assert.equal(run.cycles, 2);
    run.close();
    assert.deepEqual(runs.list(), []);
  });

  test("one run per branch; abort stops the running cycle and leaves the run idle; close ends it", async () => {
    const { convo, registry } = await fresh();
    const runs = new ThreadRuns();
    queue = [hang];
    const run = runs.start(convo, { system: "s", cost: false, registry }, { kind: "test", label: "x" });
    assert.throws(() => runs.start(convo, { system: "s", cost: false, registry }, { kind: "test" }), /already a run/);
    assert.equal(runs.abort(convo.branch), true);
    const end = await run.cycleEnd();
    assert.ok(end?.result !== undefined && end.result.status !== "completed");
    assert.equal(run.state, "idle");
    assert.equal(runs.abort(convo.branch), false, "nothing running now");
    run.close();
    assert.equal(run.state, "closed");
    assert.equal(await run.cycleEnd(), end);
  });
});
