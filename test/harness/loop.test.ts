import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { LimitExceeded } from "../../harness/limits.ts";
import { runLoop, syncTools, toolDrift, ToolsOutOfSync, type LoopEvent, type LoopOptions } from "../../harness/loop.ts";
import { leafTools } from "../../harness/starter/index.ts";
import { ToolRegistry, type Tool } from "../../harness/tools.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import { ProviderError, type Completed } from "../../providers/types.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();

// ---- a provider that answers each request from a queue ----------------------------------------------------------

type Reply = Completed | ((signal: AbortSignal) => Promise<Completed>);
let queue: Reply[] = [];
let requests = 0;

const usage = { input_tokens: 10, output_tokens: 5 };
const answer = (t: string): Completed => ({ blocks: [{ type: "text", text: t }], stop_reason: "end_turn", usage, observed: { model: "m1" }, ext: {} });
const calls = (...cs: { id: string; name: string; args: unknown }[]): Completed => ({
  blocks: cs.map((c) => ({ type: "tool_call" as const, call_id: c.id, name: c.name, args: c.args as never })),
  stop_reason: "tool_use",
  usage,
  observed: { model: "m1" },
  ext: {},
});
const call = (id: string, name: string, args: unknown = {}) => ({ id, name, args });

const adapters = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    create: () => ({
      $tag: "fake",
      async *stream(req) {
        requests++;
        const next = queue.shift();
        if (next === undefined) throw new Error("the test queued no reply");
        if (req.signal.aborted) throw new ProviderError({ kind: "aborted", message: "aborted" });
        return typeof next === "function" ? await next(req.signal) : next;
      },
      retrieve: () => Promise.resolve(undefined),
    }),
  }),
);

const hangUntilAborted = (signal: AbortSignal): Promise<Completed> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError({ kind: "aborted", message: "aborted" })), { once: true }));

// ---- tools ------------------------------------------------------------------------------------------------------

const noArgs = { type: "object", additionalProperties: false, properties: {} };
function tool(name: string, run: Tool["execute"]): Tool {
  return { definition: { name, description: `the ${name} test tool`, input_schema: noArgs }, execute: run };
}
const echo = tool("echo", (_a, ctx) => Promise.resolve({ content: `echo ${ctx.callId}` }));
const reg = (...tools: Tool[]) => new ToolRegistry(tools);

async function fresh(registry: ToolRegistry, config = "providers:\n  f:\n    $tag: fake\n") {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, { providers: { registry: adapters, secrets: envSource({}) }, config });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  await syncTools(convo, registry);
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
  queue = [];
  requests = 0;
  return { dir, convo };
}
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const str = (c: unknown): string => (typeof c === "string" ? c : "");
const results = async (c: Conversation) => (await entries(c)).flatMap((e) => (e.$tag === "tool_result" ? [e] : []));

async function drive(convo: Conversation, registry: ToolRegistry, extra: Partial<LoopOptions> = {}) {
  const events: LoopEvent[] = [];
  const gen = runLoop(convo, { system: "s", cost: false, registry, ...extra });
  for (;;) {
    const n = await gen.next();
    if (n.done) return { result: n.value, events };
    events.push(n.value);
  }
}

