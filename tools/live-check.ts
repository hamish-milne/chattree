/**
 * Validate an adapter against a real (or local) server.
 *
 *   node tools/live-check.ts --flavor anthropic --base-url http://localhost:11434 --model qwen3
 *   node tools/live-check.ts --flavor openai-responses --base-url http://localhost:11434/v1 --model qwen3 --api-key-env OPENAI_API_KEY
 *   node tools/live-check.ts --flavor openai-compatible --base-url http://localhost:8080/v1 --model qwen3   (llama-server, Ollama, vLLM: Chat Completions)
 *
 * Flags: --flavor, --base-url, --model, --max-tokens (default 512), --api-key-env NAME (the key is read from that
 * environment variable; never pass a key on the command line), --record DIR (save each scenario's events as JSON,
 * secrets scrubbed), --only NAME (repeatable), --list.
 *
 * The tools-* and agent-loop scenarios use the real starter tools (docs/tools.md, 3.6); agent-loop runs the whole loop in a
 * temporary git workspace and checks the file and the history.
 *
 * Exit code: 1 if any scenario fails; a scenario the server does not support (a model without tools or
 * reasoning) is reported as `skip`, not as a failure. Ollama is a zero-cost stand-in: it speaks the Anthropic
 * and OpenAI Responses shapes. It ignores some fields (cache_control, tool_choice) and may not report in-stream errors.
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { nodeHost } from "../hosts/node.ts";
import { Conversation } from "../harness/conversation.ts";
import { runLoop, syncTools } from "../harness/loop.ts";
import { envSource } from "../harness/secrets.ts";
import { leafTools } from "../harness/starter/index.ts";
import { ToolRegistry } from "../harness/tools.ts";
import { verifyHistory } from "../harness/verify.ts";
import { AdapterRegistry, defineAdapter } from "../providers/registry.ts";
import type { Block, ModelContext, Turn } from "../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import { anthropicAdapter } from "../providers/anthropic.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../providers/conformance.ts";
import { openaiCompatibleAdapter } from "../providers/openai-compatible.ts";
import { openaiResponsesAdapter } from "../providers/openai-responses.ts";
import { ProviderError, type ProviderAdapter } from "../providers/types.ts";

export type Flavor = "anthropic" | "openai-responses" | "openai-compatible";
export const FLAVORS: readonly Flavor[] = ["anthropic", "openai-responses", "openai-compatible"];

export interface LiveOptions {
  flavor: Flavor;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey?: string;
  only?: readonly string[];
  /** Called with the raw run of every request a scenario makes (several per scenario), for recording. `request` says what was asked. */
  onRun?: (scenario: string, run: StreamRun, request?: RequestSummary) => void | Promise<void>;
  /** Called with a scenario's own notes (the agent loop's tool calls and results), for recording. */
  onLog?: (scenario: string, label: string, data: unknown) => void | Promise<void>;
  /** Called as each scenario finishes. */
  onResult?: (r: ScenarioResult) => void;
}

/** What a request carried, for the record: the last turn and the names of the tools offered. */
export interface RequestSummary {
  last: unknown;
  tools: string[];
}

export interface ScenarioResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

class Skip extends Error {}
const skip = (why: string): never => {
  throw new Skip(why);
};
function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function makeAdapter(o: Pick<LiveOptions, "flavor" | "baseUrl" | "apiKey">): ProviderAdapter {
  const key = o.apiKey === undefined ? {} : { apiKey: o.apiKey };
  if (o.flavor === "anthropic") return anthropicAdapter({ baseUrl: o.baseUrl, ...key });
  if (o.flavor === "openai-compatible") return openaiCompatibleAdapter({ baseUrl: o.baseUrl, ...key });
  return openaiResponsesAdapter({ baseUrl: o.baseUrl, ...key });
}

const summary = (c: ModelContext): RequestSummary => ({ last: c.turns.at(-1), tools: c.tools.map((t) => t.name) });

