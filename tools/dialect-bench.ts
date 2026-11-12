/**
 * Compare how a local model does the tool tasks under different ways of talking to it (docs/local-models.md, section 9): the server's
 * own chat template (`jinja`, with and without sending the reasoning back) against our dialect for that model (with and without
 * replaying reasoning). Every arm runs the same tasks in fresh workspaces through the real loop, interleaved (task by task, repeat by
 * repeat, so a slow patch of the machine falls on every arm alike), and each sample is scored by outcome as in tools/live-sample.ts.
 *
 *   node tools/dialect-bench.ts --model gpt-oss-20b=harmony --model Qwen3.5-9B=qwen-xml --model gemma4-12b=gemma --repeat 10 --yes
 *   node tools/dialect-bench.ts --resume bench-runs/2026-11-12T01-00-00   (carries on where an interrupted run stopped)
 *   node tools/dialect-bench.ts --summarize bench-runs/2026-11-12T01-00-00   (writes the summary again from the samples)
 *
 * --model NAME[=DIALECT] (repeatable): a name from `local_models` in the settings file; the dialect is guessed from the name (gpt-oss:
 * harmony, qwen: qwen-xml, gemma: gemma) when not given. --arms jinja,jinja+replay,dialect,dialect-no-reasoning (default: all four)
 * picks arms; --arm LABEL=JSON adds one of your own (model settings, e.g. 'mine={"dialect":"harmony","dialect_options":{"schema":"flat"}}').
 * --setting KEY=VALUE applies to every arm. Also --repeat N (default 10), --task TEXT, --group NAME, --max-tokens, --timeout-seconds,
 * --out DIR (default bench-runs/<time>), --yes (agree to installing llama.cpp), --busybox PATH.
 *
 * `--group context` runs tasks about what the prompt tells the model instead of how it calls tools (they are not in the default set): the
 * date reaching the model only through the `environment` injection, and a riddle whose thinking should grow with `reasoning_effort`
 * (compare output tokens across arms such as 'low={"dialect":"harmony","reasoning_effort":"low"}' and the same with high).
 *
 * Output, in the run's directory: samples.jsonl (one line per sample, written as it finishes, so nothing is lost if the run stops),
 * summary.md and summary.json (pass rates, time, requests and tokens per model and arm; the tool errors each arm met; the requests
 * that failed). A sample that was wrong, hit a tool error, or ended in anything but `completed` keeps everything about it: the steps,
 * the answer, every request as sent and the raw response, and each request's stop reason, usage and error with its cause.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import { dialectForModel } from "../providers/dialects/index.ts";
import { ProviderError, type ProviderAdapter } from "../providers/types.ts";
import { benchEnvironment, requireBusybox, runAgentTask, type ToolStep } from "./agent-task.ts";
import { blur, selectTasks } from "./live-sample.ts";
import { localModelsAdapter } from "./local-adapter.ts";
import type { Task } from "./tasks.ts";
import { tapFetch, type WireRecord } from "./wire-log.ts";

export interface Arm {
  label: string;
  /** Model settings of the arm, over the model's sampling. */
  settings: Record<string, unknown>;
}

export const DEFAULT_ARMS = ["jinja", "jinja+replay", "dialect", "dialect-no-reasoning"] as const;

export const guessDialect = dialectForModel;

/** The arms to run for a model: the chosen built-in ones, and the custom ones. */
export function armsFor(dialect: string | undefined, chosen: readonly string[], custom: readonly Arm[]): Arm[] {
  const builtin = (name: string): Arm => {
    if (name === "jinja") return { label: name, settings: {} };
    if (name === "jinja+replay") return { label: name, settings: { replay_reasoning: true } };
    if (dialect === undefined) throw new Error(`arm ${name} needs a dialect: give the model as NAME=DIALECT`);
    if (name === "dialect") return { label: name, settings: { dialect } };
    if (name === "dialect-no-reasoning") return { label: name, settings: { dialect, dialect_options: { keep_reasoning: false } } };
    throw new Error(`unknown arm ${name}; known: ${DEFAULT_ARMS.join(", ")}`);
  };
  return [...chosen.map(builtin), ...custom];
}

