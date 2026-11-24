/**
 * Measure how models do at fill-in-the-middle completion, and which way of asking works: our own prompt for the model's format sent to
 * `/completion`, or `/infill`, where the server writes the prompt from the model's own tokens. The tasks are made from the files of a
 * repository (`tools/completion-tasks.ts`: the answer is cut out of a file and the model is asked for it again), each is put to every
 * model by every arm, and every answer is scored against the text that was there and timed by the server's own figures.
 *
 *   node tools/completion-bench.ts --repo ../some-repo --model qwen2.5-coder-1.5b=qwen2.5-coder --model mellum-4b=mellum
 *   node tools/completion-bench.ts --server http://127.0.0.1:8080 --model local=seed-coder --arms completion,infill
 *   node tools/completion-bench.ts --summarize bench-runs/completion-2026-11-25T10-00-00   (writes the summary again from the samples)
 *
 * --model NAME=FORMAT (repeatable): a name from `local_models` in the settings file (or, with --server, the name sent in the `model` field,
 * which a server with one model ignores), and the format that model is prompted in: qwen2.5-coder, seed-coder, mellum, starcoder2 or
 * deepseek-coder. --server URL: an address of your own; without it the local model host is used (--yes agrees to installing llama.cpp).
 * --arms completion,infill,completion+files,infill+files (default all four): `+files` adds other files from the repository as context
 * (for `completion`, only for a format that has a place for them). --kinds line,mid-line,block, --per-kind N (default 10),
 * --seed N, --ext ts,py,... (default ts,tsx,js,mjs,py,rs,go,java,c,cpp,cs,rb), --max-files N (default 400), --max-tokens N (default 128),
 * --no-warm (skip the second, cache-warm request of each sample), --timeout-seconds N (default 120), --out DIR, --repo PATH (default here).
 *
 * Results are only as good as the choice of repository: use one the models cannot have been trained on (a private one, or one whose files
 * are newer than the model). Output, in the run's directory: samples.jsonl (one line per sample, written as it finishes), summary.md and
 * summary.json.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { localRuntime } from "../app/providers.ts";
import { loadSettings } from "../app/settings.ts";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import {
  CompletionError,
  completeInfill,
  completeRaw,
  fimFormat,
  type CompleteOptions,
  type FimRequest,
  type Timings,
} from "../providers/completion/index.ts";
import { scoreFim, type Score } from "./completion-score.ts";
import { FIM_KINDS, planFimTasks, type FimKind, type FimTask, type SourceFile } from "./completion-tasks.ts";

export type Arm = "completion" | "completion+files" | "infill" | "infill+files";
export const ARMS: readonly Arm[] = ["completion", "infill", "completion+files", "infill+files"];

export interface Target {
  /** What the results call it. */
  label: string;
  format: string;
  /** The name sent in the `model` field. */
  model?: string | undefined;
}

export interface Sample {
  target: string;
  format: string;
  arm: Arm;
  task: string;
  kind: FimKind;
  /** What the model wrote, as the server gave it. */
  text?: string | undefined;
  raw?: Score | undefined;
  filtered?: Score | undefined;
  suppressed?: boolean | undefined;
  trimmed?: boolean | undefined;
  /** `/infill` said the model has no fill-in-the-middle tokens. */
  unsupported?: boolean | undefined;
  error?: { message: string; status?: number | undefined } | undefined;
  stopType?: string | undefined;
  /** The request with the server's cache off, and again with it on. */
  cold?: Timings | undefined;
  warm?: Timings | undefined;
  /** The size of what was sent: the whole prompt for `completion`, the texts for `infill`. */
  sentChars?: number | undefined;
}

export interface RunPlan {
  baseUrl: string;
  targets: readonly Target[];
  arms: readonly Arm[];
  tasks: readonly FimTask[];
  repo?: string | undefined;
  warm: boolean;
  maxTokens: number;
  timeoutMs: number;
  fetch?: typeof fetch | undefined;
}

const key = (s: { target: string; arm: string; task: string }): string => `${s.target}|${s.arm}|${s.task}`;

