import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { LimitExceeded } from "../../harness/limits.ts";
import { JobRegistry, jobTools } from "../../harness/jobs.ts";
import { forkTool, mergeTool } from "../../harness/fork-tools.ts";
import { deliverSubagents, subagentAuto, subagentBranch, subagentChildRegistry, subagentGrants, subagentNudge, subagentTool } from "../../harness/subagent.ts";
import { Pump } from "../../harness/pump.ts";
import { ALL, FOREVER } from "../../harness/approvals.ts";
import { resolveSubagentModels } from "../../harness/subagent-models.ts";
import { ThreadRuns } from "../../harness/runs.ts";
import { runLoop, syncTools, type GrantStore, toolDrift, ToolsNotSupported, ToolsOutOfSync, type LoopEvent, type LoopOptions } from "../../harness/loop.ts";
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
    settings: z.strictObject({ max_output_tokens: z.number().optional(), effort: z.string().optional() }),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    models: () => ({
      m1: { ...(convention === undefined ? {} : { tool_convention: convention }), description: "the everyday model", cost_tier: "medium" as const, reasoning: { low: { effort: "low" }, high: { effort: "high" } }, default_reasoning: "low" },
      m2: { max_output_tokens: 1000, description: "a small, cheap model", cost_tier: "low" as const, context_window: 200_000, reasoning: { low: { effort: "low" }, high: { effort: "high" } } },
      m3: { description: "no known output cap" },
    }),
    create: () => ({
      $tag: "fake",
      async *stream(req) {
        requests++;
        const next = queue.shift();
        if (next === undefined) throw new Error("the test queued no reply");
        if (req.signal.aborted) throw new ProviderError({ kind: "aborted", message: "aborted" });
        const out = typeof next === "function" ? await next(req.signal) : next;
        return { ...out, observed: { ...out.observed, model: req.setup.model?.id ?? "m1" } }; // the model that was asked for is the one that answers
      },
      retrieve: () => Promise.resolve(undefined),
    }),
  }),
);

const hangUntilAborted = (signal: AbortSignal): Promise<Completed> =>
  new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError({ kind: "aborted", message: "aborted" })), { once: true }));

// ---- tools ------------------------------------------------------------------------------------------------------

const noArgs = { type: "object", additionalProperties: false, properties: {} };
const writer = (file: string, text: string): Tool => ({
  definition: { name: "put", description: "write a test file", input_schema: noArgs },
  execute: async (_a, ctx) => {
    await ctx.host.fs.writeAtomic(join(ctx.workspace, file), new TextEncoder().encode(text));
    return { content: `wrote ${file}` };
  },
});

async function drive(convo: Conversation, registry: ToolRegistry, extra: Partial<LoopOptions> = {}) {
  const events: LoopEvent[] = [];
  const gen = runLoop(convo, { system: "s", cost: false, registry, ...extra });
  for (;;) {
    const n = await gen.next();
    if (n.done) return { result: n.value, events };
    events.push(n.value);
  }
}

async function fresh(registry: ToolRegistry) {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, { providers: { registry: adapters, secrets: envSource({}) }, config: "providers:\n  f:\n    $tag: fake\n" });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  await syncTools(convo, registry);
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
  queue = [];
  requests = 0;
  return { dir, convo };
}
async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

const allow = { system: "s", cost: false as const, approve: () => Promise.resolve({ allow: true as const }) };
/** Every call is covered: nothing is asked. */
const yes: GrantStore = { allow: () => Promise.resolve({ [ALL]: FOREVER }), grant: () => Promise.resolve() };

const pumps: Pump[] = [];
afterEach(async () => {
  for (const p of pumps.splice(0)) await p.close();
});