/** Passes a stream through unchanged and reports each request's events to `report` when it ends, however it ends. */
function recording(inner: ProviderAdapter, report: (run: StreamRun, c: ModelContext) => void | Promise<void>): ProviderAdapter {
  return {
    ...inner,
    stream(req) {
      const events: StreamRun["events"] = [];
      const source = inner.stream(req);
      return (async function* () {
        const run: StreamRun = { events };
        try {
          for (;;) {
            const n = await source.next();
            if (n.done === true) {
              run.completed = n.value;
              return n.value;
            }
            events.push(n.value);
            yield n.value;
          }
        } catch (e) {
          run.error = e;
          throw e;
        } finally {
          await report(run, req.context);
        }
      })();
    },
  };
}

const user = (text: string): Turn => ({ role: "user", parts: [{ type: "text", text }] });
const WEATHER = { name: "get_weather", description: "Get the current weather for a city.", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };

export async function runLiveChecks(o: LiveOptions): Promise<ScenarioResult[]> {
  const adapter = makeAdapter(o);
  const maxTokens = o.maxTokens ?? 512;
  const setup: AgentSetup = { ...emptySetup(), model: { provider: "live", id: o.model, settings: { max_output_tokens: maxTokens } } };
  const ctx = (turns: Turn[], tools: ModelContext["tools"] = []): ModelContext => ({ system: "You are terse. Follow instructions exactly.", instructions: undefined, turns, tools, cacheHints: [] });
  const secrets = o.apiKey === undefined ? [] : [o.apiKey];
  let current = "";
  const go = async (c: ModelContext, signal = new AbortController().signal): Promise<StreamRun> => {
    const run = await collectStream(adapter.stream({ context: c, setup, signal }));
    await o.onRun?.(current, run, summary(c));
    return run;
  };
  const clean = (run: StreamRun): StreamRun => {
    const problems = conformanceProblems(run, { secrets });
    ok(problems.length === 0, `conformance: ${problems.join("; ")}`);
    if (run.error !== undefined) throw run.error;
    return run;
  };
  const assistantTurn = (blocks: Block[], ext?: Record<string, unknown>): Turn => ({ role: "assistant", provider: "live", model: o.model, blocks, ...(ext === undefined ? {} : { ext }) });
  const textOf = (blocks: readonly Block[]): string => blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

  const scenarios: [string, () => Promise<string>][] = [
    ["plain", async () => {
      const r = clean(await go(ctx([user("Reply with the single word: pong")])));
      const text = r.completed?.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") ?? "";
      ok(text.trim().length > 0, "no text in the reply");
      ok(r.completed?.stop_reason !== undefined, "no stop reason");
      return `${JSON.stringify(text.trim().slice(0, 40))}, stop=${r.completed?.stop_reason}`;
    }],
    ["usage", async () => {
      const r = clean(await go(ctx([user("Say hi.")])));
      const u = r.completed?.usage;
      ok(u !== undefined, "no usage reported");
      ok((u?.output_tokens ?? 0) > 0, "output_tokens is zero");
      return `in=${u?.input_tokens} cache_read=${u?.cache_read_tokens} out=${u?.output_tokens} reasoning=${u?.reasoning_tokens}`;
    }],
    ["streaming", async () => {
      const r = clean(await go(ctx([user("Count from 1 to 20, separated by spaces.")])));
      const deltas = r.events.filter((e) => e.type === "text.delta").length;
      ok(deltas > 1, `only ${deltas} text delta(s): the server is not streaming incrementally`);
      return `${deltas} text deltas`;
    }],
    ["tool-call", async () => {
      const c1 = ctx([user("What is the weather in Paris? Use the tool.")], [WEATHER]);
      const r1 = clean(await go(c1));
      const call = r1.completed?.blocks.find((b) => b.type === "tool_call");
      if (call?.type !== "tool_call") return skip("the model did not call the tool (it may not support tools)");
      ok(call.name === "get_weather", `called ${call.name}`);
      ok(r1.completed?.stop_reason === "tool_use", `stop_reason ${r1.completed?.stop_reason}`);
      const c2 = ctx([...c1.turns, assistantTurn(r1.completed?.blocks ?? []), { role: "tool_results", results: [{ call_id: call.call_id, is_error: false, content: "18C and cloudy", truncated: false }] }], [WEATHER]);
      const r2 = clean(await go(c2));
      const text = r2.completed?.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") ?? "";
      ok(text.trim().length > 0, "no answer after the tool result");
      return `args=${JSON.stringify(call.args)} → ${JSON.stringify(text.trim().slice(0, 50))}`;
    }],
    ["tools-schema", async () => {
      const starter = new ToolRegistry(leafTools());
      const c1 = ctx([user("Use the read tool to read the file notes.txt. Do not answer from memory.")], starter.definitions());
      const r1 = clean(await go(c1));
      const call = r1.completed?.blocks.find((b) => b.type === "tool_call");
      if (call?.type !== "tool_call") return skip("the model did not call a tool (it may not support tools)");
      ok(call.name === "read", `called ${call.name}`);
      const checked = starter.check(call);
      ok(!("error" in checked), `the call fails the schema: ${"error" in checked ? checked.error : ""}`);
      return `${starter.names().length} definitions accepted; read args=${JSON.stringify(call.args)}`;
    }],
    ["tools-parallel", async () => {
      // `read` takes a list of files, so asking for two reads is rightly one call; two different tools cannot be batched.
      const starter = new ToolRegistry(leafTools());
      const c1 = ctx([user("Do two independent things: read the file a.txt, and run `ls -la`. Neither needs the other's result, so request both tools in the same step.")], starter.definitions());
      const r1 = clean(await go(c1));
      const found = (r1.completed?.blocks ?? []).filter((b) => b.type === "tool_call");
      if (found.length === 0) return skip("the model did not call a tool (it may not support tools)");
      const ids = new Set(found.map((b) => b.call_id));
      ok(ids.size === found.length, "two calls share an id");
      for (const c of found) {
        const checked = starter.check(c);
        ok(!("error" in checked), `a call fails the schema: ${"error" in checked ? checked.error : ""}`);
      }
      const results = found.map((b) => ({ call_id: b.call_id, is_error: false, content: b.name === "read" ? "a.txt:\n1\thello" : "exit 0\ntotal 4\n-rw-r--r-- 1 u u 6 a.txt", truncated: false }));
      const c2 = ctx([...c1.turns, assistantTurn(r1.completed?.blocks ?? []), { role: "tool_results", results }], starter.definitions());
      const r2 = clean(await go(c2));
      ok((r2.completed?.blocks.length ?? 0) > 0, "no reply after the results");
      return found.length === 1 ? `one call only (${found[0]?.name}); the model did not use parallel calls; round-trip ok` : `${found.length} calls (${found.map((b) => b.name).join(", ")}) with distinct ids; all results accepted`;
    }],
    ["tools-reliability", async () => {
      const starter = new ToolRegistry(leafTools());
      const prompts: [string, string][] = [
        ["edit", "The file notes.txt contains the line `status: draft`. Use the edit tool to change `draft` to `final`."],
        ["edit", "In app.ts there is a line `const retries = 3;`. Use the edit tool to make it `const retries = 5;`."],
        ["edit", "Use the edit tool to insert the line `# Notes` at the top of README.md; do not rewrite the file."],
        ["run", "Use the run tool to list the files in the current directory with ls -la."],
        ["run", "Use the run tool to print the word hello with echo, then pipe it through wc -c."],
        ["run", "Use the run tool to count the lines in every .ts file under src using wc -l and a glob."],
      ];
      const tally: Record<string, [number, number]> = { edit: [0, 0], run: [0, 0] };
      const other: string[] = [];
      const bad: string[] = [];
      let any = false;
      for (const [tool, prompt] of prompts) {
        const r = clean(await go(ctx([user(prompt)], starter.definitions())));
        const call = (r.completed?.blocks ?? []).find((b) => b.type === "tool_call");
        if (call?.type !== "tool_call") continue;
        any = true;
        if (call.name !== tool) {
          other.push(`${tool} prompt: called ${call.name}`); // a model may reasonably look first; not a malformed call
          continue;
        }
        const row = tally[tool] as [number, number];
        row[1]++;
        const checked = starter.check(call);
        if ("error" in checked) bad.push(`${tool}: ${checked.error.split("\n")[0]}`);
        else row[0]++;
      }
      if (!any) return skip("the model did not call a tool (it may not support tools)");
      ok(tally["edit"]![0] + tally["run"]![0] > 0 || other.length === 0, `no valid call at all: ${bad.join("; ")}`);
      return `edit ${tally["edit"]![0]}/${tally["edit"]![1]} valid, run ${tally["run"]![0]}/${tally["run"]![1]} valid${other.length > 0 ? `; ${other.length} chose another tool first (${other.join("; ")})` : ""}${bad.length > 0 ? `; problems: ${bad.slice(0, 3).join("; ")}` : ""}`;
    }],
    ["agent-loop", async () => {
      const registry = new ToolRegistry(leafTools());
      const live = new AdapterRegistry().register(
        defineAdapter({
          $tag: "live",
          config: z.strictObject({ $tag: z.literal("live") }),
          settings: z.looseObject({}),
          jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
          secrets: () => [],
          create: () => recording(adapter, (run, c) => o.onRun?.("agent-loop", run, summary(c))),
        }),
      );
      const dir = join(await mkdtemp(join(tmpdir(), "chattree-live-")), "c");
      const convo = await Conversation.create(nodeHost(), dir, { providers: { registry: live, secrets: envSource({}) }, config: "providers:\n  live:\n    $tag: live\n" });
      await convo.setupChange({ model: setup.model as NonNullable<AgentSetup["model"]> });
      await syncTools(convo, registry);
      await writeFile(join(dir, "notes.txt"), "status: draft\n");
      await convo.append({ $tag: "user", content: [{ $tag: "text", text: "Read notes.txt, then use the edit tool to change the word draft to final, then run `cat notes.txt` with the run tool and tell me what it prints." }] });
      let requests = 0;
      const used = new Set<string>();
      const trail: unknown[] = [];
      const gen = runLoop(convo, { system: "You are a terse coding agent working in a workspace. Use the tools; do not guess file contents.", cost: false, registry, signal: AbortSignal.timeout(180_000) });
      for (;;) {
        const n = await gen.next();
        if (n.done === true) {
          ok(n.value.status === "completed", `the loop ended with ${n.value.status}`);
          requests = n.value.requests;
          break;
        }
        const e = n.value;
        if (e.type === "tool.start") {
          used.add(e.name);
          trail.push({ call: e.name, args: e.args });
        } else if (e.type === "tool.result") trail.push({ result: e.content, is_error: e.is_error });
      }
      const file = await readFile(join(dir, "notes.txt"), "utf8");
      await o.onLog?.("agent-loop", "loop", { workspace: dir, trail, notes_txt: file });
      if (used.size === 0) return skip("the model did not call a tool (it may not support tools)");
      ok(file.includes("final") && !file.includes("draft"), `notes.txt is ${JSON.stringify(file)} after ${trail.filter((t) => "call" in (t as object)).map((t) => (t as { call: string }).call).join(" → ")}`);
      const problems = await verifyHistory(convo);
      ok(problems.length === 0, `the history does not verify: ${JSON.stringify(problems).slice(0, 300)}`);
      return `${requests} requests, tools used: ${[...used].sort().join(", ")}; file edited; history verifies`;
    }],
    ["reasoning-replay", async () => {
      const c1 = ctx([user("What is 17 * 23? Think it through.")]);
      const r1 = clean(await go(c1));
      const blocks = r1.completed?.blocks ?? [];
      if (!blocks.some((b) => b.type === "reasoning")) return skip("the model produced no reasoning blocks");
      const c2 = ctx([...c1.turns, assistantTurn(blocks), user("Now add 9 to that.")]);
      const r2 = clean(await go(c2));
      ok((r2.completed?.blocks.length ?? 0) > 0, "no reply on the second turn");
      return `${blocks.filter((b) => b.type === "reasoning").length} reasoning block(s) replayed`;
    }],
    ["chaining", async () => {
      const c1 = ctx([user("Remember the number 7421. Reply only: ok")]);
      const r1 = clean(await go(c1));
      const stored = r1.completed?.ext?.["store"] === true;
      const c2 = ctx([...c1.turns, assistantTurn(r1.completed?.blocks ?? [], r1.completed?.ext), user("What number did I ask you to remember? Reply with the number only.")]);
      const r2 = clean(await go(c2));
      const answer = textOf(r2.completed?.blocks ?? []);
      ok(answer.includes("7421"), `the second turn lost the first: ${JSON.stringify(answer.slice(0, 60))}`);
      const chained = r2.completed?.ext?.["chained"] === true;
      if (!stored && !chained) return `ok; the server does not confirm storage, so the whole context was replayed`;
      ok(!stored || chained, "the server stored the response but the second request did not continue it");
      return chained ? "second turn continued the stored response (previous_response_id)" : "ok";
    }],
    ["retrieve", async () => {
      if (adapter.retrieve === undefined) return skip("this adapter does not retrieve responses");
      const r = clean(await go(ctx([user("Reply with the single word: pong")])));
      const id = r.completed?.observed.response_id;
      if (id === undefined || r.completed?.ext?.["store"] !== true) return skip("the server did not confirm that it stored the response");
      const got = await adapter.retrieve({ responseId: id, setup, signal: new AbortController().signal });
      ok(got !== undefined, `the stored response ${id} could not be retrieved`);
      ok(textOf(got.blocks).trim() === textOf(r.completed?.blocks ?? []).trim(), "the retrieved text differs from the streamed text");
      return `retrieved ${id}`;
    }],
    ["abort", async () => {
      const ac = new AbortController();
      const stream = adapter.stream({ context: ctx([user("Write a long story about a fox, at least 500 words.")]), setup, signal: ac.signal });
      const run = { events: [] as StreamRun["events"] } as StreamRun;
      try {
        for (;;) {
          const n = await stream.next();
          if (n.done === true) {
            run.completed = n.value;
            break;
          }
          run.events.push(n.value);
          if ((n.value.type === "text.delta" || n.value.type === "reasoning.delta") && !ac.signal.aborted) ac.abort();
        }
      } catch (e) {
        run.error = e;
      }
      await o.onRun?.(current, run);
      if (run.completed !== undefined) return skip("the reply finished before the abort took effect");
      ok(run.error instanceof ProviderError && run.error.kind === "aborted", `expected aborted, got ${String(run.error)}`);
      const problems = conformanceProblems(run, { secrets });
      ok(problems.length === 0, `conformance: ${problems.join("; ")}`);
      return "aborted mid-stream";
    }],
    ["bad-model", async () => {
      const bad: AgentSetup = { ...setup, model: { provider: "live", id: "chattree-no-such-model", settings: { max_output_tokens: 16 } } };
      const run = await collectStream(adapter.stream({ context: ctx([user("hi")]), setup: bad, signal: new AbortController().signal }));
      await o.onRun?.(current, run);
      ok(run.error instanceof ProviderError, `expected an error, got ${run.completed === undefined ? "nothing" : "a reply"}`);
      ok(run.error.kind === "invalid_request", `kind ${run.error.kind}: ${run.error.message}`);
      return `${run.error.kind}: ${run.error.message.slice(0, 60)}`;
    }],
  ];

  const results: ScenarioResult[] = [];
  for (const [name, fn] of scenarios) {
    if (o.only !== undefined && o.only.length > 0 && !o.only.includes(name)) continue;
    current = name;
    const t0 = Date.now();
    let r: ScenarioResult;
    try {
      r = { name, status: "pass", detail: await fn(), ms: Date.now() - t0 };
    } catch (e) {
      r = e instanceof Skip ? { name, status: "skip", detail: e.message, ms: Date.now() - t0 } : { name, status: "fail", detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
    results.push(r);
    o.onResult?.(r);
  }
  return results;
}

export const SCENARIO_NAMES = ["plain", "usage", "streaming", "tool-call", "tools-schema", "tools-parallel", "tools-reliability", "agent-loop", "reasoning-replay", "chaining", "retrieve", "abort", "bad-model"];

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): { options: LiveOptions; record?: string; list: boolean } {
  const flags = new Map<string, string[]>();
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--list") list = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else throw new Error(`unexpected argument ${a}`);
  }
  const one = (name: string): string | undefined => flags.get(name)?.[0];
  const known = new Set(["--flavor", "--base-url", "--model", "--max-tokens", "--api-key-env", "--record", "--only"]);
  for (const k of flags.keys()) if (!known.has(k)) throw new Error(`unknown flag ${k}`);
  const flavor = one("--flavor") ?? "anthropic";
  if (!(FLAVORS as readonly string[]).includes(flavor)) throw new Error(`--flavor must be one of ${FLAVORS.join(", ")}`);
  const baseUrl = one("--base-url");
  const model = one("--model");
  if (!list && (baseUrl === undefined || model === undefined)) throw new Error("--base-url and --model are required");
  const keyEnv = one("--api-key-env");
  let apiKey: string | undefined;
  if (keyEnv !== undefined) {
    apiKey = env[keyEnv];
    if (apiKey === undefined || apiKey === "") throw new Error(`the environment variable ${keyEnv} is not set`);
  }
  const maxTokens = one("--max-tokens");
  const only = flags.get("--only");
  for (const n of only ?? []) if (!SCENARIO_NAMES.includes(n)) throw new Error(`unknown scenario ${n} (${SCENARIO_NAMES.join(", ")})`);
  const record = one("--record");
  return {
    options: { flavor: flavor as Flavor, baseUrl: baseUrl ?? "", model: model ?? "", ...(maxTokens === undefined ? {} : { maxTokens: Number(maxTokens) }), ...(apiKey === undefined ? {} : { apiKey }), ...(only === undefined ? {} : { only }) },
    ...(record === undefined ? {} : { record }),
    list,
  };
}