/** Run every task against every target by every arm, interleaved by task so a slow patch of the machine falls on all alike. */
export async function runFimSamples(
  plan: RunPlan,
  hooks: { done?: ReadonlySet<string>; onSample?: (s: Sample) => void | Promise<void> } = {},
): Promise<Sample[]> {
  const out: Sample[] = [];
  const noInfill = new Set<string>();
  for (const task of plan.tasks) {
    for (const target of plan.targets) {
      const format = fimFormat(target.format);
      for (const arm of plan.arms) {
        const withFiles = arm.endsWith("+files");
        const transport = arm.startsWith("infill") ? "infill" : "completion";
        if (hooks.done?.has(key({ target: target.label, arm, task: task.id })) === true) continue;
        if (transport === "completion" && withFiles && !format.files) continue;
        if (transport === "infill" && noInfill.has(target.label)) {
          const s: Sample = { target: target.label, format: target.format, arm, task: task.id, kind: task.kind, unsupported: true };
          out.push(s);
          await hooks.onSample?.(s);
          continue;
        }
        const req: FimRequest = {
          path: task.path,
          repo: plan.repo,
          prefix: task.prefix,
          suffix: task.suffix,
          files: withFiles ? task.context : undefined,
        };
        const base = {
          baseUrl: plan.baseUrl,
          model: target.model,
          maxTokens: plan.maxTokens,
          timeoutMs: plan.timeoutMs,
          fetch: plan.fetch,
        };
        const rendered = transport === "completion" ? format.render(req) : undefined;
        const ask = (o: CompleteOptions) => (rendered !== undefined ? completeRaw(rendered, o) : completeInfill(req, o));
        const sample: Sample = {
          target: target.label,
          format: target.format,
          arm,
          task: task.id,
          kind: task.kind,
          sentChars:
            rendered?.prompt.length ?? req.prefix.length + req.suffix.length + (req.files ?? []).reduce((n, f) => n + f.text.length, 0),
        };
        try {
          const first = await ask({ ...base, cachePrompt: !plan.warm });
          const text = rendered !== undefined ? format.parse(first.text) : first.text;
          Object.assign(sample, { text, stopType: first.stopType, cold: first.timings }, scoreFim(task, text));
          if (plan.warm) sample.warm = (await ask({ ...base, cachePrompt: true })).timings;
        } catch (e) {
          if (e instanceof CompletionError && e.status === 501 && transport === "infill") {
            sample.unsupported = true;
            noInfill.add(target.label);
          } else
            sample.error = {
              message: e instanceof Error ? e.message : String(e),
              status: e instanceof CompletionError ? e.status : undefined,
            };
        }
        out.push(sample);
        await hooks.onSample?.(sample);
      }
    }
  }
  return out;
}

// ---- the summary --------------------------------------------------------------------------------------------------

const mean = (xs: readonly number[]): number | undefined => (xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length);
function percentile(xs: readonly number[], p: number): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
const pct = (xs: readonly boolean[]): string => (xs.length === 0 ? "-" : `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}%`);
const fixed = (n: number | undefined, d = 0): string => (n === undefined ? "-" : n.toFixed(d));

export interface Row {
  target: string;
  arm: Arm;
  kind: FimKind | "all";
  n: number;
  errors: number;
  unsupported: number;
  exact: string;
  firstLine: string;
  similarity: string;
  empty: string;
  /** Exact match after the filters, and how often they removed a suggestion or trimmed one. */
  shownExact: string;
  suppressed: string;
  trimmed: string;
  promptTokens: string;
  coldMs: string;
  warmMs: string;
  tokensPerSecond: string;
}

export function rowFor(target: string, arm: Arm, kind: FimKind | "all", all: readonly Sample[]): Row {
  const ss = all.filter((s) => s.target === target && s.arm === arm && (kind === "all" || s.kind === kind));
  const ok = ss.filter((s) => s.raw !== undefined);
  const speeds = ok.flatMap((s) => {
    const t = s.cold;
    return t?.generatedTokens !== undefined && t.generatedMs !== undefined && t.generatedMs > 0
      ? [(1000 * t.generatedTokens) / t.generatedMs]
      : [];
  });
  const cold = ok.flatMap((s) => (s.cold === undefined ? [] : [s.cold.totalMs]));
  const warm = ok.flatMap((s) => (s.warm === undefined ? [] : [s.warm.totalMs]));
  const range = (xs: readonly number[]): string =>
    xs.length === 0 ? "-" : `${fixed(percentile(xs, 0.5))} / ${fixed(percentile(xs, 0.95))}`;
  return {
    target,
    arm,
    kind,
    n: ok.length,
    errors: ss.filter((s) => s.error !== undefined).length,
    unsupported: ss.filter((s) => s.unsupported === true).length,
    exact: pct(ok.map((s) => s.raw?.exact === true)),
    firstLine: pct(ok.map((s) => s.raw?.firstLine === true)),
    similarity: fixed(mean(ok.map((s) => s.raw?.similarity ?? 0)), 2),
    empty: pct(ok.map((s) => s.raw?.empty === true)),
    shownExact: pct(ok.map((s) => s.filtered?.exact === true)),
    suppressed: pct(ok.map((s) => s.suppressed === true)),
    trimmed: pct(ok.map((s) => s.trimmed === true)),
    promptTokens: fixed(mean(ok.flatMap((s) => (s.cold?.promptTokens === undefined ? [] : [s.cold.promptTokens])))),
    coldMs: range(cold),
    warmMs: range(warm),
    tokensPerSecond: fixed(mean(speeds), 1),
  };
}