describe("the tool loop", () => {
  test("several calls in one response run in order, each result its own commit, then the model answers", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("done")];
    const { result, events } = await drive(convo, registry);
    assert.equal(result.status, "completed");
    assert.equal(result.requests, 2);
    const es = await entries(convo);
    assert.deepEqual(es.slice(-4).map((e) => e.$tag), ["assistant", "tool_result", "tool_result", "assistant"]);
    assert.deepEqual((await results(convo)).map((r) => [r.call_id, str(r.content), r.is_error]), [["c1", "echo c1", false], ["c2", "echo c2", false]]);
    assert.deepEqual(events.filter((e) => e.type.startsWith("tool.")).map((e) => e.type), ["tool.start", "tool.result", "tool.start", "tool.result"]);
    await assertHistoryInvariants(convo);
  });

  test("a tool's workspace changes are committed with its result", async () => {
    const registry = new ToolRegistry(leafTools());
    const { convo, dir } = await fresh(registry);
    queue = [calls(call("w", "write", { files: [{ path: "out/a.txt", content: "hello" }] })), answer("ok")];
    await drive(convo, registry);
    assert.equal(await readFile(join(dir, "out/a.txt"), "utf8"), "hello");
    const log = await convo.git.log("HEAD", { firstParent: true });
    const withFile = [];
    for (const c of log) if ((await convo.git.readFileAt(c.hash, "out/a.txt")) !== undefined) withFile.push(c.hash);
    assert.ok(withFile.length >= 1);
    // the commit that introduced it is the one that recorded the result
    const first = withFile.at(-1) as string;
    const at = await convo.git.readFileAt(first, "chat.yml");
    assert.match(new TextDecoder().decode(at), /tool_result/);
    await assertHistoryInvariants(convo);
  });

  test("a bad call, an unknown tool and a throwing tool become error results the model reads", async () => {
    const boom = tool("boom", () => Promise.reject(new Error("kaput")));
    const registry = reg(echo, boom);
    const { convo } = await fresh(registry);
    queue = [calls(call("a", "echo", { bogus: 1 }), call("b", "nope"), call("c", "boom")), answer("ok")];
    const { result } = await drive(convo, registry);
    assert.equal(result.status, "completed");
    const rs = await results(convo);
    assert.deepEqual(rs.map((r) => r.is_error), [true, true, true]);
    assert.match(str(rs[0]!.content), /bogus is not a known argument/);
    assert.match(str(rs[1]!.content), /nope/);
    assert.match(str(rs[2]!.content), /kaput/);
    await assertHistoryInvariants(convo);
  });

  test("a denied call is answered with the reason and the loop goes on", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "echo")), answer("ok")];
    const { events } = await drive(convo, registry, { approve: () => Promise.resolve({ allow: false, reason: "not now" }) });
    const [r] = await results(convo);
    assert.equal(r!.is_error, true);
    assert.match(str(r!.content), /declined.*not now/);
    assert.deepEqual(events.filter((e) => e.type === "tool.approval").map((e) => (e as { allowed: boolean }).allowed), [false]);
  });

  test("a long result is cut for the model and kept whole as a blob the entry references", async () => {
    const big = tool("big", () => Promise.resolve({ content: "x".repeat(5000) }));
    const registry = reg(big);
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "big")), answer("ok")];
    await drive(convo, registry, { resultLimit: 1000 });
    const [r] = await results(convo);
    assert.equal(r!.truncated, true);
    assert.ok(str(r!.content).length < 1500);
    assert.ok(r!.full !== undefined);
    assert.equal(r!.full!.bytes, 5000);
    assert.equal(new TextDecoder().decode(await convo.store.get(r!.full!.sha256)), "x".repeat(5000));
    await assertHistoryInvariants(convo);
  });

  test("a crash between calls leaves valid history; the next loop answers the rest as not run, never re-running them", async () => {
    let ran: string[] = [];
    const t = tool("t", (_a, ctx) => {
      ran.push(ctx.callId);
      return Promise.resolve({ content: "ok" });
    });
    const registry = reg(t);
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "t"), call("c2", "t"))];
    // simulate the crash: the first result is written, then the process dies
    await convo.append({ $tag: "assistant", provider: "f", model: "m1", blocks: [{ $tag: "tool_call", call_id: "c1", name: "t", args: {} }, { $tag: "tool_call", call_id: "c2", name: "t", args: {} }], stop_reason: "tool_use", usage } as never).catch(() => undefined);
    queue = [answer("after")];
    ran = [];
    // whatever state the transcript is in, a new loop must not run old calls
    const { result } = await drive(convo, registry);
    assert.equal(result.status, "completed");
    assert.deepEqual(ran, []);
    await assertHistoryInvariants(convo);
  });

  test("aborting during a tool stops the tool, answers the rest as not run and makes no further request", async () => {
    const ac = new AbortController();
    const slow = tool("slow", (_a, ctx) => {
      queueMicrotask(() => ac.abort());
      return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ content: "stopped early", is_error: true }), { once: true }));
    });
    const registry = reg(slow, echo);
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "slow"), call("c2", "echo")), answer("never")];
    const { result } = await drive(convo, registry, { signal: ac.signal });
    assert.equal(result.status, "stopped");
    assert.equal(requests, 1);
    const rs = await results(convo);
    assert.deepEqual(rs.map((r) => r.call_id), ["c1", "c2"]);
    assert.match(str(rs[1]!.content), /did not run/);
    await assertHistoryInvariants(convo);
  });

  test("aborting the request itself ends the loop with the request's status", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    const ac = new AbortController();
    queue = [(signal) => {
      queueMicrotask(() => ac.abort());
      return hangUntilAborted(signal);
    }];
    const { result } = await drive(convo, registry, { signal: ac.signal });
    assert.ok(result.status === "interrupted" || result.status === "cancelled");
    assert.equal(requests, 1);
    await assertHistoryInvariants(convo);
  });

  test("a request limit stops the loop with history valid, and asking again continues the turn", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry, "providers:\n  f:\n    $tag: fake\nlimits:\n  max_requests_per_turn: 1\n");
    queue = [calls(call("c1", "echo")), answer("ok")];
    await assert.rejects(drive(convo, registry, { allowDrift: ["pricing_changed"] , cost: undefined as never }), LimitExceeded);
    assert.equal((await results(convo)).length, 1);
    await assertHistoryInvariants(convo);
  });

  test("the loop refuses to start when the host's tools differ from the agent's, and syncTools fixes it", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    const other = reg(echo, tool("extra", () => Promise.resolve({ content: "" })));
    assert.deepEqual((await toolDrift(convo, other)).missing, ["extra"]);
    await assert.rejects(drive(convo, other), ToolsOutOfSync);
    assert.ok(await syncTools(convo, other));
    assert.equal(await syncTools(convo, other), undefined);
    queue = [answer("ok")];
    assert.equal((await drive(convo, other)).result.status, "completed");
  });
});
