/**
 * Measure how models do at completing code that has to work: the tasks (`tools/exec-suite.ts`) are small JavaScript modules, and an answer is
 * right if the module, run on its tests, gives what the original gives, whatever the text. Two kinds, by the model's format:
 *
 * - a fill-in-the-middle format (qwen2.5-coder, seed-coder, mellum, starcoder2, deepseek-coder): a span of the module is taken out and the model
 *   writes it, asked with our own prompt (`completion`) and with the server's (`infill`);
 * - a next-edit format (sweep-next-edit, or sweep-next-edit-1.5b, which is laid out differently): the person's first edit of a change is shown and the file as it now is, which no longer works, and the
 *   model writes the lines again so that it does (`edit`).
 *
 *   node tools/exec-bench.ts --server http://127.0.0.1:8080 --model qwen=qwen2.5-coder --model sweep=sweep-next-edit
 *   node tools/exec-bench.ts --model mellum-4b=mellum --arms completion --limit 5
 *   node tools/exec-bench.ts --summarize bench-runs/exec-a,bench-runs/exec-b --out bench-runs/exec-all   (the samples of several runs, together)
 *
 * --model NAME=FORMAT (repeatable), --server URL and --yes are as for `tools/completion-bench.ts`. --arms completion,infill (fill-in-the-middle
 * formats only; default both). --limit N: only N tasks of each kind, spread evenly through the suite. --only TEXT: tasks whose id has TEXT in it.
 * --max-tokens N (default 128; 512 for edits), --timeout-seconds N (default 180), --no-filters (do not score the answer as it would be shown),
 * --out DIR, --resume DIR. The code that models write is run in a child process with no access to files, processes or the network, which is
 * enough for a test of a local model and not a defence against code made to attack.
 *
 * Output, in the run's directory: samples.jsonl (one line a sample, written as it finishes), summary.md and summary.json.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localRuntime } from "../app/providers.ts";
import { loadSettings } from "../app/settings.ts";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import {
  CompletionError,
  completeInfill,
  completeRaw,
  completionFormat,
  shown,
  type CompleteOptions,
  type FimRequest,
  type Timings,
} from "../providers/completion/index.ts";
import {
  applyLines,
  editTasksOf,
  fimTasksOf,
  grade,
  loadSuite,
  withFill,
  type ExecEditTask,
  type ExecFimTask,
  type ExecKind,
  type Spec,
  type Verdict,
} from "./exec-suite.ts";

export type ExecArm = "completion" | "infill" | "edit";
export type ExecTaskKind = ExecKind | "rename" | "call-site";
export const FIM_ARMS: readonly ExecArm[] = ["completion", "infill"];

export interface ExecTarget {
  label: string;
  format: string;
  model?: string | undefined;
}

export interface ExecSample {
  target: string;
  format: string;
  arm: ExecArm;
  task: string;
  kind: ExecTaskKind;
  /** What the model wrote (for an edit, the lines it wrote). */
  text?: string | undefined;
  /** Whether the module worked with it in, and how it failed if not. */
  verdict?: Verdict | undefined;
  /** The same, after the filters that cut what repeats the text after the cursor; only for fill-in-the-middle. */
  shownVerdict?: Verdict | "suppressed" | undefined;
  /** Whether the text is the same as the original's (blank space at the ends aside): it need not be to pass. */
  exact?: boolean | undefined;
  unsupported?: boolean | undefined;
  error?: { message: string; status?: number | undefined } | undefined;
  stopType?: string | undefined;
  timings?: Timings | undefined;
}

export interface ExecPlan {
  baseUrl: string;
  targets: readonly ExecTarget[];
  arms: readonly ExecArm[];
  specs: readonly Spec[];
  fim: readonly ExecFimTask[];
  edits: readonly ExecEditTask[];
  maxTokens: number;
  editTokens: number;
  timeoutMs: number;
  filters: boolean;
  fetch?: typeof fetch | undefined;
}

const key = (s: { target: string; arm: string; task: string }): string => `${s.target}|${s.arm}|${s.task}`;
const same = (a: string, b: string): boolean => a.trim() === b.trim();

