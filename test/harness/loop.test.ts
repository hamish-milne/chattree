import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { LimitExceeded } from "../../harness/limits.ts";
import { JobRegistry, jobTools } from "../../harness/jobs.ts";
import { foldTip, unanswered } from "../../harness/tip.ts";
import { LeaseStore, ThreadBusy } from "../../harness/lease.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { runLoop, syncTools, toolDrift, ToolsNotSupported, ToolsOutOfSync, type LoopEvent, type LoopOptions } from "../../harness/loop.ts";
import { leafTools } from "../../harness/starter/index.ts";
import { ToolRegistry, type Tool, type ToolOutput } from "../../harness/tools.ts";
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

  const foldNow = async (c: Conversation, registry: ToolRegistry) => foldTip({ entries: await entries(c), registry, allow: (t) => c.grantStore().allow(t), nowMs: c.now(), ctx: { workspace: c.dir, host: c.host } });

  test("a message queued while a request streams is answered by the same loop, and the answer records what it was built from", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    let sent = false;
    queue = [
      async () => {
        sent = true;
        await convo.append({ $tag: "user", queued: true, content: [{ $tag: "text", text: "and one more thing" }] });
        return answer("first answer");
      },
      answer("second answer"),
    ];
    const { result } = await drive(convo, registry);
    assert.ok(sent);
    assert.equal(result.status, "completed");
    assert.equal(result.requests, 2, "the queued message gets its own request");
    const es = await entries(convo);
    assert.deepEqual(es.slice(-4).map((e) => e.$tag), ["user", "user", "assistant", "assistant"]);
    const [first, second] = es.filter((e) => e.$tag === "assistant");
    assert.ok(first?.$tag === "assistant" && second?.$tag === "assistant");
    const q = es.filter((e) => e.$tag === "user")[1];
    assert.ok(q?.$tag === "user" && first.context_tip !== undefined && first.context_tip < q.id, "the first answer was built before the message");
    assert.ok(second.context_tip !== undefined && second.context_tip >= q.id, "the second saw it");
    assert.equal((await foldNow(convo, registry)).kind, "awaiting_user");
    await assertHistoryInvariants(convo);
  });

  test("a queued message does not hide the calls that are still waiting for results", () => {
    const id = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(n).padStart(4, "0")}`;
    const a: ChatEntry = { $tag: "assistant", id: id(1), provider: "f", model: "m1", stop_reason: "tool_use", blocks: [{ $tag: "tool_call", call_id: "c1", name: "echo", args: {} }] };
    const q: ChatEntry = { $tag: "user", id: id(2), queued: true, content: [{ $tag: "text", text: "hey" }] };
    const plain: ChatEntry = { ...q, queued: undefined } as ChatEntry;
    assert.deepEqual(unanswered([a, q]), ["c1"]);
    assert.deepEqual(unanswered([a, plain]), [], "an ordinary message after the calls leaves them to the context builder");
  });

  test("a message the last answer was built without is owed a reply when nothing else is running", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    queue = [
      async () => {
        await convo.append({ $tag: "user", queued: true, content: [{ $tag: "text", text: "late" }] });
        return answer("first answer");
      },
    ];
    // the loop died (here: stopped) before its second request
    const ac = new AbortController();
    const { result } = await drive(convo, registry, { signal: ac.signal, beforeRequest: async () => { if (requests >= 1) ac.abort(); } });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(await foldNow(convo, registry), { kind: "ready", cause: "human" });
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
    assert.deepEqual(approvalEvents(events).map((e) => [e.allowed, e.via, e.keys]), [[true, "allowlist", ["all"]]]);
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

describe("approvals recorded in the thread", () => {
  const CFG = "providers:\n  f:\n    $tag: fake\n";
  const keyed = (name: string, ran: string[]): Tool => ({
    ...tool(name, (_a, ctx) => (ran.push(ctx.callId), Promise.resolve({ content: "ran" }))),
    allowKeys: () => ["all"],
  });
  const approvals = async (c: Conversation) => (await entries(c)).flatMap((e) => (e.$tag === "approval" ? [e] : []));
  const harnessYml = (dir: string) => readFile(join(dir, "harness.yml"), "utf8");
  const tip = async (c: Conversation, registry: ToolRegistry) => foldTip({ entries: await entries(c), registry, allow: (t) => c.grantStore().allow(t), nowMs: c.now(), ctx: { workspace: c.dir, host: c.host } });

  test("an answer the host gave is recorded before the call's result; a call a grant covers records nothing", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, `${CFG}tools:\n  echo:\n    allow:\n      all: 2999-01-01\n`);
    queue = [calls(call("c1", "echo")), answer("ok")];
    await drive(convo, registry, { grants: convo.grantStore() });
    assert.deepEqual(await approvals(convo), []);

    const second = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("ok")];
    await drive(second.convo, registry, { grants: second.convo.grantStore(), approve: (r) => Promise.resolve(r.callId === "c1" ? { allow: true } : { allow: false, reason: "no thanks" }) });
    const kinds = (await entries(second.convo)).flatMap((e) => (e.$tag === "approval" ? [`approval:${e.call_id}:${e.allow}`] : e.$tag === "tool_result" ? [`result:${e.call_id}`] : []));
    assert.deepEqual(kinds, ["approval:c1:true", "result:c1", "approval:c2:false", "result:c2"]);
    assert.equal((await approvals(second.convo))[1]?.reason, "no thanks");
    assert.deepEqual(await verifyHistory(second.convo), []);
    await assertHistoryInvariants(second.convo);
  });

  test("a grant for the thread lives in the entry only: the next call is covered, harness.yml is untouched, and another thread is not covered", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    const initial = await harnessYml(dir);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("ok")];
    let asked = 0;
    const { events } = await drive(convo, registry, { grants: convo.grantStore(), approve: () => (asked++, Promise.resolve({ allow: true, grant: { seconds: 300, scope: "thread" } })) });
    assert.equal(asked, 1);
    assert.deepEqual(ran, ["c1", "c2"]);
    assert.deepEqual(events.flatMap((e) => (e.type === "tool.approval" ? [e.via] : [])), ["asked", "allowlist"]);
    assert.equal(await harnessYml(dir), initial);
    const [only] = await approvals(convo);
    assert.deepEqual(only?.grant?.keys, ["all"]);
    assert.equal(only?.grant?.tool, "echo");
    assert.equal((await approvals(convo)).length, 1, "the covered call has no entry of its own");

    // A grant for the project is in harness.yml and the entry carries no grant: one place each.
    const proj = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("ok")];
    await drive(proj.convo, registry, { grants: proj.convo.grantStore(), approve: () => Promise.resolve({ allow: true, grant: { seconds: 300 } }) });
    assert.equal((await approvals(proj.convo))[0]?.grant, undefined);

    // Another thread (here another conversation) does not have it.
    const other = await fresh(registry, CFG);
    assert.equal((await tip(other.convo, registry)).kind, "ready");
    queue = [calls(call("c9", "echo")), answer("ok")];
    let askedOther = 0;
    await drive(other.convo, registry, { grants: other.convo.grantStore(), approve: () => (askedOther++, Promise.resolve({ allow: true })) });
    assert.equal(askedOther, 1);
  });

  test("a thread grant reaches a branch forked after it", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("ok")];
    await drive(convo, registry, { grants: convo.grantStore(), approve: () => Promise.resolve({ allow: true, grant: { seconds: 300, scope: "thread" } }) });
    const { conversation: forked } = await convo.fork(undefined, { name: "side" });
    assert.ok(forked !== undefined);
    const child = forked;
    await child.append({ $tag: "user", content: [{ $tag: "text", text: "again" }] });
    queue = [calls(call("c2", "echo")), answer("ok")];
    let asked = 0;
    await drive(child, registry, { grants: child.grantStore(), approve: () => (asked++, Promise.resolve({ allow: true })) });
    assert.equal(asked, 0);
    assert.deepEqual(ran, ["c1", "c2"]);
  });

  test("waitForApproval: the loop stops at a call nobody has decided, and the tip says what is asked", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("done")];
    const { result, events } = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(result.status, "needs_approval");
    assert.deepEqual(result.waiting, { callId: "c1", name: "echo", args: {}, keys: ["all"] });
    assert.deepEqual(ran, []);
    assert.equal(requests, 1, "no request after the stop");
    assert.deepEqual(await results(convo), []);
    assert.deepEqual(events.flatMap((e) => (e.type === "tool.result" ? [e.callId] : [])), []);
    const state = await tip(convo, registry);
    assert.equal(state.kind, "needs_approval");
    if (state.kind === "needs_approval") {
      assert.equal(state.question.callId, "c1");
      assert.deepEqual(state.calls.map((c) => [c.callId, c.status]), [["c1", "ask"], ["c2", "ask"]]);
    }
  });

  test("an answer appended by another handle is picked up: the loop runs the approved call, declines the other, and carries on", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo, dir } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("done")];
    await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });

    const other = await Conversation.open(host, dir, { providers: { registry: adapters, secrets: envSource({}) } });
    await other.append({ $tag: "approval", call_id: "c1", allow: true });
    await other.append({ $tag: "approval", call_id: "c2", allow: false, reason: "not that" });
    assert.equal((await tip(other, registry)).kind, "run");

    const { result, events } = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(result.status, "completed");
    assert.deepEqual(ran, ["c1"]);
    assert.deepEqual(events.flatMap((e) => (e.type === "tool.approval" ? [[e.callId, e.allowed, e.via]] : [])), [["c1", true, "recorded"], ["c2", false, "recorded"]]);
    const rs = await results(convo);
    assert.deepEqual(rs.map((r) => [r.call_id, r.is_error]), [["c1", false], ["c2", true]]);
    assert.match(str(rs[1]?.content), /declined.*not that/);
    assert.equal((await tip(convo, registry)).kind, "awaiting_user");
    assert.deepEqual(await verifyHistory(convo), []);
  });

  test("a waiting loop that finds a later call still undecided stops again, and nothing already answered runs twice", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("done")];
    await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    await convo.append({ $tag: "approval", call_id: "c1", allow: true });
    const { result } = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(result.status, "needs_approval");
    assert.equal(result.waiting?.callId, "c2");
    assert.deepEqual(ran, ["c1"]);
    await convo.append({ $tag: "approval", call_id: "c2", allow: true });
    const again = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(again.result.status, "completed");
    assert.deepEqual(ran, ["c1", "c2"]);
  });

  test("without waitForApproval an approved call that has no result is not run (it may have started); a declined one is answered", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo"), call("c2", "echo")), answer("done")];
    await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    await convo.append({ $tag: "approval", call_id: "c1", allow: true });
    await convo.append({ $tag: "approval", call_id: "c2", allow: false });
    queue = [answer("after")];
    await drive(convo, registry, { grants: convo.grantStore() });
    assert.deepEqual(ran, []);
    const rs = await results(convo);
    assert.match(str(rs[0]?.content), /did not run/);
    assert.match(str(rs[1]?.content), /declined/);
  });

  test("the tip is ready after a user message and awaiting_user after an answer; a call that cannot run is answered, not asked", async () => {
    const registry = reg(keyed("echo", []));
    const { convo } = await fresh(registry, CFG);
    assert.equal((await tip(convo, registry)).kind, "ready");
    queue = [calls(call("c1", "nosuch")), answer("done")];
    const first = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(first.result.status, "completed");
    assert.equal((await tip(convo, registry)).kind, "awaiting_user");
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "now echo" }] });
    queue = [calls(call("c2", "echo"))];
    const second = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(second.result.status, "needs_approval");
  });
});

describe("the run lease", () => {
  const CFG = "providers:\n  f:\n    $tag: fake\n";
  const keyed = (name: string, ran: string[]): Tool => ({
    ...tool(name, (_a, ctx) => (ran.push(ctx.callId), Promise.resolve({ content: "ran" }))),
    allowKeys: () => ["all"],
  });
  const ALLOWED = `${CFG}tools:\n  echo:\n    allow:\n      all: 2999-01-01\n`;
  /** Another process: its own store over the same repository. */
  async function otherProcess(convo: Conversation) {
    const common = await convo.git.commonDir();
    const store = new LeaseStore(host.fs, (b) => join(common, "chattree", "leases", `${encodeURIComponent(b)}.lease`));
    const handle = await Conversation.open(host, convo.dir, { providers: { registry: adapters, secrets: envSource({}) }, leases: store });
    return { store, handle };
  }
  const tip = async (c: Conversation, registry: ToolRegistry) => foldTip({ entries: await entries(c), registry, allow: (t) => c.grantStore().allow(t), nowMs: c.now(), ctx: { workspace: c.dir, host: c.host }, lease: await c.leaseState() });

  test("the thread is live while a call runs, held by the loop, and free when the loop ends", async () => {
    const seen: unknown[] = [];
    let convoRef: Conversation | undefined;
    const probe = tool("echo", async () => (seen.push(await convoRef!.leaseState()), { content: "ok" }));
    const registry = reg({ ...probe, allowKeys: () => ["all"] });
    const { convo } = await fresh(registry, ALLOWED);
    convoRef = convo;
    assert.deepEqual(await convo.leaseState(), { state: "free" });
    queue = [calls(call("c1", "echo")), answer("done")];
    await drive(convo, registry, { grants: convo.grantStore(), owner: { pid: 7, session: "s1" } });
    const s = seen[0] as { state: string; holding: string[]; owner: { session: string } };
    assert.equal(s.state, "live");
    assert.deepEqual(s.holding, ["loop"]);
    assert.equal(s.owner.session, "s1");
    assert.deepEqual(await convo.leaseState(), { state: "free" });
  });

  test("a loop that cannot get the lease is refused before it asks the model anything, and a waiting thread reads as running", async () => {
    const registry = reg(keyed("echo", []));
    const { convo } = await fresh(registry, ALLOWED);
    const { store, handle } = await otherProcess(convo);
    await store.hold(convo.branch, { pid: 99, session: "elsewhere" }, handle.leaseEnv, "loop", convo.now() + 60_000);
    queue = [answer("never")];
    await assert.rejects(drive(convo, registry, { grants: convo.grantStore() }), (e: unknown) => e instanceof ThreadBusy && /session elsewhere/.test(e.message));
    assert.equal(requests, 0);
    const state = await tip(convo, registry);
    assert.equal(state.kind, "running");
    await store.drop(convo.branch, "loop");
    assert.equal((await tip(convo, registry)).kind, "ready");
  });

  test("a tool that outlives its timeout is stopped and answered with an error; the lease follows the timeout", async () => {
    let held: unknown;
    let convoRef: Conversation | undefined;
    const hang: Tool = {
      ...tool("echo", (_a, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))),
      timeout: () => 1,
      allowKeys: () => ["all"],
    };
    const registry = reg(hang);
    const { convo } = await fresh(registry, ALLOWED);
    convoRef = convo;
    queue = [calls(call("c1", "echo")), answer("done")];
    const t0 = Date.now();
    const gen = runLoop(convo, { system: "s", cost: false, registry, grants: convo.grantStore(), toolGraceMs: 50 });
    for (;;) {
      const n = await gen.next();
      if (n.done) break;
      if (n.value.type === "tool.start") held = await convoRef.leaseState();
    }
    assert.ok(Date.now() - t0 < 4000);
    const [r] = await results(convo);
    assert.equal(r!.is_error, true);
    assert.match(str(r!.content), /did not finish within 1 seconds/);
    const l = held as { state: string; until: number };
    assert.equal(l.state, "live");
    assert.deepEqual(await convo.leaseState(), { state: "free" });
  });

  test("a lease the host that died left behind: the call that was waiting is not run, it is answered as not run", async () => {
    const ran: string[] = [];
    const registry = reg(keyed("echo", ran));
    const { convo } = await fresh(registry, CFG);
    queue = [calls(call("c1", "echo")), answer("done")];
    await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    await convo.append({ $tag: "approval", call_id: "c1", allow: true });

    // Another process held the thread and its clock has run out: the history does not say whether c1 started.
    const { store, handle } = await otherProcess(convo);
    await store.hold(convo.branch, { pid: 99 }, { now: () => convo.now() - 3_600_000 }, "loop", convo.now() - 3_500_000);
    assert.equal((await convo.leaseState()).state, "stale");
    const state = await tip(convo, registry);
    assert.equal(state.kind, "run");
    if (state.kind === "run") assert.deepEqual(state.calls.map((c) => [c.callId, c.status]), [["c1", "lost"]]);
    void handle;

    queue = [answer("after")];
    const { result } = await drive(convo, registry, { grants: convo.grantStore(), waitForApproval: true });
    assert.equal(result.status, "completed");
    assert.deepEqual(ran, []);
    const [r] = await results(convo);
    assert.match(str(r!.content), /did not run/);
    assert.deepEqual(await convo.leaseState(), { state: "free" });
  });

  test("a background job keeps the thread live after the loop has finished, and frees it when it ends", async () => {
    const g = (() => {
      let resolve!: (o: ToolOutput) => void;
      return { promise: new Promise<ToolOutput>((r) => (resolve = r)), resolve };
    })();
    const slow: Tool = { ...tool("slow", () => Promise.resolve({ started: { lease: { seconds: 60 }, summary: "slow thing", done: g.promise, stop: () => g.resolve({ content: "cut short", is_error: true }) } }) as never), background: true };
    const registry = reg(slow);
    const { convo } = await fresh(registry);
    const jobs = new JobRegistry(convo);
    queue = [calls(call("c1", "slow")), answer("started")];
    await drive(convo, registry, { jobs });
    const live = await convo.leaseState();
    assert.equal(live.state, "live");
    if (live.state === "live") assert.deepEqual(live.holding, ["job:j1"]);
    assert.equal((await tip(convo, registry)).kind, "running");
    g.resolve({ content: "done" });
    for (let i = 0; i < 200 && (await convo.leaseState()).state !== "free"; i++) await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(await convo.leaseState(), { state: "free" });
  });

  test("a job that follows a thread is live while that thread is, so a subagent's work holds its parent", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    const jobs = new JobRegistry(convo);
    const g = (() => {
      let resolve!: (o: ToolOutput) => void;
      return { promise: new Promise<ToolOutput>((r) => (resolve = r)), resolve };
    })();
    await jobs.start("c1", { lease: { follows: "sub/x" }, summary: "child", done: g.promise, stop: () => undefined });
    const store = await convo.leaseStore();
    await store.hold("sub/x", { pid: 3 }, convo.leaseEnv, "loop", convo.now() + 3_600_000);
    const first = await convo.leaseState();
    assert.equal(first.state, "live");
    await store.drop("sub/x", "loop");
    g.resolve({ content: "" });
    for (let i = 0; i < 200 && (await convo.leaseState()).state !== "free"; i++) await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(await convo.leaseState(), { state: "free" });
  });
});

describe("background jobs", () => {
  const gate = () => {
    let resolve!: (o: ToolOutput) => void;
    const promise = new Promise<ToolOutput>((r) => (resolve = r));
    return { promise, resolve };
  };
  const slow = (g: ReturnType<typeof gate>, stopped: { n: number } = { n: 0 }): Tool => ({
    ...tool("slow", () => Promise.resolve({ started: { lease: { seconds: 60 }, summary: "slow thing", done: g.promise, stop: () => (stopped.n++, g.resolve({ content: "cut short", is_error: true })) } }) as never),
    background: true,
  });
  const tags = async (c: Conversation) => (await entries(c)).map((e) => e.$tag === "tool_result" ? `result:${e.call_id}` : e.$tag === "job_event" ? `job:${e.job}:${e.status}` : e.$tag);
  const events = async (c: Conversation) => (await entries(c)).flatMap((e) => (e.$tag === "job_event" ? [e] : []));
  const settle = () => new Promise((r) => setTimeout(r, 150));
  /** Wait until something that happens in the background (a commit) has happened, instead of guessing how long it takes. */
  const until = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 15));
  };

  test("a call that starts a job is answered at once; the job's event is committed before the next request after it ends, and the model is shown it", async () => {
    const g = gate();
    const registry = reg(slow(g), echo);
    const { convo } = await fresh(registry);
    const jobs = new JobRegistry(convo);
    const seen: string[] = [];
    queue = [
      calls(call("c1", "slow")),
      async () => (g.resolve({ content: "exit 0\nbuild ok" }), await settle(), calls(call("c2", "echo"))),
      answer("done"),
    ];
    const { events: ev } = await drive(convo, registry, { jobs, onRequest: undefined } as never);
    assert.deepEqual(await tags(convo), ["header", "agent_setup", "agent_setup", "user", "assistant", "result:c1", "assistant", "result:c2", "job:j1:completed", "assistant"]);
    const [r1] = await results(convo);
    assert.match(str(r1!.content), /^started job j1: slow thing/);
    const [je] = await events(convo);
    assert.equal(je!.call_id, "c1");
    assert.match(str(je!.summary), /slow thing completed after/);
    assert.equal(str(je!.output), "exit 0\nbuild ok");
    assert.deepEqual(ev.filter((e) => e.type === "job.event").map((e) => (e as { job: string }).job), ["j1"]);
    void seen;
    await assertHistoryInvariants(convo);
  });

  test("a job that ends while idle is committed at once and the host told; resume asks for a request only when on", async () => {
    for (const resume of [false, true]) {
      const g = gate();
      const registry = reg(slow(g));
      const { convo } = await fresh(registry);
      const told: string[][] = [];
      let resumed = 0;
      const jobs = new JobRegistry(convo, { resume, onCommitted: (e) => told.push(e.map((x) => `${x.job}:${x.status}`)), onResume: () => resumed++ });
      queue = [calls(call("c1", "slow")), answer("started")];
      await drive(convo, registry, { jobs });
      assert.deepEqual(told, []);
      g.resolve({ content: "late" });
      await until(() => told.length > 0 && (resumed > 0 || !resume));
      assert.deepEqual(told, [["j1:completed"]]);
      assert.equal(resumed, resume ? 1 : 0);
      assert.deepEqual((await events(convo)).map((e) => e.job), ["j1"]);
    }
  });

  test("a failed job is failed, and job_stop stops a running one: status stopped, with what it had printed", async () => {
    const g1 = gate();
    const g2 = gate();
    const stopped = { n: 0 };
    const a = slow(g1);
    const b = { ...slow(g2, stopped), definition: { ...slow(g2).definition, name: "slow2" } };
    const { convo } = await fresh(reg(a, b, ...[]));
    const jobs = new JobRegistry(convo);
    const registry = reg(a, b, ...jobTools(jobs));
    await syncTools(convo, registry);
    queue = [calls(call("c1", "slow"), call("c2", "slow2")), calls(call("c3", "job_stop", { job: "j2" }), call("c4", "jobs")), answer("ok")];
    g1.resolve({ content: "exit 2\nboom", is_error: true });
    await drive(convo, registry, { jobs });
    await settle();
    assert.equal(stopped.n, 1);
    const evs = await events(convo);
    assert.deepEqual(evs.map((e) => [e.job, e.status]).sort(), [["j1", "failed"], ["j2", "stopped"]]);
    const rs = await results(convo);
    assert.match(str(rs[2]!.content), /Asked job j2 to stop/);
    assert.match(str(rs[3]!.content), /j1  failed  slow thing/);
  });

  test("job_output reads from an offset, says when a job has nothing yet, and finds a job from an earlier process in the history", async () => {
    const g = gate();
    const { convo } = await fresh(reg(echo));
    const jobs = new JobRegistry(convo);
    const t = Object.fromEntries(jobTools(jobs).map((x) => [x.definition.name, x]));
    const ctx = { signal: new AbortController().signal, callId: "x", workspace: convo.dir, host };
    const out = (args: Record<string, unknown>) => t["job_output"]!.execute(args, ctx).then((r) => r as ToolOutput);
    assert.match((await out({ job: "j9" })).content, /There is no job j9/);
    await jobs.start("c1", { lease: { seconds: 60 }, summary: "thing", done: g.promise, stop: () => undefined });
    assert.match((await out({ job: "j1" })).content, /running: there is no output yet/);
    g.resolve({ content: "0123456789" });
    await settle();
    assert.equal((await out({ job: "j1", limit: 4 })).content, "0123\n[job j1 completed; continue from offset 4]");
    assert.equal((await out({ job: "j1", offset: 8 })).content, "89\n[job j1 completed; end of output at 10]");
    const again = new JobRegistry(convo);
    assert.match((await again.output("j1"))?.output ?? "", /0123456789/);
  });

  test("a job started and never ended in the history is marked lost once, and numbering continues after it", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "started job j1: run: sleep 100. It keeps running" });
    await convo.append({ $tag: "tool_result", call_id: "c2", is_error: false, content: "started job j2: run: ls. It keeps running" });
    await convo.append({ $tag: "job_event", job: "j2", call_id: "c2", status: "completed", summary: "ls completed after 0s" });
    const jobs = new JobRegistry(convo);
    assert.deepEqual(await jobs.recover(), ["j1"]);
    assert.deepEqual(await jobs.recover(), []);
    const lost = (await events(convo)).filter((e) => e.status === "lost");
    assert.equal(lost.length, 1);
    assert.equal(lost[0]!.job, "j1");
    assert.equal(lost[0]!.call_id, "c1");
    const g = gate();
    assert.equal(await jobs.start("c9", { lease: { seconds: 60 }, summary: "next", done: g.promise, stop: () => undefined }), "j3");
    g.resolve({ content: "" });
    await settle();
  });

  test("runLoop recovers lost jobs when it starts, and says so", async () => {
    const registry = reg(echo);
    const { convo } = await fresh(registry);
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "started job j1: run: x" });
    queue = [answer("ok")];
    const { events: ev } = await drive(convo, registry, { jobs: new JobRegistry(convo) });
    assert.deepEqual(ev.filter((e) => e.type === "job.event").map((e) => [(e as { job: string }).job, (e as { status: string }).status]), [["j1", "lost"]]);
  });

  test("without a registry a background start is refused and the job is stopped", async () => {
    const g = gate();
    const stopped = { n: 0 };
    const registry = reg(slow(g, stopped));
    const { convo } = await fresh(registry);
    queue = [calls(call("c1", "slow")), answer("ok")];
    await drive(convo, registry);
    const [r] = await results(convo);
    assert.equal(r!.is_error, true);
    assert.match(str(r!.content), /not available here/);
    assert.equal(stopped.n, 1);
  });

  test("the real run tool starts a background job that outlives the call and reports its output", async () => {
    const jobs0 = leafTools();
    const { convo } = await fresh(reg(...jobs0));
    const jobs = new JobRegistry(convo);
    const registry = reg(...jobs0, ...jobTools(jobs));
    await syncTools(convo, registry);
    const js = JSON.stringify(`console.log("hello from the job")`);
    queue = [calls(call("c1", "run", { command: `${process.execPath} -e ${js}`, background: true })), answer("started")];
    await drive(convo, registry, { jobs });
    const [r] = await results(convo);
    assert.match(str(r!.content), /^started job j1: run: /);
    await new Promise((r2) => setTimeout(r2, 800));
    const [je] = await events(convo);
    assert.ok(je !== undefined, `no job event; jobs: ${JSON.stringify(jobs.list())}`);
    assert.equal(je.status, "completed", str(je.output));
    assert.match(str(je.output), /hello from the job/);
  });

  test("run and script declare background, with a boolean argument, and stay flat", () => {
    for (const t of leafTools().filter((x) => x.definition.name === "run" || x.definition.name === "script")) {
      assert.equal(t.background, true);
      assert.deepEqual(flatProblems(t.definition.input_schema), []);
      assert.equal((t.definition.input_schema as { properties: Record<string, { type: string }> }).properties["background"]?.type, "boolean");
    }
  });
});