export interface RequestRecord {
  stop_reason?: string | undefined;
  usage?: { input: number; cached: number; output: number } | undefined;
  /** The model that answered, as the server says. */
  model?: string | undefined;
  blocks?: unknown;
  error?: { name: string; message: string; kind?: string; status?: number; retryable?: boolean; cause?: string } | undefined;
}

export interface BenchSample {
  model: string;
  arm: string;
  task: string;
  group: string;
  n: number;
  ok: boolean;
  /** Right and without a tool error on the way. */
  firstTry: boolean;
  problem?: string;
  status: string;
  noTools: boolean;
  ms: number;
  requests: number;
  toolErrors: number;
  /** Tokens over all of the sample's requests: all of the prompt, the part of it the server had cached, and what the model wrote. */
  tokens: { in: number; cached: number; out: number };
  /** Kept in full for samples that were not clean. */
  detail?: { steps: ToolStep[]; answer: string; requests: RequestRecord[]; wire: WireRecord[]; settings: Record<string, unknown> };
}

export const clean = (s: Pick<BenchSample, "ok" | "firstTry" | "status">): boolean => s.ok && s.firstTry && s.status === "completed";

const describeError = (e: unknown): NonNullable<RequestRecord["error"]> => {
  if (e instanceof ProviderError) return { name: e.name, message: e.message, kind: e.kind, ...(e.status === undefined ? {} : { status: e.status }), retryable: e.retryable, ...(e.cause === undefined ? {} : { cause: String((e.cause as Error)?.stack ?? e.cause) }) };
  if (e instanceof Error) return { name: e.name, message: e.message, ...(e.cause === undefined ? {} : { cause: String((e.cause as Error)?.stack ?? e.cause) }) };
  return { name: "unknown", message: String(e) };
};

export interface BenchOptions {
  adapter: ProviderAdapter;
  model: string;
  arm: Arm;
  sampling: Record<string, unknown>;
  settings: Record<string, unknown>;
  maxTokens: number;
  busybox?: string | undefined;
  timeoutSeconds: number;
  /** Where the wire taps report. Set by the caller that installed the tap. */
  wire?: { drain: () => Promise<WireRecord[]> };
}