/** Put every task to every target it fits, task by task so that a slow patch of the machine falls on all alike. */
export async function runExecSamples(
  plan: ExecPlan,
  hooks: { done?: ReadonlySet<string>; onSample?: (s: ExecSample) => void | Promise<void> } = {},
): Promise<ExecSample[]> {
  const out: ExecSample[] = [];
  const noInfill = new Set<string>();
  const spec = (id: string): Spec => plan.specs.find((s) => s.id === id) as Spec;
  const emit = async (s: ExecSample): Promise<void> => {
    out.push(s);
    await hooks.onSample?.(s);
  };
  const base = (target: ExecTarget, maxTokens: number): CompleteOptions => ({
    baseUrl: plan.baseUrl,
    model: target.model,
    maxTokens,
    timeoutMs: plan.timeoutMs,
    fetch: plan.fetch,
  });
  const fail = (s: ExecSample, e: unknown): void => {
    s.error = { message: e instanceof Error ? e.message : String(e), status: e instanceof CompletionError ? e.status : undefined };
  };

  for (const task of plan.fim) {
    for (const target of plan.targets) {
      const format = completionFormat(target.format);
      if (format.kind !== "fim") continue;
      for (const arm of plan.arms) {
        if (arm === "edit") continue;
        if (hooks.done?.has(key({ target: target.label, arm, task: task.id })) === true) continue;
        const sample: ExecSample = { target: target.label, format: target.format, arm, task: task.id, kind: task.kind };
        if (arm === "infill" && noInfill.has(target.label)) {
          sample.unsupported = true;
          await emit(sample);
          continue;
        }
        const req: FimRequest = { path: task.path, prefix: task.prefix, suffix: task.suffix };
        try {
          const o = base(target, plan.maxTokens);
          const r = arm === "completion" ? await completeRaw(format.render(req), o) : await completeInfill(req, o);
          const text = arm === "completion" ? format.parse(r.text) : r.text;
          const s = spec(task.spec);
          Object.assign(sample, { text, stopType: r.stopType, timings: r.timings, exact: same(text, task.expected) });
          sample.verdict = await grade(s, withFill(s, task, text));
          if (plan.filters) {
            const f = shown(text, task.prefix, task.suffix);
            sample.shownVerdict =
              "text" in f ? (f.text === text ? sample.verdict : await grade(s, withFill(s, task, f.text))) : "suppressed";
          }
        } catch (e) {
          if (e instanceof CompletionError && e.status === 501 && arm === "infill") {
            sample.unsupported = true;
            noInfill.add(target.label);
          } else fail(sample, e);
        }
        await emit(sample);
      }
    }
  }

  for (const task of plan.edits) {
    for (const target of plan.targets) {
      const format = completionFormat(target.format);
      if (format.kind !== "edit") continue;
      if (hooks.done?.has(key({ target: target.label, arm: "edit", task: task.id })) === true) continue;
      const sample: ExecSample = { target: target.label, format: target.format, arm: "edit", task: task.id, kind: task.kind };
      try {
        const rendered = format.render({
          path: task.path,
          text: task.stale,
          before: spec(task.spec).reference,
          cursor: task.cursor,
          recentChanges: [task.recent],
          linesAfter: task.linesAfter,
        });
        const r = await completeRaw(rendered, base(target, plan.editTokens));
        const suggestion = format.parse(r.text, rendered);
        const s = spec(task.spec);
        const result = applyLines(task.stale, suggestion.startLine, suggestion.endLine, suggestion.text);
        Object.assign(sample, { text: suggestion.text, stopType: r.stopType, timings: r.timings, exact: same(result, task.after) });
        sample.verdict = await grade(s, result);
      } catch (e) {
        fail(sample, e);
      }
      await emit(sample);
    }
  }
  return out;
}

// ---- the summary --------------------------------------------------------------------------------------------------

const pct = (n: number, of: number): string => (of === 0 ? "-" : `${Math.round((100 * n) / of)}%`);
const median = (xs: readonly number[]): string => {
  if (xs.length === 0) return "-";
  const sorted = [...xs].sort((a, b) => a - b);
  return String(Math.round(sorted[Math.floor(sorted.length / 2)] as number));
};

export interface ExecRow {
  target: string;
  arm: ExecArm;
  kind: ExecTaskKind | "all";
  n: number;
  errors: number;
  unsupported: number;
  pass: number;
  /** After the filters. */
  shownPass: number;
  exact: number;
  /** Passed with text that is not the original's: what an exact-match score would have marked wrong. */
  passNotExact: number;
  wrong: number;
  syntax: number;
  timeout: number;
  crash: number;
  ms: string;
}