export function summarize(samples: readonly Sample[]): { rows: Row[]; markdown: string } {
  const targets = [...new Set(samples.map((s) => s.target))];
  const arms = ARMS.filter((a) => samples.some((s) => s.arm === a));
  const rows: Row[] = [];
  for (const t of targets) for (const a of arms) for (const k of ["all", ...FIM_KINDS] as const) rows.push(rowFor(t, a, k, samples));
  const head =
    "| model | arm | kind | n | err | no-infill | exact | first line | similarity | empty | shown exact | suppressed | trimmed | prompt tok | cold ms p50 / p95 | warm ms p50 / p95 | tok/s |\n" +
    "|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n";
  const body = rows
    .filter((r) => r.n + r.errors + r.unsupported > 0)
    .map(
      (r) =>
        `| ${r.target} | ${r.arm} | ${r.kind} | ${r.n} | ${r.errors} | ${r.unsupported} | ${r.exact} | ${r.firstLine} | ${r.similarity} | ${r.empty} | ${r.shownExact} | ${r.suppressed} | ${r.trimmed} | ${r.promptTokens} | ${r.coldMs} | ${r.warmMs} | ${r.tokensPerSecond} |`,
    )
    .join("\n");
  const errors = [...new Set(samples.flatMap((s) => (s.error === undefined ? [] : [`${s.target} ${s.arm}: ${s.error.message}`])))].slice(
    0,
    20,
  );
  const notes =
    "\n\n*exact*: the same text as the file had, ignoring blank space at the ends; *shown exact*: the same after the filters that trim what repeats the text after the cursor and drop an empty suggestion; " +
    "*cold*: the server's cache off, *warm*: the same request again with it on. Times are the whole request as this side saw it." +
    (errors.length === 0 ? "" : `\n\nErrors:\n\n${errors.map((e) => `- ${e}`).join("\n")}`) +
    "\n";
  return { rows, markdown: head + body + notes };
}

// ---- the command --------------------------------------------------------------------------------------------------

const run = promisify(execFile);
const DEFAULT_EXT = "ts,tsx,js,mjs,py,rs,go,java,c,cpp,cs,rb";

export interface CliOptions {
  repo: string;
  server?: string | undefined;
  models: { name: string; format: string }[];
  arms: Arm[];
  kinds: FimKind[];
  perKind: number;
  seed: number;
  ext: string[];
  maxFiles: number;
  maxTokens: number;
  warm: boolean;
  timeoutSeconds: number;
  out?: string | undefined;
  summarize?: string | undefined;
  resume?: string | undefined;
  yes: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    repo: ".",
    models: [],
    arms: [...ARMS],
    kinds: [...FIM_KINDS],
    perKind: 10,
    seed: 1,
    ext: DEFAULT_EXT.split(","),
    maxFiles: 400,
    maxTokens: 128,
    warm: true,
    timeoutSeconds: 120,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const int = (): number => {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) throw new Error(`${a} needs a whole number`);
      return n;
    };
    switch (a) {
      case "--repo":
        o.repo = value();
        break;
      case "--server":
        o.server = value();
        break;
      case "--model": {
        const v = value();
        const eq = v.lastIndexOf("=");
        if (eq <= 0) throw new Error(`--model needs NAME=FORMAT, got ${v}`);
        const format = v.slice(eq + 1);
        fimFormat(format);
        o.models.push({ name: v.slice(0, eq), format });
        break;
      }
      case "--arms":
        o.arms = value()
          .split(",")
          .map((x) => {
            if (!(ARMS as readonly string[]).includes(x)) throw new Error(`unknown arm ${x}; known: ${ARMS.join(", ")}`);
            return x as Arm;
          });
        break;
      case "--kinds":
        o.kinds = value()
          .split(",")
          .map((x) => {
            if (!(FIM_KINDS as readonly string[]).includes(x)) throw new Error(`unknown kind ${x}; known: ${FIM_KINDS.join(", ")}`);
            return x as FimKind;
          });
        break;
      case "--per-kind":
        o.perKind = int();
        break;
      case "--seed":
        o.seed = int();
        break;
      case "--ext":
        o.ext = value().split(",");
        break;
      case "--max-files":
        o.maxFiles = int();
        break;
      case "--max-tokens":
        o.maxTokens = int();
        break;
      case "--timeout-seconds":
        o.timeoutSeconds = int();
        break;
      case "--no-warm":
        o.warm = false;
        break;
      case "--out":
        o.out = value();
        break;
      case "--summarize":
        o.summarize = value();
        break;
      case "--resume":
        o.resume = value();
        break;
      case "--yes":
      case "-y":
        o.yes = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.git|target|__pycache__)\/|\.min\.|\.lock$|-lock\./;

