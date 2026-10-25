/**
 * Validate an adapter against a real (or local) server.
 *
 *   node tools/live-check.ts --flavor anthropic --base-url http://localhost:11434 --model qwen3
 *   node tools/live-check.ts --flavor openai-responses --base-url http://localhost:11434/v1 --model qwen3 --api-key-env OPENAI_API_KEY
 *
 * Flags: --flavor, --base-url, --model, --max-tokens (default 512), --api-key-env NAME (the key is read from that
 * environment variable; never pass a key on the command line), --record DIR (save each scenario's events as JSON,
 * secrets scrubbed), --only NAME (repeatable), --list.
 *
 * Exit code: 1 if any scenario fails; a scenario the server does not support (a model without tools or
 * reasoning) is reported as `skip`, not as a failure. Ollama is a zero-cost stand-in: it speaks the Anthropic
 * and OpenAI Responses shapes. It ignores some fields (cache_control, tool_choice) and may not report in-stream errors.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Block, ModelContext, Turn } from "../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import { anthropicAdapter } from "../providers/anthropic.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../providers/conformance.ts";
import { openaiResponsesAdapter } from "../providers/openai-responses.ts";
import { ProviderError, type ProviderAdapter } from "../providers/types.ts";

export type Flavor = "anthropic" | "openai-responses";
export const FLAVORS: readonly Flavor[] = ["anthropic", "openai-responses"];

export interface LiveOptions {
  flavor: Flavor;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey?: string;
  only?: readonly string[];
  /** Called with each scenario's raw run, for recording. */
  onRun?: (scenario: string, run: StreamRun) => void | Promise<void>;
  /** Called as each scenario finishes. */
  onResult?: (r: ScenarioResult) => void;
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
  return openaiResponsesAdapter({ baseUrl: o.baseUrl, ...key });
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
    await o.onRun?.(current, run);
    return run;
  };
  const clean = (run: StreamRun): StreamRun => {
    const problems = conformanceProblems(run, { secrets });
    ok(problems.length === 0, `conformance: ${problems.join("; ")}`);
    if (run.error !== undefined) throw run.error;
    return run;
  };
  const assistantTurn = (blocks: Block[]): Turn => ({ role: "assistant", provider: "live", model: o.model, blocks });

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

export const SCENARIO_NAMES = ["plain", "usage", "streaming", "tool-call", "reasoning-replay", "abort", "bad-model"];

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
  const results = await runLiveChecks({
    ...options,
    onResult: (r) => console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(17)} ${String(r.ms).padStart(6)}ms  ${r.detail}`),
    onRun: async (scenario, run) => {
      if (record === undefined) return;
      let text = JSON.stringify({ events: run.events, completed: run.completed, error: run.error instanceof Error ? { name: run.error.name, message: run.error.message } : undefined }, null, 2);
      for (const s of secrets) text = text.split(s).join("[redacted]");
      await writeFile(join(record, `${options.flavor}-${scenario}.json`), text);
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