export function execRowFor(target: string, arm: ExecArm, kind: ExecTaskKind | "all", all: readonly ExecSample[]): ExecRow {
  const ss = all.filter((s) => s.target === target && s.arm === arm && (kind === "all" || s.kind === kind));
  const ok = ss.filter((s) => s.verdict !== undefined);
  const count = (v: Verdict): number => ok.filter((s) => s.verdict === v).length;
  return {
    target,
    arm,
    kind,
    n: ok.length,
    errors: ss.filter((s) => s.error !== undefined).length,
    unsupported: ss.filter((s) => s.unsupported === true).length,
    pass: count("pass"),
    shownPass: ok.filter((s) => s.shownVerdict === "pass").length,
    exact: ok.filter((s) => s.exact === true).length,
    passNotExact: ok.filter((s) => s.verdict === "pass" && s.exact !== true).length,
    wrong: count("wrong"),
    syntax: count("syntax"),
    timeout: count("timeout"),
    crash: count("crash"),
    ms: median(ok.flatMap((s) => (s.timings === undefined ? [] : [s.timings.totalMs]))),
  };
}

export function summarizeExec(samples: readonly ExecSample[]): { rows: ExecRow[]; markdown: string } {
  const targets = [...new Set(samples.map((s) => s.target))];
  const rows: ExecRow[] = [];
  for (const t of targets) {
    for (const a of ["completion", "infill", "edit"] as const) {
      const mine = samples.filter((s) => s.target === t && s.arm === a);
      if (mine.length === 0) continue;
      const kinds = [...new Set(mine.map((s) => s.kind))].sort();
      for (const k of ["all", ...kinds] as const) rows.push(execRowFor(t, a, k, samples));
    }
  }
  const head =
    "| model | arm | kind | n | err | no-infill | **works** | works, as shown | exact text | works but not exact | wrong output | syntax error | timeout | crash | ms p50 |\n" +
    "|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n";
  const body = rows
    .filter((r) => r.n + r.errors + r.unsupported > 0)
    .map(
      (r) =>
        `| ${r.target} | ${r.arm} | ${r.kind} | ${r.n} | ${r.errors} | ${r.unsupported} | **${pct(r.pass, r.n)}** | ${r.arm === "edit" ? "-" : pct(r.shownPass, r.n)} | ${pct(r.exact, r.n)} | ${r.passNotExact} | ${r.wrong} | ${r.syntax} | ${r.timeout} | ${r.crash} | ${r.ms} |`,
    )
    .join("\n");
  const errors = [...new Set(samples.flatMap((s) => (s.error === undefined ? [] : [`${s.target} ${s.arm}: ${s.error.message}`])))].slice(
    0,
    20,
  );
  const notes =
    "\n\n*works*: the module, run on its tests with the answer in, gave the original's outputs; *as shown*: the same after the filters that cut what repeats " +
    "the text after the cursor and drop an empty answer; *exact text*: the answer was the original text (blank space at the ends aside); *works but not exact*: " +
    "how many answers an exact-match score would have called wrong." +
    (errors.length === 0 ? "" : `\n\nErrors:\n\n${errors.map((e) => `- ${e}`).join("\n")}`) +
    "\n";
  return { rows, markdown: head + body + notes };
}

// ---- the command --------------------------------------------------------------------------------------------------

export interface ExecCliOptions {
  server?: string | undefined;
  models: { name: string; format: string }[];
  arms: ExecArm[];
  limit?: number | undefined;
  only?: string | undefined;
  maxTokens: number;
  editTokens: number;
  timeoutSeconds: number;
  filters: boolean;
  out?: string | undefined;
  summarize?: string | undefined;
  resume?: string | undefined;
  yes: boolean;
}

export function parseExecArgs(argv: readonly string[]): ExecCliOptions {
  const o: ExecCliOptions = {
    models: [],
    arms: [...FIM_ARMS],
    maxTokens: 128,
    editTokens: 512,
    timeoutSeconds: 180,
    filters: true,
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
      case "--server":
        o.server = value();
        break;
      case "--model": {
        const v = value();
        const eq = v.lastIndexOf("=");
        if (eq <= 0) throw new Error(`--model needs NAME=FORMAT, got ${v}`);
        completionFormat(v.slice(eq + 1));
        o.models.push({ name: v.slice(0, eq), format: v.slice(eq + 1) });
        break;
      }
      case "--arms":
        o.arms = value()
          .split(",")
          .map((x) => {
            if (!(FIM_ARMS as readonly string[]).includes(x)) throw new Error(`unknown arm ${x}; known: ${FIM_ARMS.join(", ")}`);
            return x as ExecArm;
          });
        break;
      case "--limit":
        o.limit = int();
        break;
      case "--only":
        o.only = value();
        break;
      case "--max-tokens":
        o.maxTokens = int();
        break;
      case "--edit-tokens":
        o.editTokens = int();
        break;
      case "--timeout-seconds":
        o.timeoutSeconds = int();
        break;
      case "--no-filters":
        o.filters = false;
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

/** Every `limit`-th task so that N are left, always including the first: a spread through the suite, not its first few modules. */
export function spread<T>(items: readonly T[], limit: number | undefined): T[] {
  if (limit === undefined || limit >= items.length) return [...items];
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * items.length) / limit)] as T);
  return out;
}