/** The source files of a repository: tracked, of the chosen kinds, not generated, not tiny and not huge; in a fixed order. */
export async function repoFiles(repo: string, ext: readonly string[], maxFiles: number): Promise<SourceFile[]> {
  const { stdout } = await run("git", ["ls-files", "-z"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const wanted = new Set(ext.map((e) => e.replace(/^\./, "")));
  const paths = stdout
    .split("\0")
    .filter((p) => p !== "" && !SKIP.test(p) && wanted.has(p.slice(p.lastIndexOf(".") + 1)))
    .sort()
    .slice(0, maxFiles * 4);
  const files: SourceFile[] = [];
  for (const path of paths) {
    const text = await readFile(join(repo, path), "utf8").catch(() => undefined);
    if (text !== undefined && text.length >= 400 && text.length <= 60_000 && !text.includes("\0")) files.push({ path, text });
    if (files.length >= maxFiles) break;
  }
  return files;
}

async function readSamples(file: string): Promise<Sample[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Sample);
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const dir =
    o.resume ?? o.summarize ?? o.out ?? join("bench-runs", `completion-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const file = join(dir, "samples.jsonl");
  const writeSummary = async (all: readonly Sample[]): Promise<void> => {
    const s = summarize(all);
    await writeFile(join(dir, "summary.md"), s.markdown);
    await writeFile(join(dir, "summary.json"), JSON.stringify(s.rows, null, 2));
  };
  if (o.summarize !== undefined) {
    await writeSummary(await readSamples(file));
    console.log(`wrote ${join(dir, "summary.md")}`);
    return;
  }
  if (o.models.length === 0) throw new Error("give at least one --model NAME=FORMAT");
  const repo = resolve(o.repo);
  const files = await repoFiles(repo, o.ext, o.maxFiles);
  const tasks = planFimTasks(files, { seed: o.seed, perKind: o.perKind, kinds: o.kinds });
  if (tasks.length === 0) throw new Error(`no tasks could be made from ${repo} (${files.length} files of ${o.ext.join(", ")})`);
  let baseUrl = o.server;
  let nameOf = (n: string): string => n;
  if (baseUrl === undefined) {
    const io = nodeIo();
    io.settings = await loadSettings(io);
    await ensureLocalModels(io, { yes: o.yes });
    const rt = localRuntime(io);
    baseUrl = (await rt.connect()).baseUrl;
    nameOf = (n) => rt.resolve(n);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.json"), JSON.stringify({ ...o, tasks: tasks.length, repo }, null, 2));
  const done = new Set((await readSamples(file)).map(key));
  const plan: RunPlan = {
    baseUrl,
    targets: o.models.map((m) => ({ label: m.name, format: m.format, model: nameOf(m.name) })),
    arms: o.arms,
    tasks,
    repo: repo.split(/[\\/]/).at(-1),
    warm: o.warm,
    maxTokens: o.maxTokens,
    timeoutMs: o.timeoutSeconds * 1000,
  };
  console.error(
    `${dir}: ${tasks.length} tasks from ${files.length} files, ${plan.targets.length} models, arms ${o.arms.join(", ")}; ${done.size} samples already done`,
  );
  // A model is loaded by the first request it gets, which can take a minute: ask once for nothing, so that time is not in a sample.
  for (const t of plan.targets) {
    const loaded = await completeRaw({ prompt: "x", stop: [] }, { baseUrl, model: t.model, maxTokens: 1, timeoutMs: 600_000 }).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (loaded !== undefined) console.error(`note: ${t.label}: ${loaded}`);
  }
  let n = done.size;
  await runFimSamples(plan, {
    done,
    onSample: async (s) => {
      await appendFile(file, `${JSON.stringify(s)}\n`);
      console.error(
        `${++n} ${s.target} ${s.arm} ${s.kind} ${s.error !== undefined ? "error" : s.unsupported === true ? "no-infill" : s.raw?.exact === true ? "exact" : "-"}`,
      );
    },
  });
  await writeSummary(await readSamples(file));
  console.log(`wrote ${join(dir, "summary.md")}`);
}

if (import.meta.main) await main();
