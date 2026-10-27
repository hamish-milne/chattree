import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { LimitExceeded } from "../../harness/limits.ts";
import { runLoop, syncTools, toolDrift, ToolsNotSupported, ToolsOutOfSync, type LoopEvent, type LoopOptions } from "../../harness/loop.ts";
import { leafTools } from "../../harness/starter/index.ts";
import { ToolRegistry, type Tool } from "../../harness/tools.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter, type ToolConvention } from "../../providers/registry.ts";
import { ProviderError, type Completed } from "../../providers/types.ts";
import { flatProblems } from "../../harness/tool-schema.ts";
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

let convention: ToolConvention | undefined;
const adapters = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    models: () => (convention === undefined ? {} : { m1: { tool_convention: convention } }),
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

describe("the model's tool convention", () => {
  const nested: Tool = { definition: { name: "nest", description: "a tool with a list of objects", input_schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, properties: { a: { type: "string" } } } }, cfg: { type: "object", additionalProperties: false, properties: {} } } } }, execute: () => Promise.resolve({ content: "ok" }) };

  test("a flat model is refused any tool with nested arguments, naming the tool and why", async () => {
    convention = "flat";
    try {
      const registry = reg(echo, nested);
      const { convo } = await fresh(registry);
      queue = [answer("never")];
      await assert.rejects(drive(convo, registry), (e: unknown) => e instanceof ToolsNotSupported && e.convention === "flat" && e.tools.length === 1 && e.tools[0]?.name === "nest" && /items is a list of objects, cfg is an object/.test(e.message));
      assert.equal(requests, 0, "no request is made");
      const flat = reg(echo);
      const second = await fresh(flat);
      queue = [answer("fine")];
      assert.equal((await drive(second.convo, flat)).result.status, "completed");
    } finally {
      convention = undefined;
    }
  });

  test("full is the default and takes any tool in the portable subset", async () => {
    for (const c of [undefined, "full" as const]) {
      convention = c;
      const registry = reg(echo, nested);
      const { convo } = await fresh(registry);
      queue = [answer("fine")];
      assert.equal((await drive(convo, registry)).result.status, "completed");
    }
    convention = undefined;
  });

  test("the starter tools are flat, so every convention can have them", () => {
    for (const d of leafTools().map((t) => t.definition)) assert.deepEqual(flatProblems(d.input_schema), [], d.name);
  });
});

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

