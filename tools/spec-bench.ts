/**
 * Does speculative decoding change what a model says, and how much faster is it? (docs/local-models.md, 9.8.) Every model named runs
 * the same requests at temperature 0 (a copy of code with one change, a tool call that writes a file, plain prose as the control), and
 * the first is the baseline the others are compared with: with speculation the text and the calls should be the same, and only the
 * time and the server's counts of drafted and accepted tokens should differ. Make the arms as entries of `local_models` that share one
 * file and differ in `speculative`:
 *
 *   node tools/spec-bench.ts --model devstral --model devstral-ngram-mod [--repeat 3] [--dialect mistral] [--max-tokens 1024] [--out DIR] [--yes]
 *
 * --dialect NAME applies to every arm (the chat endpoint's template when it is not given). Output (bench-runs/spec-<time>/): spec.json,
 * spec.md, with a table of time, speed, drafts and agreement with the baseline for each arm and task, and the first difference of each
 * answer that is not the baseline's.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeIo } from "../cli/io.ts";
import { ensureLocalModels } from "../cli/models.ts";
import { lookupSampling } from "../cli/providers.ts";
import { loadSettings } from "../cli/settings.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../harness/setup.ts";
import { samplingSettings } from "../localmodels/catalog.ts";
import { collectStream } from "../providers/conformance.ts";
import { localModelsAdapter } from "./local-adapter.ts";

const CODE = `import json
import sys


def load_records(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def total_by_name(records):
    totals = {}
    for r in records:
        name = r["name"]
        totals[name] = totals.get(name, 0) + r["amount"]
    return totals


def format_totals(totals):
    lines = []
    for name in sorted(totals):
        lines.append(f"{name}: {totals[name]}")
    return "\\n".join(lines)


def main():
    records = load_records(sys.argv[1])
    print(format_totals(total_by_name(records)))


if __name__ == "__main__":
    main()
`;

interface Task {
  name: string;
  context: ModelContext;
  /** How many tool calls the task is meant to end in: an arm with fewer has failed, whatever the baseline did. */
  calls?: number;
}
const ctx = (text: string, tools: ModelContext["tools"] = []): ModelContext => ({ system: "You are terse. Follow instructions exactly.", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text }] }], tools, cacheHints: [] });
const WRITE: ModelContext["tools"] = [{ name: "write", description: "Write a file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }];
const TASKS: Task[] = [
  { name: "copy", context: ctx(`Here is a Python file:\n\n${CODE}\nWrite it out again in full, with the function total_by_name renamed to sum_by_name everywhere. Output only the code.`) },
  { name: "call", calls: 1, context: ctx(`Create the file util.py with exactly this content, using the write tool:\n\n${CODE}`, WRITE) },
  {
    // An earlier call is in the context, so a draft can copy its special tokens (a call marker inside a chunk of several tokens).
    name: "followup",
    calls: 1,
    context: {
      ...ctx(`Create the file util.py with exactly this content, using the write tool:\n\n${CODE}`, WRITE),
      turns: [
        { role: "user", parts: [{ type: "text", text: `Create the file util.py with exactly this content, using the write tool:\n\n${CODE}` }] },
        { role: "assistant", provider: "local-models", model: "bench", blocks: [{ type: "tool_call", call_id: "c1", name: "write", args: { path: "util.py", content: CODE } }] },
        { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "wrote util.py", truncated: false }] },
        { role: "user", parts: [{ type: "text", text: "Now create util2.py with the same content, using the write tool again." }] },
      ],
    },
  },
  {
    // Two calls in one turn are in the history, so after the first call of the new turn a draft can copy the marker that opens the second.
    name: "parallel",
    calls: 2,
    context: {
      ...ctx("x", WRITE),
      turns: [
        { role: "user", parts: [{ type: "text", text: `Create util.py with exactly this content and notes.txt containing "todo: tests", using the write tool for both in one turn:\n\n${CODE}` }] },
        { role: "assistant", provider: "local-models", model: "bench", blocks: [{ type: "tool_call", call_id: "c1", name: "write", args: { path: "util.py", content: CODE } }, { type: "tool_call", call_id: "c2", name: "write", args: { path: "notes.txt", content: "todo: tests" } }] },
        { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "wrote util.py", truncated: false }, { call_id: "c2", is_error: false, content: "wrote notes.txt", truncated: false }] },
        { role: "user", parts: [{ type: "text", text: 'Do the same again for util2.py (the same content) and notes2.txt (containing "todo: docs"): both writes together, in one turn.' }] },
      ],
    },
  },
  { name: "prose", context: ctx("Describe, in about 120 words, what a lighthouse keeper does on an ordinary day.") },
];

interface Sample {
  model: string;
  task: string;
  /** How many calls the task is meant to end in. */
  calls_expected?: number;
  n: number;
  ms: number;
  output_tokens: number;
  drafted: number | undefined;
  accepted: number | undefined;
  /** The text and the calls, as one string to compare. */
  result: string;
  calls: number;
  error?: string;
}

const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

function args(argv: readonly string[]) {
  const all = (f: string): string[] => argv.flatMap((a, i) => (a === f ? [argv[i + 1] as string] : []));
  const v = (f: string): string | undefined => all(f)[0];
  const models = all("--model");
  if (models.length < 2) throw new Error("--model is needed at least twice: the baseline first, then the arms with speculation");
  return { models, repeat: Number(v("--repeat") ?? 3), dialect: v("--dialect"), maxTokens: Number(v("--max-tokens") ?? 1024), out: v("--out"), yes: argv.includes("--yes") };
}