/** One sample of one task under one arm. Never throws for a model's failure. */
export async function runOne(o: BenchOptions, task: Task, n: number): Promise<BenchSample> {
  const settings = { max_output_tokens: o.maxTokens, ...o.sampling, ...o.settings, ...o.arm.settings };
  const model = { provider: "live", id: o.model, settings } as NonNullable<AgentSetup["model"]>;
  const requests: RequestRecord[] = [];
  const tokens = { in: 0, cached: 0, out: 0 };
  await o.wire?.drain(); // anything left from before is not this sample's
  const t0 = Date.now();
  const r = await runAgentTask({
    adapter: o.adapter,
    model,
    busybox: o.busybox,
    environment: task.environment === true ? benchEnvironment(o.busybox) : undefined,
    files: task.files,
    prompt: task.prompt,
    timeoutMs: o.timeoutSeconds * 1000,
    onRequest: (run) => {
      const u = run.completed?.usage;
      if (u !== undefined) {
        tokens.cached += u.cache_read_tokens ?? 0;
        tokens.in += u.input_tokens + (u.cache_read_tokens ?? 0);
        tokens.out += u.output_tokens;
      }
      requests.push({ stop_reason: run.completed?.stop_reason, ...(u === undefined ? {} : { usage: { input: u.input_tokens, cached: u.cache_read_tokens ?? 0, output: u.output_tokens } }), model: run.completed?.observed.model, blocks: run.completed?.blocks, ...(run.error === undefined ? {} : { error: describeError(run.error) }) });
    },
  });
  const ms = Date.now() - t0;
  const noTools = r.used.size === 0;
  let problem: string | undefined;
  try {
    problem = noTools ? "the model made no tool call" : r.status !== "completed" ? `the loop ended with ${r.status}` : await task.check(r);
  } catch (e) {
    problem = `the check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const wire = (await o.wire?.drain()) ?? [];
  const s: BenchSample = { model: o.model, arm: o.arm.label, task: task.name, group: task.group, n, ok: problem === undefined, firstTry: problem === undefined && r.errors === 0, ...(problem === undefined ? {} : { problem }), status: r.status, noTools, ms, requests: r.requests, toolErrors: r.errors, tokens };
  if (!clean(s)) s.detail = { steps: r.steps, answer: r.answer, requests, wire, settings };
  return s;
}

// ---- summary ----------------------------------------------------------------------------------------------------

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};

export interface ArmSummary {
  model: string;
  arm: string;
  samples: number;
  correct: number;
  firstTry: number;
  noTools: number;
  endedBadly: number;
  meanSeconds: number;
  p90Seconds: number;
  meanRequests: number;
  meanIn: number;
  meanCached: number;
  meanOut: number;
  byGroup: Record<string, { samples: number; correct: number; firstTry: number }>;
  toolErrors: { count: number; message: string }[];
  requestErrors: { count: number; message: string }[];
}

export function summarize(samples: readonly BenchSample[]): ArmSummary[] {
  const keys = [...new Set(samples.map((s) => `${s.model}\u0000${s.arm}`))];
  return keys.map((k) => {
    const [model, arm] = k.split("\u0000") as [string, string];
    const mine = samples.filter((s) => s.model === model && s.arm === arm);
    const byGroup: ArmSummary["byGroup"] = {};
    for (const s of mine) {
      const g = (byGroup[s.group] ??= { samples: 0, correct: 0, firstTry: 0 });
      g.samples++;
      if (s.ok) g.correct++;
      if (s.firstTry) g.firstTry++;
    }
    const tally = (items: string[]): { count: number; message: string }[] => {
      const m = new Map<string, number>();
      for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
      return [...m].map(([message, count]) => ({ count, message })).sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
    };
    return {
      model,
      arm,
      samples: mine.length,
      correct: mine.filter((s) => s.ok).length,
      firstTry: mine.filter((s) => s.firstTry).length,
      noTools: mine.filter((s) => s.noTools).length,
      endedBadly: mine.filter((s) => s.status !== "completed").length,
      meanSeconds: mean(mine.map((s) => s.ms / 1000)),
      p90Seconds: quantile(mine.map((s) => s.ms / 1000), 0.9),
      meanRequests: mean(mine.map((s) => s.requests)),
      meanIn: mean(mine.map((s) => s.tokens.in)),
      meanCached: mean(mine.map((s) => s.tokens.cached)),
      meanOut: mean(mine.map((s) => s.tokens.out)),
      byGroup,
      toolErrors: tally(mine.flatMap((s) => (s.detail?.steps ?? []).filter((x) => x.is_error === true).map((x) => blur(x.name, x.result ?? "")))),
      requestErrors: tally(mine.flatMap((s) => (s.detail?.requests ?? []).flatMap((r) => (r.error === undefined ? [] : [`${r.error.kind ?? r.error.name}: ${r.error.message.slice(0, 140)}`])))),
    };
  });
}

const rate = (a: number, b: number): string => (b === 0 ? "-" : `${a}/${b} (${Math.round((100 * a) / b)}%)`);
const f1 = (n: number): string => n.toFixed(1);
const k = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export function formatSummary(sum: readonly ArmSummary[], meta: { when: string; repeat: number }): string {
  const out: string[] = [`# Dialect benchmark, ${meta.when}`, "", `${meta.repeat} samples per task and arm. Tokens are per sample (a sample is a whole task: several requests).`, ""];
  for (const model of [...new Set(sum.map((s) => s.model))]) {
    const rows = sum.filter((s) => s.model === model);
    out.push(`## ${model}`, "", "| arm | correct | first-try | no tool | ended badly | mean s | p90 s | requests | prompt tok | of which cached | output tok |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) out.push(`| ${r.arm} | ${rate(r.correct, r.samples)} | ${rate(r.firstTry, r.samples)} | ${r.noTools} | ${r.endedBadly} | ${f1(r.meanSeconds)} | ${f1(r.p90Seconds)} | ${f1(r.meanRequests)} | ${k(r.meanIn)} | ${k(r.meanCached)} | ${k(r.meanOut)} |`);
    const groups = [...new Set(rows.flatMap((r) => Object.keys(r.byGroup)))].sort();
    out.push("", "By group (first-try / correct):", "", `| arm | ${groups.join(" | ")} |`, `|---|${groups.map(() => "---").join("|")}|`);
    for (const r of rows) out.push(`| ${r.arm} | ${groups.map((g) => (r.byGroup[g] === undefined ? "-" : `${r.byGroup[g].firstTry}/${r.byGroup[g].correct}/${r.byGroup[g].samples}`)).join(" | ")} |`);
    for (const r of rows) {
      if (r.requestErrors.length > 0) out.push("", `Failed requests, ${r.arm}:`, "", ...r.requestErrors.slice(0, 10).map((e) => `- ${e.count} × ${e.message}`));
      if (r.toolErrors.length > 0) out.push("", `Most common tool errors, ${r.arm}:`, "", ...r.toolErrors.slice(0, 8).map((e) => `- ${e.count} × ${e.message}`));
    }
    out.push("");
  }
  return out.join("\n");
}

// ---- command line -----------------------------------------------------------------------------------------------

export interface CliOptions {
  models: { name: string; dialect: string | undefined }[];
  arms: string[];
  custom: Arm[];
  settings: Record<string, unknown>;
  repeat: number;
  tasks: string[];
  groups: string[];
  maxTokens: number;
  timeoutSeconds: number;
  out: string | undefined;
  resume: string | undefined;
  summarize: string | undefined;
  yes: boolean;
  busybox: string | undefined;
}

const json = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export function parseArgs(argv: readonly string[]): CliOptions {
  const flags = new Map<string, string[]>();
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--yes") yes = true;
    else if (a.startsWith("--")) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else throw new Error(`unexpected argument ${a}`);
  }
  const known = new Set(["--model", "--arms", "--arm", "--setting", "--repeat", "--task", "--group", "--max-tokens", "--timeout-seconds", "--out", "--resume", "--summarize", "--busybox"]);
  for (const f of flags.keys()) if (!known.has(f)) throw new Error(`unknown flag ${f}`);
  const one = (n: string): string | undefined => flags.get(n)?.[0];
  const int = (n: string, d: number): number => {
    const v = one(n);
    if (v === undefined) return d;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 1) throw new Error(`${n} must be a whole number of at least 1`);
    return x;
  };
  const models = (flags.get("--model") ?? []).map((m) => {
    const at = m.indexOf("=");
    const name = at < 0 ? m : m.slice(0, at);
    return { name, dialect: at < 0 ? guessDialect(name) : m.slice(at + 1) };
  });
  const settings: Record<string, unknown> = {};
  for (const kv of flags.get("--setting") ?? []) {
    const at = kv.indexOf("=");
    if (at < 1) throw new Error(`--setting takes KEY=VALUE, not ${kv}`);
    settings[kv.slice(0, at)] = json(kv.slice(at + 1));
  }
  const custom = (flags.get("--arm") ?? []).map((kv): Arm => {
    const at = kv.indexOf("=");
    const v = at < 1 ? undefined : json(kv.slice(at + 1));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`--arm takes LABEL=JSON, an object of model settings, not ${kv}`);
    return { label: kv.slice(0, at), settings: v as Record<string, unknown> };
  });
  const resume = one("--resume");
  const summarizeDir = one("--summarize");
  if (models.length === 0 && resume === undefined && summarizeDir === undefined) throw new Error("--model is required: a name from local_models in the settings file, optionally NAME=DIALECT");
  return {
    models,
    arms: one("--arms")?.split(",").map((a) => a.trim()).filter((a) => a !== "") ?? [...DEFAULT_ARMS],
    custom,
    settings,
    repeat: int("--repeat", 10),
    tasks: flags.get("--task") ?? [],
    groups: flags.get("--group") ?? [],
    maxTokens: int("--max-tokens", 4096),
    timeoutSeconds: int("--timeout-seconds", 180),
    out: one("--out"),
    resume,
    summarize: summarizeDir,
    yes,
    busybox: one("--busybox"),
  };
}