/** A pump over the project the parent `convo` is in: the parent runs the `tools`, a subagent the child registry made from `base`. */
function pumpFor(convo: Conversation, tools: ToolRegistry, base: ToolRegistry, o: { merge?: "auto" | "review"; grants?: GrantStore; onEvent?: (branch: string, e: LoopEvent) => void } = {}): Pump {
  const grants = o.grants ?? yes;
  const pump = new Pump({
    open: (b) => convo.openBranch(b),
    threads: async () => {
      const merged = await convo.mergedBranches();
      return (await convo.listBranches()).filter((b) => !b.archived && !merged.has(b.name)).map((b) => b.name);
    },
    loop: (c) => Promise.resolve(c.branch === convo.branch ? { system: "s", cost: false, registry: tools, grants } : { system: "s", cost: false, registry: subagentChildRegistry(base), grants: subagentGrants(grants, o.merge) }),
    auto: subagentAuto,
    idle: subagentNudge,
    deliver: (c) => deliverSubagents(c),
    ...(o.onEvent === undefined ? {} : { onEvent: o.onEvent }),
  });
  pumps.push(pump);
  return pump;
}

async function withSubagent(over: Partial<Parameters<typeof subagentTool>[0]> = {}, childTools: Tool[] = [writer("made-by-child.txt", "hi\n")], pumpOver: { grants?: GrantStore; onEvent?: (branch: string, e: LoopEvent) => void } = {}) {
  const { convo } = await fresh(new ToolRegistry());
  const base = new ToolRegistry(childTools);
  const tools = new ToolRegistry([subagentTool({ convo, childRegistry: base, ...over })]);
  await syncTools(convo, tools);
  const pump = pumpFor(convo, tools, base, { ...pumpOver, ...(over.merge === undefined ? {} : { merge: over.merge }) });
  return { convo, tools, base, pump };
}
/** The parent's loop until it hands the work over (or finishes), then the pump until nothing is left to do. */
async function runAll(convo: Conversation, tools: ToolRegistry, pump: Pump, extra: Partial<LoopOptions> = {}) {
  const first = await drive(convo, tools, { grants: yes, ...extra });
  await pump.settle();
  return first;
}
const assistantTexts = async (c: Conversation): Promise<string[]> =>
  (await entries(c)).flatMap((e) => (e.$tag === "assistant" ? e.blocks.flatMap((b) => (b.$tag === "text" && typeof b.text === "string" ? [b.text] : [])) : []));