const firstDifference = (a: string, b: string): string => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `at character ${i}: baseline ${JSON.stringify(a.slice(Math.max(0, i - 10), i + 30))}, arm ${JSON.stringify(b.slice(Math.max(0, i - 10), i + 30))}`;
};

export function report(samples: readonly Sample[], models: readonly string[]): string {
  const lines = ["| task | model | ms | tokens/s | drafted | accepted | same as baseline | calls | errors |", "|---|---|---|---|---|---|---|---|---|"];
  const notes: string[] = [];
  for (const task of [...new Set(samples.map((s) => s.task))]) {
    for (const m of models) {
      const rs = samples.filter((s) => s.task === task && s.model === m);
      const ok = rs.filter((s) => s.error === undefined);
      const base = samples.filter((s) => s.task === task && s.model === models[0] && s.error === undefined);
      const ms = ok.reduce((n, s) => n + s.ms, 0);
      const tok = ok.reduce((n, s) => n + s.output_tokens, 0);
      const d = ok.flatMap((s) => (s.drafted === undefined ? [] : [s.drafted]));
      const a = ok.flatMap((s) => (s.accepted === undefined ? [] : [s.accepted]));
      const same = ok.filter((s) => base.some((b) => b.result === s.result)).length;
      const dsum = d.reduce((x, y) => x + y, 0);
      const asum = a.reduce((x, y) => x + y, 0);
      lines.push(`| ${task} | ${m} | ${ok.length === 0 ? "-" : Math.round(ms / ok.length)} | ${ms === 0 ? "-" : ((tok / ms) * 1000).toFixed(1)} | ${d.length === 0 ? "n/a" : dsum} | ${a.length === 0 ? "n/a" : `${asum}${dsum > 0 ? ` (${Math.round((asum / dsum) * 100)}%)` : ""}`} | ${m === models[0] ? "-" : `${same}/${ok.length}`} | ${ok.filter((s) => s.calls > 0).length}/${ok.length} | ${rs.length - ok.length} |`);
      if (m !== models[0]) for (const s of ok) if (!base.some((b) => b.result === s.result) && base[0] !== undefined) notes.push(`- ${task} ${m} #${s.n}: ${firstDifference(base[0].result, s.result)}`);
      for (const s of rs) if (s.error !== undefined) notes.push(`- ${task} ${m} #${s.n}: error: ${s.error}`);
    }
  }
  const missed = samples.filter((s) => s.calls_expected !== undefined && s.error === undefined && s.calls < s.calls_expected);
  const warn = [...new Set(missed.map((s) => `${s.task} ${s.model}`))].map((k) => `**${k}: fewer tool calls than expected in ${missed.filter((s) => `${s.task} ${s.model}` === k).length} of its runs, so this task shows nothing about calls it was meant to make**`);
  const head = warn.length === 0 ? "" : `${warn.join("\n")}\n\n`;
  return `${head}${notes.length === 0 ? lines.join("\n") : `${lines.join("\n")}\n\nNotes:\n\n${notes.join("\n")}`}`;
}

async function main(): Promise<void> {
  const o = args(process.argv.slice(2));
  const io = nodeIo();
  io.settings = await loadSettings(io);
  await ensureLocalModels(io, { yes: o.yes });
  const adapter = localModelsAdapter(io);
  const setups = new Map<string, AgentSetup>();
  for (const name of o.models) {
    const sampling = samplingSettings((await lookupSampling(io, name)).values) as Record<string, unknown>;
    const settings = { max_output_tokens: o.maxTokens, ...sampling, temperature: 0, ...(o.dialect === undefined ? {} : { dialect: o.dialect }) };
    setups.set(name, { ...emptySetup(), model: { provider: "live", id: name, settings } as NonNullable<AgentSetup["model"]> });
  }
  const samples: Sample[] = [];
  for (const task of TASKS) {
    for (let n = 1; n <= o.repeat; n++) {
      for (const model of o.models) {
        const t0 = Date.now();
        const run = await collectStream(adapter.stream({ context: task.context, setup: setups.get(model) as AgentSetup, signal: AbortSignal.timeout(600_000) }));
        const blocks = run.completed?.blocks ?? [];
        const raw = run.completed?.usage.raw as Record<string, unknown> | undefined;
        const timings = (raw?.["timings"] ?? {}) as Record<string, unknown>;
        const s: Sample = {
          model, task: task.name, ...(task.calls === undefined ? {} : { calls_expected: task.calls }), n, ms: Date.now() - t0,
          output_tokens: run.completed?.usage.output_tokens ?? 0,
          drafted: num(timings["draft_n"]), accepted: num(timings["draft_n_accepted"]),
          result: blocks.flatMap((b) => (b.type === "text" ? [b.text] : b.type === "tool_call" ? [`CALL ${b.name} ${JSON.stringify(b.args)}`] : [])).join("\n"),
          calls: blocks.filter((b) => b.type === "tool_call").length,
          ...(run.error === undefined ? {} : { error: run.error instanceof Error ? run.error.message : String(run.error) }),
        };
        samples.push(s);
        console.error(`${task.name} #${n} ${model}: ${s.error ?? `${s.ms} ms, ${s.output_tokens} tokens, drafted ${s.drafted ?? "?"}, accepted ${s.accepted ?? "?"}, calls ${s.calls}`}`);
      }
    }
  }
  const text = report(samples, o.models);
  const dir = o.out ?? join("bench-runs", `spec-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec.json"), JSON.stringify(samples, null, 2));
  await writeFile(join(dir, "spec.md"), text);
  console.log(text);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