export async function readSamples(file: string): Promise<BenchSample[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
    try {
      return [JSON.parse(l) as BenchSample];
    } catch {
      return []; // a line cut off by a crash
    }
  });
}

async function writeSummary(dir: string, samples: BenchSample[], repeat: number): Promise<void> {
  const sum = summarize(samples);
  await writeFile(join(dir, "summary.json"), JSON.stringify(sum, null, 2));
  await writeFile(join(dir, "summary.md"), formatSummary(sum, { when: new Date().toISOString(), repeat }));
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const dir = o.resume ?? o.summarize ?? o.out ?? join("bench-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  const file = join(dir, "samples.jsonl");
  let plan: CliOptions = o;
  if (o.resume !== undefined || o.summarize !== undefined) {
    const saved = JSON.parse(await readFile(join(dir, "plan.json"), "utf8")) as CliOptions;
    plan = { ...saved, yes: o.yes, busybox: o.busybox ?? saved.busybox };
  } else {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plan.json"), JSON.stringify(o, null, 2));
  }
  const have = await readSamples(file);
  if (o.summarize !== undefined) {
    await writeSummary(dir, have, plan.repeat);
    console.log(`wrote ${join(dir, "summary.md")}`);
    return;
  }
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: plan.yes });
  const adapter = localModelsAdapter(io);
  const busybox = await requireBusybox(plan.busybox);
  const { run: tasks } = selectTasks({ tasks: plan.tasks, groups: plan.groups, busybox });
  let wireBuf: WireRecord[] = [];
  const tap = tapFetch((u) => u.endsWith("/chat/completions") || u.endsWith("/completion"), (r) => void wireBuf.push(r));
  const wire = {
    drain: async (): Promise<WireRecord[]> => {
      await tap.flush();
      const got = wireBuf;
      wireBuf = [];
      return got;
    },
  };
  const done = new Set(have.map((s) => `${s.model}|${s.arm}|${s.task}|${s.n}`));
  const all = [...have];
  const total = plan.models.length * tasks.length * plan.repeat * (plan.arms.length + plan.custom.length);
  let count = done.size;
  console.error(`${dir}: ${total} samples planned, ${done.size} already done`);
  for (const m of plan.models) {
    const found = await lookupSampling(io, m.name);
    for (const n of found.notes) console.error(`note: ${n}`);
    const sampling = samplingSettings(found.values) as Record<string, unknown>;
    const arms = armsFor(m.dialect, plan.arms, plan.custom);
    for (const task of tasks) {
      for (let n = 1; n <= plan.repeat; n++) {
        for (const arm of arms) {
          if (done.has(`${m.name}|${arm.label}|${task.name}|${n}`)) continue;
          const s = await runOne({ adapter, model: m.name, arm, sampling, settings: plan.settings, maxTokens: plan.maxTokens, busybox, timeoutSeconds: plan.timeoutSeconds, wire }, task, n);
          await appendFile(file, `${JSON.stringify(s)}\n`);
          all.push(s);
          console.error(`[${++count}/${total}] ${m.name} ${arm.label} ${task.name} #${n}: ${s.ok ? (s.firstTry ? "ok" : "ok (after a tool error)") : `WRONG (${(s.problem ?? "").slice(0, 60)})`}  ${s.requests} req, ${(s.ms / 1000).toFixed(1)}s, ${s.tokens.in}/${s.tokens.out} tok`);
        }
      }
      await writeSummary(dir, all, plan.repeat); // after every task, so a stopped run has a summary too
    }
  }
  tap.restore();
  await writeSummary(dir, all, plan.repeat);
  console.log(await readFile(join(dir, "summary.md"), "utf8"));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