async function main(): Promise<void> {
  const { options, record, list } = parseArgs(process.argv.slice(2), process.env);
  if (list) {
    console.log(SCENARIO_NAMES.join("\n"));
    return;
  }
  if (record !== undefined) await mkdir(record, { recursive: true });
  const secrets = options.apiKey === undefined ? [] : [options.apiKey];
  const counts = new Map<string, number>();
  const save = async (name: string, data: unknown): Promise<void> => {
    if (record === undefined) return;
    let text = JSON.stringify(data, null, 2);
    for (const s of secrets) text = text.split(s).join("[redacted]");
    await writeFile(join(record, `${options.flavor}-${name}.json`), text);
  };
  const results = await runLiveChecks({
    ...options,
    onResult: (r) => console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(17)} ${String(r.ms).padStart(6)}ms  ${r.detail}`),
    // Scenarios make several requests; each is its own file, numbered, so none overwrites another.
    onRun: async (scenario, run, request) => {
      if (record === undefined) return;
      const n = (counts.get(scenario) ?? 0) + 1;
      counts.set(scenario, n);
      await save(`${scenario}-${String(n).padStart(2, "0")}`, { request, events: run.events, completed: run.completed, error: run.error instanceof Error ? { name: run.error.name, message: run.error.message } : undefined });
    },
    onLog: async (scenario, label, data) => {
      if (record !== undefined) await save(`${scenario}-${label}`, data);
    },
  });
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`\n${results.filter((r) => r.status === "pass").length} passed, ${failed} failed, ${results.filter((r) => r.status === "skip").length} skipped`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