export function planTasks(
  specs: readonly Spec[],
  o: Pick<ExecCliOptions, "limit" | "only">,
): { fim: ExecFimTask[]; edits: ExecEditTask[] } {
  const match = (id: string): boolean => o.only === undefined || id.includes(o.only);
  const fim = specs.flatMap(fimTasksOf).filter((t) => match(t.id));
  const edits = specs.flatMap(editTasksOf).filter((t) => match(t.id));
  const perKind = <T extends { kind: string }>(ts: T[]): T[] =>
    [...new Set(ts.map((t) => t.kind))].flatMap((k) =>
      spread(
        ts.filter((t) => t.kind === k),
        o.limit,
      ),
    );
  const order = <T extends { id: string }>(ts: T[]): T[] => [...ts].sort((a, b) => a.id.localeCompare(b.id));
  return { fim: order(perKind(fim)), edits: order(perKind(edits)) };
}

async function readSamples(file: string): Promise<ExecSample[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as ExecSample);
}

async function main(): Promise<void> {
  const o = parseExecArgs(process.argv.slice(2));
  const dir = o.resume ?? o.summarize ?? o.out ?? join("bench-runs", `exec-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const file = join(dir, "samples.jsonl");
  const writeSummary = async (all: readonly ExecSample[]): Promise<void> => {
    const s = summarizeExec(all);
    await writeFile(join(dir, "summary.md"), s.markdown);
    await writeFile(join(dir, "summary.json"), JSON.stringify(s.rows, null, 2));
  };
  if (o.summarize !== undefined) {
    // Several runs (one directory for each model, say) are summarised together, into --out if given and else the first.
    const dirs = o.summarize.split(",");
    const all = (await Promise.all(dirs.map((d) => readSamples(join(d, "samples.jsonl"))))).flat();
    const [first = dir] = dirs;
    const into = o.out ?? first;
    await mkdir(into, { recursive: true });
    const s = summarizeExec(all);
    await writeFile(join(into, "summary.md"), s.markdown);
    await writeFile(join(into, "summary.json"), JSON.stringify(s.rows, null, 2));
    console.log(s.markdown);
    return;
  }
  if (o.models.length === 0) throw new Error("give at least one --model NAME=FORMAT");
  const specs = await loadSuite();
  const { fim, edits } = planTasks(specs, o);
  const wantsFim = o.models.some((m) => completionFormat(m.format).kind === "fim");
  const wantsEdit = o.models.some((m) => completionFormat(m.format).kind === "edit");
  const plan0 = { fim: wantsFim ? fim : [], edits: wantsEdit ? edits : [] };
  if (plan0.fim.length + plan0.edits.length === 0) throw new Error("no tasks match");
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
  await writeFile(join(dir, "plan.json"), JSON.stringify({ ...o, fim: plan0.fim.length, edits: plan0.edits.length }, null, 2));
  const done = new Set((await readSamples(file)).map(key));
  const plan: ExecPlan = {
    baseUrl,
    targets: o.models.map((m) => ({ label: m.name, format: m.format, model: nameOf(m.name) })),
    arms: o.arms,
    specs,
    ...plan0,
    maxTokens: o.maxTokens,
    editTokens: o.editTokens,
    timeoutMs: o.timeoutSeconds * 1000,
    filters: o.filters,
  };
  console.error(
    `${dir}: ${plan.fim.length} fill-in tasks, ${plan.edits.length} edit tasks, ${plan.targets.length} models; ${done.size} samples already done`,
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
  await runExecSamples(plan, {
    done,
    onSample: async (s) => {
      await appendFile(file, `${JSON.stringify(s)}\n`);
      console.error(
        `${++n} ${s.target} ${s.arm} ${s.task} ${s.error !== undefined ? "error" : s.unsupported === true ? "no-infill" : s.verdict}`,
      );
    },
  });
  await writeSummary(await readSamples(file));
  console.log(`wrote ${join(dir, "summary.md")}`);
}

if (import.meta.main) await main();
