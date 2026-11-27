/**
 * What a person's typing costs a completion server: the same request is sent again after every few characters, as an editor does, and the
 * tokens the server had to evaluate again (and the time) are recorded for each format. A format that puts the text after the cursor
 * first (seed-coder's order) keeps it cached while the prefix grows; one that puts it last (most) has to evaluate it again each time
 * unless the server reuses chunks that moved (`--cache-reuse`, which shifts them in the KV cache).
 *
 *   node tools/completion-typing.ts --server http://127.0.0.1:8080 --model local=qwen2.5-coder [--model other=seed-coder]
 *       [--task cross-lexer] [--step 3] [--pad 6000] [--cache-reuse 64] [--max-tokens 16] [--out DIR]
 *
 * The typed text is the first span of the task (default `cross-lexer`) from the exec suite, typed from nothing at the span's start; the
 * rest of the file is the suffix, followed by `--pad` characters of the other modules (default 0) to make the file as long as a real one. Run it once without --cache-reuse, then once with, against a server that was started with the same
 * flag (`llama-server --cache-reuse 64`), to see what the flag buys: a row per format, with the tokens evaluated per keystroke.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeRaw, type CompleteOptions } from "../providers/completion/client.ts";
import { completionFormat } from "../providers/completion/formats.ts";
import { fimTasksOf, loadSuite } from "./exec-suite.ts";

export interface TypingStep {
  typed: number;
  /** Evaluated afresh (the server's `prompt_n`). */
  promptTokens: number | undefined;
  cachedTokens: number | undefined;
  totalMs: number;
}

export interface TypingRow {
  target: string;
  format: string;
  steps: number;
  /** Mean prompt length in tokens, and the mean the server evaluated afresh per request after the first. */
  meanPrompt: number;
  meanEvaluated: number;
  /** Share of the prompt tokens that were cached, over all but the first request. */
  cachedShare: number;
  msP50: number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** The server's `prompt_n` is what it evaluated and `cache_n` what it reused, so the prompt's length is the two together. */
export function typingRow(target: string, format: string, steps: readonly TypingStep[]): TypingRow {
  const later = steps.slice(1);
  const evaluated = (s: TypingStep): number => s.promptTokens ?? 0;
  const total = (s: TypingStep): number => evaluated(s) + (s.cachedTokens ?? 0);
  const ms = steps.map((s) => s.totalMs).sort((a, b) => a - b);
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  return {
    target,
    format,
    steps: steps.length,
    meanPrompt: Math.round(mean(steps.map(total))),
    meanEvaluated: Math.round(mean(later.map(evaluated))),
    cachedShare: sum(later.map(total)) === 0 ? 0 : sum(later.map((s) => s.cachedTokens ?? 0)) / sum(later.map(total)),
    msP50: Math.round(ms[Math.floor(ms.length / 2)] ?? 0),
  };
}

export async function typeThrough(
  target: { label: string; format: string; model?: string | undefined },
  task: { path: string; prefix: string; suffix: string; expected: string },
  o: CompleteOptions,
  step: number,
): Promise<TypingStep[]> {
  const format = completionFormat(target.format);
  if (format.kind !== "fim") throw new Error(`${target.format} is not a fill-in-the-middle format`);
  const out: TypingStep[] = [];
  for (let n = 0; n <= task.expected.length; n += step) {
    const rendered = format.render({ path: task.path, prefix: task.prefix + task.expected.slice(0, n), suffix: task.suffix });
    const r = await completeRaw(rendered, o);
    out.push({ typed: n, promptTokens: r.timings.promptTokens, cachedTokens: r.timings.cachedTokens, totalMs: r.timings.totalMs });
  }
  return out;
}

export const typingTable = (rows: readonly TypingRow[]): string =>
  "| model | format | requests | prompt tokens | evaluated per keystroke | cached | ms p50 |\n|---|---|--:|--:|--:|--:|--:|\n" +
  rows
    .map(
      (r) =>
        `| ${r.target} | ${r.format} | ${r.steps} | ${r.meanPrompt} | ${r.meanEvaluated} | ${Math.round(r.cachedShare * 100)}% | ${r.msP50} |`,
    )
    .join("\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const models: { label: string; format: string }[] = [];
  let server = "http://127.0.0.1:8080";
  let taskId = "cross-lexer";
  let step = 3;
  let reuse: number | undefined;
  let maxTokens = 16;
  let pad = 0;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = (): string => {
      const x = args[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === "--server") server = v();
    else if (a === "--model") {
      const s = v();
      const eq = s.lastIndexOf("=");
      if (eq <= 0) throw new Error(`--model needs NAME=FORMAT, got ${s}`);
      models.push({ label: s.slice(0, eq), format: s.slice(eq + 1) });
    } else if (a === "--task") taskId = v();
    else if (a === "--step") step = Number(v());
    else if (a === "--cache-reuse") reuse = Number(v());
    else if (a === "--pad") pad = Number(v());
    else if (a === "--max-tokens") maxTokens = Number(v());
    else if (a === "--out") out = v();
    else throw new Error(`unknown option ${a}`);
  }
  if (models.length === 0) throw new Error("give at least one --model NAME=FORMAT");
  const suite = await loadSuite();
  const spec = suite.find((s) => s.id === taskId);
  const task = spec === undefined ? undefined : fimTasksOf(spec)[0];
  if (task === undefined) throw new Error(`no task ${taskId}`);
  const filler = suite
    .filter((s) => s.id !== taskId)
    .map((s) => s.reference)
    .join("\n")
    .slice(0, pad);
  const padded = { ...task, suffix: filler === "" ? task.suffix : `${task.suffix}\n${filler}` };
  const rows: TypingRow[] = [];
  const all: Record<string, TypingStep[]> = {};
  for (const m of models) {
    const o: CompleteOptions = {
      baseUrl: server,
      model: m.label,
      maxTokens,
      timeoutMs: 120_000,
      ...(reuse === undefined ? {} : { extra: { n_cache_reuse: reuse } }),
    };
    const steps = await typeThrough(m, padded, o, step);
    all[m.label] = steps;
    rows.push(typingRow(m.label, m.format, steps));
  }
  const markdown = `Typing replay of ${taskId}, ${step} characters per request, ${pad} characters of padding${reuse === undefined ? "" : `, n_cache_reuse ${reuse}`}.\n\n${typingTable(rows)}\n`;
  console.log(markdown);
  if (out !== undefined) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "typing.json"), JSON.stringify({ rows, steps: all }, null, 2));
    await writeFile(join(out, "typing.md"), markdown);
  }
}

if (import.meta.main) await main();
