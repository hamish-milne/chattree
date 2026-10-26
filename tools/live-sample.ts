/**
 * Measure how reliably a model uses the starter tools: each task is run many times in fresh workspaces through the real
 * loop and scored by outcome (tools/tasks.ts). Use it to compare tool designs and models.
 *
 *   node tools/live-sample.ts --flavor openai-compatible --base-url http://localhost:11434/v1 --model gemma4:12b --repeat 10
 *   node tools/live-sample.ts ... --group edit --repeat 20 --out edit-run.json --record ./samples/
 *
 * Flags: --flavor, --base-url, --model, --max-tokens (default 4096), --api-key-env NAME, --repeat N (default 10),
 * --task TEXT (repeatable; a substring of the task name), --group edit|read|write|run|mixed (repeatable), --busybox PATH
 * (busybox.exe for the everyday utilities on Windows; default: CHATTREE_BUSYBOX or vendor/busybox, see tools/fetch-busybox.ts), --timeout-seconds (per sample, default 180), --out FILE (every
 * sample as JSON), --record DIR (the steps of every sample, secrets scrubbed), --list.
 *
 * "first-try" counts samples that were right with no tool error on the way; the gap to "correct" is what the model
 * recovered from. The error table shows what the tools said to the model most often, with ids and numbers blurred.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSetup } from "../harness/setup.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { runAgentTask, type ToolStep } from "./agent-task.ts";
import { findBusybox } from "../hosts/node.ts";
import { FLAVORS, makeAdapter, type Flavor } from "./live-check.ts";
import { available, TASKS, type Task } from "./tasks.ts";

export interface SampleOptions {
  flavor: Flavor;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey?: string;
  repeat?: number;
  tasks?: readonly string[];
  groups?: readonly string[];
  /** busybox.exe, for the everyday utilities on Windows. */
  busybox?: string | undefined;
  timeoutSeconds?: number;
  /** For tests: use this instead of the flavor's adapter. */
  adapter?: ProviderAdapter;
  onSample?: (s: Sample, done: number, total: number) => void;
}

export interface Sample {
  task: string;
  n: number;
  /** Undefined when the outcome was right. */
  problem?: string;
  /** The model made no tool call at all. */
  noTools: boolean;
  requests: number;
  errors: number;
  status: string;
  ms: number;
  steps: ToolStep[];
  answer: string;
}

export interface TaskStats {
  task: string;
  group: string;
  samples: number;
  correct: number;
  firstTry: number;
  noTools: number;
  meanRequests: number;
  meanErrors: number;
}

export interface SampleReport {
  stats: TaskStats[];
  samples: Sample[];
  skipped: { task: string; why: string }[];
  errors: { count: number; message: string }[];
}

/** An error message with the parts that differ from run to run blurred, so the same mistake counts as one. */
export function blur(tool: string, result: string): string {
  const lines = result.split("\n");
  const first = (lines.find((l) => /^failed: /.test(l)) ?? lines[0] ?? "").replace(/^failed: [^:]*: /, "");
  const text = first.replace(/[0-9a-f]{8,}/gi, "<hash>").replace(/"[^"]{25,}"/g, '"…"').replace(/\d+/g, "#").slice(0, 110);
  return `${tool}: ${text}`;
}

export function selectTasks(o: Pick<SampleOptions, "tasks" | "groups" | "busybox">): { run: Task[]; skipped: { task: string; why: string }[] } {
  const run: Task[] = [];
  const skipped: { task: string; why: string }[] = [];
  for (const t of TASKS) {
    if (o.tasks !== undefined && o.tasks.length > 0 && !o.tasks.some((x) => t.name.includes(x))) continue;
    if (o.groups !== undefined && o.groups.length > 0 && !o.groups.includes(t.group)) continue;
    const missing = (t.needs ?? []).filter((n) => !available(n, o.busybox));
    if (missing.length > 0) skipped.push({ task: t.name, why: `needs ${missing.join(", ")}` });
    else run.push(t);
  }
  return { run, skipped };
}

export async function runSamples(o: SampleOptions): Promise<SampleReport> {
  const adapter = o.adapter ?? makeAdapter(o);
  const model = { provider: "live", id: o.model, settings: { max_output_tokens: o.maxTokens ?? 4096 } } as NonNullable<AgentSetup["model"]>;
  const repeat = o.repeat ?? 10;
  const { run, skipped } = selectTasks(o);
  const samples: Sample[] = [];
  let done = 0;
  for (const task of run) {
    for (let n = 1; n <= repeat; n++) {
      const t0 = Date.now();
      const r = await runAgentTask({ adapter, model, busybox: o.busybox, files: task.files, prompt: task.prompt, timeoutMs: (o.timeoutSeconds ?? 180) * 1000 });
      const noTools = r.used.size === 0;
      const problem = noTools ? "the model made no tool call" : r.status !== "completed" ? `the loop ended with ${r.status}` : await task.check(r);
      const s: Sample = { task: task.name, n, ...(problem === undefined ? {} : { problem }), noTools, requests: r.requests, errors: r.errors, status: r.status, ms: Date.now() - t0, steps: r.steps, answer: r.answer };
      samples.push(s);
      o.onSample?.(s, ++done, run.length * repeat);
    }
  }
  const stats: TaskStats[] = run.map((task) => {
    const mine = samples.filter((s) => s.task === task.name);
    const mean = (f: (s: Sample) => number): number => (mine.length === 0 ? 0 : mine.reduce((a, s) => a + f(s), 0) / mine.length);
    return {
      task: task.name,
      group: task.group,
      samples: mine.length,
      correct: mine.filter((s) => s.problem === undefined).length,
      firstTry: mine.filter((s) => s.problem === undefined && s.errors === 0).length,
      noTools: mine.filter((s) => s.noTools).length,
      meanRequests: mean((s) => s.requests),
      meanErrors: mean((s) => s.errors),
    };
  });
  const counts = new Map<string, number>();
  for (const s of samples) for (const step of s.steps) if (step.is_error === true) counts.set(blur(step.name, step.result ?? ""), (counts.get(blur(step.name, step.result ?? "")) ?? 0) + 1);
  const errors = [...counts].map(([message, count]) => ({ count, message })).sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
  return { stats, samples, skipped, errors };
}