describe("the subagent tool", () => {
  test("the parent's call hands over to the child's thread, which works and hands back with merge; the parent then runs again and the merge answers the call", async () => {
    const seen: string[] = [];
    const { convo, tools, pump } = await withSubagent({}, undefined, { onEvent: (name, e) => void seen.push(`${name}:${e.type}`) });
    queue = [
      calls(call("s1", "subagent", { brief: "make the file", name: "w" })),
      calls(call("c1", "put")),
      calls(call("c2", "merge", { summary: "made the file" })),
      answer("parent is done"),
    ];
    const first = await runAll(convo, tools, pump);
    assert.equal(first.result.status, "blocked", "the parent lets go while the child works");
    assert.equal(requests, 4, "the report is a call: the child makes no request after it");
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.equal(res.call_id, "s1");
    assert.match(res.branch, /^sub\/w-[0-9a-z]{6}$/);
    assert.deepEqual(res.files.added, ["made-by-child.txt"]);
    assert.match(typeof res.summary === "string" ? res.summary : "", /made the file/);
    assert.equal(await readFile(join(convo.dir, "made-by-child.txt"), "utf8"), "hi\n");
    assert.equal(all.filter((e) => e.$tag === "tool_result" && e.call_id === "s1").length, 0, "the merge entry answers the call");
    assert.deepEqual(await assistantTexts(convo), ["parent is done"]);
    assert.ok(seen.some((x) => x.startsWith("main:") || x.endsWith(":request.start")));
    assert.deepEqual(pump.questions(), []);
    await assertHistoryInvariants(convo);
  });

  test("while the child works the parent holds nothing (a context switch) and the child's thread is live; both are free afterwards", async () => {
    const { convo, tools, pump } = await withSubagent();
    const name = subagentBranch("w", "s1");
    const during: { parent?: unknown; child?: unknown } = {};
    queue = [
      calls(call("s1", "subagent", { brief: "make the file", name: "w" })),
      async () => ((during.parent = await convo.leaseState()), (during.child = await convo.leaseState(name)), calls(call("c2", "merge", { summary: "done" }))),
      answer("parent is done"),
    ];
    await runAll(convo, tools, pump);
    assert.deepEqual(during.parent, { state: "free" });
    const child = during.child as { state: string; holding: string[] };
    assert.equal(child.state, "live");
    assert.deepEqual(child.holding, ["loop"]);
    assert.deepEqual(await convo.leaseState(), { state: "free" });
    assert.deepEqual(await convo.leaseState(name), { state: "free" });
    assert.deepEqual(await assistantTexts(convo), ["parent is done"]);
  });

  test("a child that answers with text is nudged once; after the nudge it hands back", async () => {
    const { convo, tools, pump } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n" })), answer("I am done"), calls(call("c2", "merge", { summary: "done after a nudge" })), answer("parent done")];
    await runAll(convo, tools, pump);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    const child = await convo.openBranch(res.branch);
    const nudges = (await entries(child)).filter((e) => e.$tag === "user" && /call the merge tool/.test(JSON.stringify(e)));
    assert.equal(nudges.length, 1);
  });

  test("a child that still does not hand back after the nudge is an error, and nothing is merged", async () => {
    const { convo, tools, pump } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n" })), answer("done"), answer("still done"), answer("parent done")];
    await runAll(convo, tools, pump);
    const all = await entries(convo);
    assert.ok(!all.some((e) => e.$tag === "subagent_result"));
    const r = all.find((e) => e.$tag === "tool_result" && e.call_id === "s1");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
    assert.match(typeof r.content === "string" ? r.content : "", /without handing its work back.*sub\//);
    assert.deepEqual(await assistantTexts(convo), ["parent done"]);
  });

  test("when the user stops the child, the parent stays blocked until the child hands back after the user speaks to it", async () => {
    const { convo, tools, pump } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "u" })), hangUntilAborted];
    const first = await drive(convo, tools, { grants: yes });
    assert.equal(first.result.status, "blocked");
    void pump.tick();
    const branch = await until(() => pump.runs.list().find((r) => r.state === "running")?.branch);
    pump.runs.abort(branch);
    await until(() => (pump.held().has(branch) ? true : undefined));
    await pump.settle();
    assert.equal((await entries(convo)).some((e) => e.$tag === "subagent_result"), false);
    // the user speaks in the child's branch and lets it carry on
    const child = await convo.openBranch(branch);
    await child.append({ $tag: "user", content: [{ $tag: "text", text: "please finish up" }] });
    queue.push(calls(call("c2", "merge", { summary: "finished after the user's help" })), answer("parent done"));
    pump.release(branch);
    await pump.settle();
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.match(typeof res.summary === "string" ? res.summary : "", /finished after the user's help/);
    assert.deepEqual(await assistantTexts(convo), ["parent done"]);
  });

  test("review: the report is a question for the user, and a refusal lets the child carry on", async () => {
    // harness.yml covers everything but handing back
    const grants: GrantStore = { allow: (tool) => Promise.resolve(tool === "merge" ? undefined : { [ALL]: FOREVER }), grant: () => Promise.resolve() };
    const { convo, tools, pump } = await withSubagent({ merge: "review" }, undefined, { grants });
    queue = [calls(call("s1", "subagent", { brief: "x", name: "r" })), calls(call("c1", "merge", { summary: "first try" })), calls(call("c2", "merge", { summary: "second try" })), answer("parent done")];
    await drive(convo, tools, { grants });
    await pump.settle();
    const q1 = pump.questions();
    assert.equal(q1.length, 1);
    assert.equal(q1[0]?.name, "merge");
    assert.match(q1[0]?.branch ?? "", /^sub\/r-/);
    assert.deepEqual(await pump.answer(q1[0]?.branch as string, "c1", { allow: false, reason: "not yet" }), { status: "recorded" });
    await pump.settle();
    const q2 = pump.questions();
    assert.equal(q2[0]?.callId, "c2");
    await pump.answer(q2[0]?.branch as string, "c2", { allow: true });
    await pump.settle();
    assert.deepEqual(pump.questions(), []);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.match(typeof res.summary === "string" ? res.summary : "", /second try/);
  });

  test("a call the process died in the middle of finds its branch and carries on", async () => {
    const { convo, tools, pump } = await withSubagent();
    // The state a crash leaves: the assistant asked for a subagent, the child branch exists with its brief, the call has no answer.
    await convo.append({ $tag: "assistant", provider: "f", model: "m1", blocks: [{ $tag: "tool_call", call_id: "s1", name: "subagent", args: { brief: "make the file", name: "w" } }], stop_reason: "tool_use", usage } as never);
    await convo.spawnSubagent({ brief: "make the file", callId: "s1", name: subagentBranch("w", "s1") });
    queue = [calls(call("c1", "put")), calls(call("c2", "merge", { summary: "resumed and finished" })), answer("parent done")];
    const { result } = await runAll(convo, tools, pump);
    assert.equal(result.status, "blocked");
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.equal(res.branch, subagentBranch("w", "s1"));
    assert.equal((await convo.listBranches()).filter((b) => b.name.startsWith("sub/")).length, 1, "no second branch");
    assert.deepEqual(await assistantTexts(convo), ["parent done"]);
    await assertHistoryInvariants(convo);
  });

  test("background: the call is answered at once; the report is delivered as a merge when the child has handed back", async () => {
    const { convo, tools, pump } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "bg", background: true })), answer("started it"), calls(call("c1", "put")), calls(call("c2", "merge", { summary: "background work done" }))];
    const { result } = await runAll(convo, tools, pump);
    assert.equal(result.status, "completed", "the parent was not held up");
    const all = await entries(convo);
    const started = all.find((e) => e.$tag === "tool_result" && e.call_id === "s1");
    assert.match(started?.$tag === "tool_result" && typeof started.content === "string" ? started.content : "", /^started subagent sub\/bg-/);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result", "merged when the child was done");
    assert.match(typeof res.summary === "string" ? res.summary : "", /background work done/);
    assert.equal(await readFile(join(convo.dir, "made-by-child.txt"), "utf8"), "hi\n");
    assert.ok(!all.some((e) => e.$tag === "job_event"));
    assert.equal(await deliverSubagents(convo), 0, "delivered once");
    await assertHistoryInvariants(convo);
  });

  test("a bad name is refused before anything is created", async () => {
    const { convo, tools } = await withSubagent({}, []);
    queue = [calls(call("s1", "subagent", { brief: "x", name: "../x" })), answer("ok")];
    await drive(convo, tools);
    const r = (await entries(convo)).find((e) => e.$tag === "tool_result");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
    assert.equal((await convo.listBranches()).length, 1);
  });
});

