import type { Block } from "../harness/context-builder.ts";
import { ProviderError, type Completed, type ModelStream, type StreamEvent } from "./types.ts";

/**
 * The checks every adapter's stream must pass (docs/writing-an-adapter.md). Independent of any test runner:
 * `collectStream` runs a stream to its end, `conformanceProblems` returns what is wrong with what happened.
 * An adapter's tests run both over each of their fixtures.
 */

export interface StreamRun {
  events: StreamEvent[];
  /** Set when the stream returned. */
  completed?: Completed;
  /** Set when the stream threw. */
  error?: unknown;
}

export async function collectStream(stream: ModelStream): Promise<StreamRun> {
  const run: StreamRun = { events: [] };
  try {
    for (;;) {
      const r = await stream.next();
      if (r.done === true) {
        run.completed = r.value;
        break;
      }
      run.events.push(r.value);
    }
  } catch (e) {
    run.error = e;
  }
  return run;
}

export interface ConformanceOptions {
  /** Secret values that must not appear anywhere in what the stream produced. */
  secrets?: readonly string[];
}

export function conformanceProblems(run: StreamRun, opts: ConformanceOptions = {}): string[] {
  const out: string[] = [];
  const ev = run.events;

  // Exactly one terminal state.
  if (run.completed === undefined && run.error === undefined) out.push("the stream neither returned nor threw");
  if (run.completed !== undefined && run.error !== undefined) out.push("the stream both returned and threw");
  if (run.error !== undefined && !(run.error instanceof ProviderError)) out.push(`the stream threw something that is not a ProviderError: ${String(run.error)}`);

  // `started` is first when present, and only once.
  const started = ev.map((e, i) => (e.type === "started" ? i : -1)).filter((i) => i >= 0);
  if (started.length > 1) out.push("`started` appears more than once");
  if (started.length === 1 && started[0] !== 0) out.push("`started` is not the first event");

  // Usage never decreases.
  let last: { input_tokens: number; output_tokens: number } | undefined;
  for (const e of ev) {
    if (e.type !== "usage") continue;
    if (last !== undefined && (e.usage.input_tokens < last.input_tokens || e.usage.output_tokens < last.output_tokens)) out.push("usage decreased");
    last = e.usage;
  }

  // Blocks: what block.done says matches the deltas that led to it; the result matches block.done.
  const text = new Map<number, string>();
  const reasoning = new Map<number, string>();
  const args = new Map<number, string>();
  const done = new Map<number, Block>();
  for (const e of ev) {
    if (e.type === "text.delta") text.set(e.index, (text.get(e.index) ?? "") + e.text);
    else if (e.type === "reasoning.delta") reasoning.set(e.index, (reasoning.get(e.index) ?? "") + e.text);
    else if (e.type === "tool_call.delta") args.set(e.index, (args.get(e.index) ?? "") + e.args_delta);
    else if (e.type === "block.done") {
      if (done.has(e.index)) out.push(`block ${e.index} is completed twice`);
      done.set(e.index, e.block);
    }
  }
  for (const [i, b] of done) {
    if (b.type === "text" && text.has(i) && text.get(i) !== b.text) out.push(`block ${i}: text deltas do not add up to the block`);
    if (b.type === "reasoning" && reasoning.has(i) && b.visible !== undefined && reasoning.get(i) !== b.visible) out.push(`block ${i}: reasoning deltas do not add up to the block`);
    if (b.type === "tool_call" && args.has(i)) {
      const raw = args.get(i) as string;
      try {
        if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(b.args)) out.push(`block ${i}: argument deltas do not parse to the block's arguments`);
      } catch {
        if (b.args_raw !== raw) out.push(`block ${i}: arguments were not valid JSON but args_raw is not the original text`);
      }
    }
  }
  const ordered = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  if (run.completed !== undefined) {
    if (JSON.stringify(run.completed.blocks) !== JSON.stringify(ordered)) out.push("the returned blocks are not the blocks completed in the stream, in order");
    if (run.completed.stop_reason === "") out.push("stop_reason is empty");
    if (!Number.isFinite(run.completed.usage.input_tokens) || !Number.isFinite(run.completed.usage.output_tokens)) out.push("the returned usage has no token counts");
    if (last !== undefined && (run.completed.usage.input_tokens < last.input_tokens || run.completed.usage.output_tokens < last.output_tokens)) out.push("the returned usage is lower than the last usage event");
  }
  if (run.error instanceof ProviderError) {
    const partial = JSON.stringify(run.error.partial);
    if (partial !== JSON.stringify(ordered)) out.push("the error's partial blocks are not the blocks completed before it");
  }

  // Secrets never leave the adapter.
  const everything = JSON.stringify([ev, run.completed]) + (run.error instanceof Error ? `${run.error.message}${JSON.stringify((run.error as ProviderError).partial ?? [])}` : "");
  for (const s of opts.secrets ?? []) if (s.length > 0 && everything.includes(s)) out.push("a secret appears in the stream's output");
  return out;
}
