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
import { forkTool, mergeTool } from "../../harness/fork-tools.ts";
import { subagentBranch, subagentTool } from "../../harness/subagent.ts";
import { ThreadRuns } from "../../harness/runs.ts";
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

async function withSubagent(over: Partial<Parameters<typeof subagentTool>[0]> = {}, childTools: Tool[] = [writer("made-by-child.txt", "hi\n")]) {
  const { convo } = await fresh(new ToolRegistry());
  const runs = new ThreadRuns();
  const tools = new ToolRegistry([subagentTool({ convo, childRegistry: new ToolRegistry(childTools), runs, loopOptions: () => allow, ...over })]);
  await syncTools(convo, tools);
  return { convo, runs, tools };
}
const parentUser = (convo: Conversation, t: string) => convo.append({ $tag: "user", content: [{ $tag: "text", text: t }] });

describe("the subagent tool", () => {
  test("the child works on its own branch, hands its work back with merge, and the merge answers the call", async () => {
    const seen: string[] = [];
    const { convo, runs, tools } = await withSubagent({ onEvent: (name, e) => void seen.push(`${name}:${e.type}`) });
    queue = [
      calls(call("s1", "subagent", { brief: "make the file", name: "w" })),
      calls(call("c1", "put")),
      calls(call("c2", "merge", { summary: "made the file" })),
      answer("parent is done"),
    ];
    const { events, result } = await drive(convo, tools);
    assert.equal(result.status, "completed");
    assert.equal(requests, 4, "the report is a call: the child makes no request after it");
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.equal(res.call_id, "s1");
    assert.match(res.branch, /^sub\/w-[0-9a-z]{6}$/);
    assert.deepEqual(res.files.added, ["made-by-child.txt"]);
    assert.equal(await readFile(join(convo.dir, "made-by-child.txt"), "utf8"), "hi\n");
    assert.equal(all.filter((e) => e.$tag === "tool_result" && e.call_id === "s1").length, 0, "the merge entry answers the call");
    const toolResult = events.find((e) => e.type === "tool.result" && e.callId === "s1");
    assert.match(toolResult?.type === "tool.result" ? toolResult.content : "", /made the file/);
    assert.ok(seen.some((x) => x.endsWith(":request.start")));
    assert.deepEqual(runs.list(), [], "the run is closed");
    await assertHistoryInvariants(convo);
  });

  test("a child that answers with text is nudged once; after the nudge it hands back", async () => {
    const { convo, tools } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n" })), answer("I am done"), calls(call("c2", "merge", { summary: "done after a nudge" })), answer("parent done")];
    const { result } = await drive(convo, tools);
    assert.equal(result.status, "completed");
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    const child = await convo.openBranch(res.branch);
    const nudges = (await entries(child)).filter((e) => e.$tag === "user" && /call the merge tool/.test(JSON.stringify(e)));
    assert.equal(nudges.length, 1);
  });

  test("a child that still does not hand back after the nudge is an error, and nothing is merged", async () => {
    const { convo, tools } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "n" })), answer("done"), answer("still done"), answer("parent done")];
    await drive(convo, tools);
    const all = await entries(convo);
    assert.ok(!all.some((e) => e.$tag === "subagent_result"));
    const r = all.find((e) => e.$tag === "tool_result" && e.call_id === "s1");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
    assert.match(typeof r.content === "string" ? r.content : "", /without handing its work back.*sub\//);
  });

  test("stopping the turn stops the child: not merged, the call gets an error naming its branch", async () => {
    const { convo, runs, tools } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x" })), hangUntilAborted, answer("after")];
    const ac = new AbortController();
    const run = drive(convo, tools, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await run;
    const all = await entries(convo);
    assert.ok(!all.some((e) => e.$tag === "subagent_result"));
    const r = all.find((e) => e.$tag === "tool_result" && e.call_id === "s1");
    assert.ok(r?.$tag === "tool_result");
    assert.match(typeof r.content === "string" ? r.content : "", /stopped before it finished.*sub\//);
    assert.deepEqual(runs.list(), []);
  });

  test("when the user stops the child alone, the call stays open until the child hands back after the user speaks to it", async () => {
    const { convo, runs, tools } = await withSubagent();
    queue = [calls(call("s1", "subagent", { brief: "x", name: "u" })), hangUntilAborted];
    const parent = drive(convo, tools);
    const branch = await until(() => runs.list()[0]?.branch);
    runs.abort(branch);
    const run = runs.get(branch) as NonNullable<ReturnType<typeof runs.get>>;
    await until(() => (run.state === "idle" ? true : undefined));
    // the user speaks in the child's branch and lets it carry on
    await run.convo.append({ $tag: "user", content: [{ $tag: "text", text: "please finish up" }] });
    queue.push(calls(call("c2", "merge", { summary: "finished after the user's help" })), answer("parent done"));
    run.resume();
    const { result } = await parent;
    assert.equal(result.status, "completed");
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.match(typeof res.summary === "string" ? res.summary : "", /finished after the user's help/);
  });

  test("review: the user is asked before the child hands back, and a refusal lets the child carry on", async () => {
    const asked: string[] = [];
    const { convo, tools } = await withSubagent({
      merge: "review",
      loopOptions: () => ({
        system: "s",
        cost: false,
        approve: (req) => {
          asked.push(req.name);
          return Promise.resolve(req.name === "merge" && asked.filter((n) => n === "merge").length === 1 ? { allow: false, reason: "not yet" } : { allow: true });
        },
      }),
    });
    queue = [calls(call("s1", "subagent", { brief: "x", name: "r" })), calls(call("c1", "merge", { summary: "first try" })), calls(call("c2", "merge", { summary: "second try" })), answer("parent done")];
    const { result } = await drive(convo, tools);
    assert.equal(result.status, "completed");
    assert.deepEqual(asked, ["merge", "merge"]);
    const res = (await entries(convo)).find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.match(typeof res.summary === "string" ? res.summary : "", /second try/);
  });

  test("a call the process died in the middle of finds its branch and carries on", async () => {
    const { convo, runs, tools } = await withSubagent();
    // The state a crash leaves: the assistant asked for a subagent, the child branch exists with its brief, the call has no answer.
    await convo.append({ $tag: "assistant", provider: "f", model: "m1", blocks: [{ $tag: "tool_call", call_id: "s1", name: "subagent", args: { brief: "make the file", name: "w" } }], stop_reason: "tool_use", usage } as never);
    await convo.spawnSubagent({ brief: "make the file", callId: "s1", name: subagentBranch("w", "s1") });
    queue = [calls(call("c1", "put")), calls(call("c2", "merge", { summary: "resumed and finished" })), answer("parent done")];
    const { result } = await drive(convo, tools);
    assert.equal(result.status, "completed");
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.equal(res.branch, subagentBranch("w", "s1"));
    assert.equal((await convo.listBranches()).filter((b) => b.name.startsWith("sub/")).length, 1, "no second branch");
    assert.deepEqual(runs.list(), []);
    await assertHistoryInvariants(convo);
  });

  test("background: the call returns at once, the report arrives after the merge as the job's end", async () => {
    const { convo, tools } = await withSubagent();
    const jobs = new JobRegistry(convo, { busy: () => false });
    queue = [calls(call("s1", "subagent", { brief: "x", name: "bg", background: true })), answer("started it"), calls(call("c1", "put")), calls(call("c2", "merge", { summary: "background work done" }))];
    const { result } = await drive(convo, tools, { jobs });
    assert.equal(result.status, "completed");
    await until(() => (jobs.list()[0]?.status === "completed" ? true : undefined));
    await jobs.flush();
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result", "merged at the end of the job");
    assert.equal(await readFile(join(convo.dir, "made-by-child.txt"), "utf8"), "hi\n");
    assert.ok(!all.some((e) => e.$tag === "job_event"), "the merge entry reports the job");
    assert.deepEqual(await jobs.recover(), [], "a reported job is not lost after a restart");
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
});