describe("the fork and merge tools", () => {
  test("a fork is made at once and told where it is; merge brings it back, answering the call with the fork_merge entry", async () => {
    const { convo } = await fresh(new ToolRegistry());
    const drafts: string[] = [];
    let fork: Conversation | undefined;
    const tools = new ToolRegistry([
      forkTool({
        convo,
        createFork: async (name) => {
          const r = await convo.fork(undefined, { name: name ?? "fork/1" });
          fork = r.conversation;
          return { branch: r.branch, conversation: r.conversation as Conversation };
        },
        onDraft: (b, m) => void drafts.push(`${b}: ${m}`),
      }),
      mergeTool({ convo }),
    ]);
    await syncTools(convo, tools);
    queue = [calls(call("f1", "fork", { name: "plan", message: "plan the parser" })), answer("forked")];
    const first = await drive(convo, tools);
    assert.equal(first.result.status, "completed");
    assert.deepEqual(drafts, ["plan: plan the parser"]);
    assert.ok(fork !== undefined);
    const inFork = await entries(fork);
    const told = inFork.find((e) => e.$tag === "tool_result" && e.call_id === "f1");
    assert.ok(told?.$tag === "tool_result");
    assert.match(typeof told.content === "string" ? told.content : "", /You are now in the fork plan/);

    // The fork does some work.
    await host.fs.writeAtomic(join(fork.dir, "plan.md"), new TextEncoder().encode("the plan\n"));
    await fork.snapshot();

    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "now merge it" }] });
    queue = [calls(call("m1", "merge", { branch: "plan", summary: "the parser plan is in plan.md" })), answer("merged")];
    const second = await drive(convo, tools);
    assert.equal(second.result.status, "completed");
    const all = await entries(convo);
    const fm = all.find((e) => e.$tag === "fork_merge");
    assert.ok(fm?.$tag === "fork_merge");
    assert.equal(fm.call_id, "m1");
    assert.equal(await readFile(join(convo.dir, "plan.md"), "utf8"), "the plan\n");
    assert.ok(!all.some((e) => e.$tag === "tool_result" && e.call_id === "m1"));
    await assertHistoryInvariants(convo);
  });

  test("merge refuses a branch that is not there, and an empty summary", async () => {
    const { convo } = await fresh(new ToolRegistry());
    const tools = new ToolRegistry([mergeTool({ convo })]);
    await syncTools(convo, tools);
    queue = [calls(call("m1", "merge", { branch: "nope", summary: "x" }), call("m2", "merge", { branch: "nope", summary: "  " })), answer("ok")];
    await drive(convo, tools);
    const rs = (await entries(convo)).flatMap((e) => (e.$tag === "tool_result" ? [e] : []));
    assert.equal(rs.length, 2);
    assert.ok(rs.every((r) => r.is_error));
    assert.match(typeof rs[0]?.content === "string" ? rs[0].content : "", /no such branch/);
  });

  test("auto_run: the message is sent in the fork, which works as a background job and reports when its first run ends", async () => {
    const { convo } = await fresh(new ToolRegistry());
    const runs = new ThreadRuns();
    const tools = new ToolRegistry([
      forkTool({
        convo,
        createFork: async (name) => {
          const r = await convo.fork(undefined, { name: name ?? "fork/1" });
          return { branch: r.branch, conversation: r.conversation as Conversation };
        },
        auto: { runs, childRegistry: new ToolRegistry(), loopOptions: () => allow },
      }),
    ]);
    await syncTools(convo, tools);
    const jobs = new JobRegistry(convo, { busy: () => false });
    queue = [calls(call("f1", "fork", { name: "side", message: "work on it", auto_run: true })), answer("started the fork"), answer("the fork's findings")];
    const { result } = await drive(convo, tools, { jobs });
    assert.equal(result.status, "completed");
    await until(() => (jobs.list()[0]?.status === "completed" ? true : undefined));
    await jobs.flush();
    const ev = (await entries(convo)).find((e) => e.$tag === "job_event");
    assert.ok(ev?.$tag === "job_event");
    assert.match(typeof ev.output === "string" ? ev.output : "", /side finished its first run\./);
    assert.deepEqual(runs.list(), []);
    const inFork = await entries(await convo.openBranch("side"));
    assert.ok(inFork.some((e) => e.$tag === "user" && JSON.stringify(e).includes("work on it")));
    await assertHistoryInvariants(convo);
  });

  test("auto_run without a message is refused", async () => {
    const { convo } = await fresh(new ToolRegistry());
    const tools = new ToolRegistry([forkTool({ convo, createFork: () => Promise.reject(new Error("no")), auto: { runs: new ThreadRuns(), childRegistry: new ToolRegistry(), loopOptions: () => allow } })]);
    await syncTools(convo, tools);
    queue = [calls(call("f1", "fork", { auto_run: true })), answer("ok")];
    await drive(convo, tools);
    const r = (await entries(convo)).find((e) => e.$tag === "tool_result");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
  });
});

