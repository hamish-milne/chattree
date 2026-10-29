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
import { subagentTool } from "../../harness/subagent.ts";
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
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

describe("the subagent tool", () => {
  test("the child works on its own branch, its files merge back and its final message answers the call", async () => {
    const child = new ToolRegistry([writer("made-by-child.txt", "hi\n")]);
    const parentTools = new ToolRegistry([writer("parent.txt", "p\n")]);
    const seen: string[] = [];
    // the parent's registry holds the subagent tool; the convo is needed to build it, so it is made after
    const { convo } = await fresh(new ToolRegistry());
    parentTools.add(
      subagentTool({
        convo,
        childRegistry: child,
        loopOptions: () => ({ system: "s", cost: false, approve: () => Promise.resolve({ allow: true as const }) }),
        onEvent: (name, e) => void seen.push(`${name}:${e.type}`),
      }),
    );
    await syncTools(convo, parentTools);
    queue = [
      calls(call("s1", "subagent", { brief: "make the file", name: "w" })),
      calls(call("c1", "put")),
      answer("child is done"),
      answer("parent is done"),
    ];
    const { events, result } = await drive(convo, parentTools);
    assert.equal(result.status, "completed");
    const all = await entries(convo);
    const res = all.find((e) => e.$tag === "subagent_result");
    assert.ok(res?.$tag === "subagent_result");
    assert.equal(res.call_id, "s1");
    assert.equal(res.branch, "sub/w");
    assert.deepEqual(res.files.added, ["made-by-child.txt"]);
    assert.equal(await readFile(join(convo.dir, "made-by-child.txt"), "utf8"), "hi\n");
    assert.equal(all.filter((e) => e.$tag === "tool_result" && e.call_id === "s1").length, 0, "the merge entry answers the call");
    const toolResult = events.find((e) => e.type === "tool.result" && e.callId === "s1");
    assert.match(toolResult?.type === "tool.result" ? toolResult.content : "", /child is done/);
    assert.ok(seen.includes("sub/w:request.start"));
    await assertHistoryInvariants(convo);
  });

  test("a child that does not finish is not merged and the call gets an error naming its branch", async () => {
    const child = new ToolRegistry([writer("x.txt", "x\n")]);
    const { convo } = await fresh(new ToolRegistry());
    const parentTools = new ToolRegistry([subagentTool({ convo, childRegistry: child, loopOptions: () => ({ system: "s", cost: false }) })]);
    await syncTools(convo, parentTools);
    queue = [calls(call("s1", "subagent", { brief: "x" })), hangUntilAborted, answer("after")];
    const ac = new AbortController();
    const run = drive(convo, parentTools, { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await run;
    const all = await entries(convo);
    assert.ok(!all.some((e) => e.$tag === "subagent_result"));
    const r = all.find((e) => e.$tag === "tool_result" && e.call_id === "s1");
    assert.ok(r?.$tag === "tool_result");
    assert.match(typeof r.content === "string" ? r.content : "", /did not finish.*sub\//);
  });

  test("a bad name is refused before anything is created", async () => {
    const { convo } = await fresh(new ToolRegistry());
    const parentTools = new ToolRegistry([subagentTool({ convo, childRegistry: new ToolRegistry(), loopOptions: () => ({ system: "s", cost: false }) })]);
    await syncTools(convo, parentTools);
    queue = [calls(call("s1", "subagent", { brief: "x", name: "../x" })), answer("ok")];
    await drive(convo, parentTools);
    const r = (await entries(convo)).find((e) => e.$tag === "tool_result");
    assert.ok(r?.$tag === "tool_result" && r.is_error);
    assert.equal((await convo.listBranches()).length, 1);
  });
});