const pct = (a: number, b: number): string => (b === 0 ? "-" : `${a}/${b}`);

export function formatReport(report: SampleReport, o: Pick<SampleOptions, "flavor" | "model" | "repeat">): string {
  const lines: string[] = [];
  lines.push(`${o.flavor} ${o.model}: ${o.repeat ?? 10} samples per task, ${report.stats.length} tasks${report.skipped.length > 0 ? ` (skipped: ${report.skipped.map((s) => `${s.task} (${s.why})`).join(", ")})` : ""}`);
  lines.push("");
  const w = Math.max(4, ...report.stats.map((s) => s.task.length));
  lines.push(`${"task".padEnd(w)}  ${"correct".padStart(8)}  ${"first-try".padStart(9)}  ${"requests".padStart(8)}  ${"errors".padStart(6)}  no-tool`);
  for (const s of report.stats) lines.push(`${s.task.padEnd(w)}  ${pct(s.correct, s.samples).padStart(8)}  ${pct(s.firstTry, s.samples).padStart(9)}  ${s.meanRequests.toFixed(1).padStart(8)}  ${s.meanErrors.toFixed(1).padStart(6)}  ${s.noTools}`);
  const groups = [...new Set(report.stats.map((s) => s.group))];
  lines.push("");
  for (const g of groups) {
    const rows = report.stats.filter((s) => s.group === g);
    const total = rows.reduce((a, s) => a + s.samples, 0);
    lines.push(`${g.padEnd(w)}  ${pct(rows.reduce((a, s) => a + s.correct, 0), total).padStart(8)}  ${pct(rows.reduce((a, s) => a + s.firstTry, 0), total).padStart(9)}`);
  }
  const failures = report.samples.filter((s) => s.problem !== undefined);
  if (failures.length > 0) {
    lines.push("", "wrong outcomes (first of each task):");
    for (const t of new Set(failures.map((s) => s.task))) lines.push(`  ${t}: ${failures.find((s) => s.task === t)?.problem?.slice(0, 160)}`);
  }
  if (report.errors.length > 0) {
    lines.push("", "most common tool errors:");
    for (const e of report.errors.slice(0, 12)) lines.push(`  ${String(e.count).padStart(4)}  ${e.message}`);
  }
  return lines.join("\n");
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): { options: SampleOptions; out?: string; record?: string; list: boolean } {
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
  const known = new Set(["--flavor", "--base-url", "--model", "--max-tokens", "--api-key-env", "--repeat", "--task", "--group", "--timeout-seconds", "--out", "--record", "--busybox"]);
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
  const num = (name: string): number | undefined => {
    const v = one(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1`);
    return n;
  };
  const groups = flags.get("--group");
  for (const g of groups ?? []) if (!["edit", "read", "write", "run", "mixed"].includes(g)) throw new Error(`--group must be edit, read, write, run or mixed`);
  const out = one("--out");
  const record = one("--record");
  const repeat = num("--repeat");
  const maxTokens = num("--max-tokens");
  const timeout = num("--timeout-seconds");
  const tasks = flags.get("--task");
  const busybox = one("--busybox");
  return {
    options: {
      flavor: flavor as Flavor,
      baseUrl: baseUrl ?? "",
      model: model ?? "",
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(repeat === undefined ? {} : { repeat }),
      ...(tasks === undefined ? {} : { tasks }),
      ...(groups === undefined ? {} : { groups }),
      ...(busybox === undefined ? {} : { busybox }),
      ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
    },
    ...(out === undefined ? {} : { out }),
    ...(record === undefined ? {} : { record }),
    list,
  };
}

async function main(): Promise<void> {
  const { options, out, record, list } = parseArgs(process.argv.slice(2), process.env);
  if (list) {
    for (const t of TASKS) console.log(`${t.group.padEnd(6)} ${t.name}${t.needs === undefined ? "" : `  (needs ${t.needs.join(", ")})`}`);
    return;
  }
  const busybox = options.busybox ?? (await findBusybox());
  const secrets = options.apiKey === undefined ? [] : [options.apiKey];
  const scrub = (text: string): string => secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);
  if (record !== undefined) await mkdir(record, { recursive: true });
  const report = await runSamples({
    ...options,
    busybox,
    onSample: (s, done, total) => {
      console.error(`[${done}/${total}] ${s.task} #${s.n}: ${s.problem === undefined ? "ok" : `WRONG (${s.problem.slice(0, 70)})`}  ${s.requests} req, ${s.errors} err, ${(s.ms / 1000).toFixed(1)}s`);
      if (record !== undefined) void writeFile(join(record, `${options.flavor}-${s.task.replaceAll(" ", "-")}-${String(s.n).padStart(2, "0")}.json`), scrub(JSON.stringify(s, null, 2)));
    },
  });
  console.log(`\n${scrub(formatReport(report, options))}`);
  if (out !== undefined) await writeFile(out, scrub(JSON.stringify({ options: { ...options, apiKey: undefined }, ...report }, null, 2)));
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  });
}