describe("choosing the subagent's model", () => {
  const choices = async (convo: Conversation, listed: Record<string, { description?: string; reasoning?: string[] }> = { "f/m1": {}, "f/m2": {}, "f/m3": {} }) => {
    const r = resolveSubagentModels(listed, new Set(["f"]), (p, id) => convo.modelInfo(p, id));
    assert.deepEqual(r.problems, []);
    return r.models;
  };
  const withModels = async (listed?: Record<string, { description?: string; reasoning?: string[] }>) => {
    const { convo } = await fresh(new ToolRegistry());
    const base = new ToolRegistry([writer("made-by-child.txt", "hi\n")]);
    const tool = subagentTool({ convo, childRegistry: base, models: await choices(convo, listed) });
    const tools = new ToolRegistry([tool]);
    await syncTools(convo, tools);
    const pump = pumpFor(convo, tools, base);
    return { convo, tool, tools, pump };
  };

  test("without a list the tool has no model argument and its description is the plain one", async () => {
    const { tools } = await withSubagent();
    const def = tools.get("subagent")?.definition;
    assert.ok(def !== undefined);
    assert.deepEqual(Object.keys((def.input_schema as { properties: object }).properties), ["brief", "name", "background"]);
    assert.doesNotMatch(def.description, /Models:/);
  });

  test("with a list the description and schema offer the models, their tiers and levels", async () => {
    const { tool } = await withModels();
    const props = (tool.definition.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props["model"]?.enum, ["f/m1", "f/m2", "f/m3"]);
    assert.deepEqual(props["reasoning"]?.enum, ["low", "high"]);
    assert.match(tool.definition.description, /- f\/m2 \[cost: low; context: 200k; reasoning: low, high\]: a small, cheap model/);
    assert.match(tool.definition.description, /- f\/m1 \[cost: medium; reasoning: low \(default\), high\]: the everyday model/);
  });

  test("the list can narrow the levels and reword the description; the definition changes with it", async () => {
    const wide = (await withModels()).tool.definition;
    const narrow = (await withModels({ "f/m2": { description: "use for greps", reasoning: ["low"] } })).tool.definition;
    assert.notDeepEqual(wide, narrow);
    assert.match(narrow.description, /reasoning: low\]: use for greps/);
  });

  test("the child runs on the model and level the call chose, with the output cap of that model", async () => {
    const { convo, tools, pump } = await withModels();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n", model: "f/m2", reasoning: "high" })), calls(call("c1", "merge", { summary: "ok" })), answer("parent done")];
    await runAll(convo, tools, pump);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    const child = await convo.openBranch(res.branch);
    assert.deepEqual((await child.setup()).model, { provider: "f", id: "m2", settings: { max_output_tokens: 1000, effort: "high" } });
    assert.deepEqual((await convo.setup()).model?.id, "m1", "the parent keeps its own");
  });

  test("a model without a level uses its default; a level alone changes only the level of the parent's model", async () => {
    const { convo, tools, pump } = await withModels();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "a", reasoning: "high" })), calls(call("c1", "merge", { summary: "ok" })), answer("parent done")];
    await runAll(convo, tools, pump);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.deepEqual((await (await convo.openBranch(res.branch)).setup()).model, { provider: "f", id: "m1", settings: { effort: "high" } });
  });

  test("an unknown level and a model with no known output cap are errors that make no branch", async () => {
    const { convo, tools } = await withModels();
    queue = [
      calls(call("s1", "subagent", { brief: "x", model: "f/m2", reasoning: "max" })),
      calls(call("s2", "subagent", { brief: "x", model: "f/m3" })),
      answer("parent done"),
    ];
    await drive(convo, tools);
    const all = await entries(convo);
    const text = (id: string) => {
      const r = all.find((e) => e.$tag === "tool_result" && e.call_id === id);
      return r?.$tag === "tool_result" && typeof r.content === "string" ? r.content : "";
    };
    // `max` is not in the schema's enum, so the registry refuses it before the tool sees it
    assert.match(text("s1"), /max|reasoning/);
    assert.match(text("s2"), /output cap for f\/m3 is not known/);
    assert.deepEqual((await convo.listBranches()).filter((b) => b.name.startsWith("sub/")), []);
  });

  test("approval keys: inherit, provider/model@level, and globs that let a cheap model through without a dear one", async () => {
    const { tool, convo } = await withModels();
    const ctx = { workspace: convo.dir, host };
    assert.deepEqual(await tool.allowKeys?.({ brief: "x" }, ctx), ["inherit"]);
    assert.deepEqual(await tool.allowKeys?.({ brief: "x", model: "f/m2", reasoning: "high" }, ctx), ["f/m2@high"]);
    assert.deepEqual(await tool.allowKeys?.({ brief: "x", model: "f/m2" }, ctx), ["f/m2@default"], "a model with no default level");
    assert.deepEqual(await tool.covers?.(["f/m2@*"], { brief: "x", model: "f/m2", reasoning: "low" }, ctx), ["f/m2@*"]);
    assert.deepEqual(await tool.covers?.(["f/m*@low"], { brief: "x", model: "f/m2", reasoning: "low" }, ctx), ["f/m*@low"]);
    assert.equal(await tool.covers?.(["f/m*@low"], { brief: "x", model: "f/m2", reasoning: "high" }, ctx), undefined, "another level");
    assert.equal(await tool.covers?.(["f/m2@*"], { brief: "x", model: "f/m1", reasoning: "low" }, ctx), undefined, "another model");
    assert.equal(await tool.covers?.(["f/m2@*"], { brief: "x" }, ctx), undefined, "inherit is its own key, never a glob match");
    assert.deepEqual(await tool.covers?.(["inherit"], { brief: "x" }, ctx), ["inherit"]);
    assert.equal(tool.validateKey?.("f/m2@high"), undefined);
    assert.equal(tool.validateKey?.("inherit"), undefined);
    assert.match(tool.validateKey?.("cheap") ?? "", /provider\/model@level/);
  });

  test("a child inherits what the parent has spent: the turn and conversation figures it is limited by start from the parent's", async () => {
    const { convo, tools, pump } = await withModels();
    // the parent's turn so far: this request (the one that makes the call); the child then makes one request of its own
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n" })), calls(call("c1", "merge", { summary: "ok" })), answer("parent done")];
    await runAll(convo, tools, pump);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    const child = await (await convo.openBranch(res.branch)).ledger();
    assert.equal(child.turn.requests, 2, "the parent's request in this turn plus the child's own");
    assert.equal(child.conversation.requests, 2);
  });

  test("without a list the only key is all, as before", async () => {
    const { tools, convo } = await withSubagent();
    const tool = tools.get("subagent") as Tool;
    assert.deepEqual(await tool.allowKeys?.({ brief: "x" }, { workspace: convo.dir, host }), ["all"]);
  });
});