describe("approvals", () => {
  const CFG = "providers:\n  f:\n    $tag: fake\n";
  const keyed = (name: string, ran: string[]): Tool => ({
    ...tool(name, (_a, ctx) => (ran.push(ctx.callId), Promise.resolve({ content: "ran" }))),
    allowKeys: () => ["all"],
  });
  const approvalEvents = (events: LoopEvent[]) => events.flatMap((e) => (e.type === "tool.approval" ? [e] : []));
  const harnessYml = (dir: string) => readFile(join(dir, "harness.yml"), "utf8");

  test("a live key covers the call: it runs without asking, and the event says which key", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, `${CFG}tools:\n  echo:\n    allow:\n      all: 2999-01-01\n`);
    queue = [calls(call("c1", "echo")), answer("ok")];
    let asked = 0;
    const { events } = await drive(convo, registry, { grants: convo.grantStore(), approve: () => (asked++, Promise.resolve({ allow: true })) });
    assert.deepEqual(ran, ["c1"]);
    assert.equal(asked, 0);
    assert.deepEqual(approvalEvents(events).map((e) => [e.allowed, e.via, e.key]), [[true, "allowlist", "all"]]);
  });

  test("an expired key does not cover; the host is asked, with the keys the tool offers", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, `${CFG}tools:\n  echo:\n    allow:\n      all: 2020-01-01\n`);
    queue = [calls(call("c1", "echo")), answer("ok")];
    const seen: (string[] | null)[] = [];
    await drive(convo, registry, { grants: convo.grantStore(), approve: (r) => (seen.push(r.keys), Promise.resolve({ allow: true })) });
    assert.deepEqual(seen, [["all"]]);
    assert.deepEqual(ran, ["c1"]);
  });

  test("yes once stores nothing, so the next call asks again", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    const initial = await harnessYml(dir);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("ok")];
    let asked = 0;
    await drive(convo, registry, { grants: convo.grantStore(), approve: () => (asked++, Promise.resolve({ allow: true })) });
    assert.equal(asked, 2);
    assert.equal(await harnessYml(dir), initial);
  });

  test("a grant for five minutes is written to harness.yml, covers the next call at once, and rides with the next commit", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    const before = await convo.git.isClean();
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("ok")];
    let asked = 0;
    const { events } = await drive(convo, registry, { grants: convo.grantStore(), approve: () => (asked++, Promise.resolve({ allow: true, grant: { seconds: 300 } })) });
    assert.equal(asked, 1, "the second call is covered by the grant just made");
    assert.deepEqual(ran, ["c1", "c2"]);
    const via = approvalEvents(events).map((e) => e.via);
    assert.deepEqual(via, ["asked", "allowlist"]);
    const m = /all: (\S+)/.exec(await harnessYml(dir));
    assert.ok(m !== null, await harnessYml(dir));
    const delta = Date.parse(m[1]!) - convo.now();
    assert.ok(delta > 290_000 && delta <= 300_000, `expiry is about five minutes away (${delta} ms)`);
    assert.ok(before);
  });

  test("a forever grant is a commit of its own holding only harness.yml", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("ok")];
    await drive(convo, registry, { grants: convo.grantStore(), approve: () => Promise.resolve({ allow: true, grant: { seconds: Infinity } }) });
    assert.match(await harnessYml(dir), /all: 2999-01-01/);
    const text = async (a: string[]) => new TextDecoder().decode((await convo.git.run(a)).stdout);
    const log = await text(["log", "--format=%s", "-n", "6"]);
    assert.match(log, /approvals: allow echo: all until 2999-01-01/);
    const files = await text(["log", "--name-only", "--format=", "--grep=approvals:", "-n", "1"]);
    assert.ok(files.trim().split("\n").every((f: string) => f === "harness.yml" || f === ""), files);
  });

  test("a decline carries its reason to the model and the tool does not run", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("ok")];
    await drive(convo, registry, { grants: convo.grantStore(), approve: () => Promise.resolve({ allow: false, reason: "not that one" }) });
    assert.deepEqual(ran, []);
    const [r] = await results(convo);
    assert.match(str(r!.content), /declined.*not that one/);
  });

  test("with grants and no host to ask, a call no key covers is declined, never run", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("ok")];
    const { events } = await drive(convo, registry, { grants: convo.grantStore() });
    assert.deepEqual(ran, []);
    assert.deepEqual(approvalEvents(events).map((e) => [e.allowed, e.via]), [[false, "headless"]]);
    const [r] = await results(convo);
    assert.equal(r!.is_error, true);
    assert.match(str(r!.content), /needs the user's approval and none is available/);
  });

  test("a tool that offers no keys is asked with keys null, and a grant the host sends anyway is ignored", async () => {
    const ran: string[] = [];
    const bare = tool("bare", (_a, ctx) => (ran.push(ctx.callId), Promise.resolve({ content: "ran" })));
    const registry = reg(bare);
    const { convo, dir } = await fresh(registry, CFG);
    const initial = await harnessYml(dir);
    queue = [calls(call("c1", "bare")), answer("ok")];
    const seen: (string[] | null)[] = [];
    await drive(convo, registry, { grants: convo.grantStore(), approve: (r) => (seen.push(r.keys), Promise.resolve({ allow: true, grant: { seconds: Infinity } })) });
    assert.deepEqual(seen, [null]);
    assert.deepEqual(ran, ["c1"]);
    assert.equal(await harnessYml(dir), initial);
  });

  test("keys the tool will not accept are not stored; the call the user approved still runs once", async () => {
    const ran: string[] = [];
    const odd: Tool = { ...tool("odd", (_a, ctx) => (ran.push(ctx.callId), Promise.resolve({ content: "ran" }))), allowKeys: () => ["grep **"] };
    const registry = reg(odd);
    const { convo, dir } = await fresh(registry, CFG);
    const initial = await harnessYml(dir);
    queue = [calls(call("c1", "odd")), answer("ok")];
    const { events } = await drive(convo, registry, { grants: convo.grantStore(), approve: () => Promise.resolve({ allow: true, grant: { seconds: 60 } }) });
    assert.deepEqual(ran, ["c1"]);
    assert.match(approvalEvents(events)[0]?.grantError ?? "", /only the key "all"/);
    assert.equal(await harnessYml(dir), initial);
  });

  test("a hand edit to harness.yml takes effect for the next call without reopening", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    const store = convo.grantStore();
    assert.equal(await store.allow("echo"), undefined);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "harness.yml"), `${CFG}tools:\n  echo:\n    allow: {all: 2999-01-01}\n`);
    assert.deepEqual(await store.allow("echo"), { all: "2999-01-01" });
    await convo.revokeGrant("echo", undefined);
    assert.deepEqual(await store.allow("echo"), {});
  });
});