describe("the pump", () => {
  const none: GrantStore = { allow: () => Promise.resolve(undefined), grant: () => Promise.resolve() };
  const setup = async () => {
    const { convo } = await fresh(new ToolRegistry());
    const tools = new ToolRegistry([writer("x.txt", "1")]);
    await syncTools(convo, tools);
    return { convo, tools };
  };

  test("a thread that stopped for a decision is a question to every pump that looks; one answer runs the call, and a second answer changes nothing", async () => {
    const { convo, tools } = await setup();
    queue = [calls(call("p1", "put")), answer("written")];
    const first = await drive(convo, tools, { grants: none, waitForApproval: true });
    assert.equal(first.result.status, "needs_approval");
    assert.equal(requests, 1);
    const a = pumpFor(convo, tools, new ToolRegistry(), { grants: none });
    const b = pumpFor(convo, tools, new ToolRegistry(), { grants: none });
    await a.tick();
    await b.tick();
    for (const p of [a, b]) assert.deepEqual(p.questions().map((q) => [q.branch, q.callId, q.name]), [[convo.branch, "p1", "put"]]);
    assert.deepEqual(await a.answer(convo.branch, "p1", { allow: true }), { status: "recorded" });
    const second = await b.answer(convo.branch, "p1", { allow: true });
    assert.notEqual(second.status, "recorded", "the first answer wins");
    await a.settle();
    await b.settle();
    assert.equal(await readFile(join(convo.dir, "x.txt"), "utf8"), "1");
    assert.deepEqual(await assistantTexts(convo), ["written"]);
    assert.equal((await entries(convo)).filter((e) => e.$tag === "approval").length, 1);
    assert.deepEqual(a.questions(), []);
    assert.equal(requests, 2);
  });

  test("a refusal is recorded with its reason, the model sees it, and the call does not run", async () => {
    const { convo, tools } = await setup();
    queue = [calls(call("p1", "put")), answer("understood")];
    await drive(convo, tools, { grants: none, waitForApproval: true });
    const pump = pumpFor(convo, tools, new ToolRegistry(), { grants: none });
    await pump.tick();
    await pump.answer(convo.branch, "p1", { allow: false, reason: "not now" });
    await pump.settle();
    const r = (await entries(convo)).find((e) => e.$tag === "tool_result" && e.call_id === "p1");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
    assert.match(typeof r.content === "string" ? r.content : "", /not now/);
    await assert.rejects(readFile(join(convo.dir, "x.txt"), "utf8"));
  });
});
