import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import { ProviderError, type Completed, type ProviderAdapter } from "../../providers/types.ts";
import { armsFor, clean, formatSummary, guessDialect, parseArgs, runOne, summarize, type BenchSample } from "../../tools/dialect-bench.ts";
import { TASKS } from "../../tools/tasks.ts";

const usage = { input_tokens: 10, cache_read_tokens: 40, output_tokens: 7 };
const reply = (blocks: Completed["blocks"], stop = "tool_use"): Completed => ({ blocks, stop_reason: stop, usage, observed: { model: "m@1" }, ext: {} });

/** Answers the code-word task right, wrongly, or with a failed request. */
function model(how: "right" | "no-tools" | "fails"): ProviderAdapter {
  return {
    $tag: "pretend",
    // eslint-disable-next-line require-yield
    async *stream(req: { context: ModelContext }) {
      if (how === "fails") throw new ProviderError({ kind: "server", message: "does not match the expected peg-native format", cause: new Error("inner") });
      if (how === "no-tools") return reply([{ type: "text", text: "no" }], "end_turn");
      const n = req.context.turns.filter((t) => t.role === "tool_results").length;
      return n === 0 ? reply([{ type: "tool_call", call_id: "a", name: "read", args: { path: "a.txt" } }]) : n === 1 ? reply([{ type: "tool_call", call_id: "b", name: "read", args: { path: "b.txt" } }]) : reply([{ type: "text", text: "WALRUS and 4417" }], "end_turn");
    },
  } as unknown as ProviderAdapter;
}

const task = TASKS.find((t) => t.name === "read two files")!;
const base = { sampling: { temperature: 0.5 }, settings: {}, maxTokens: 100, timeoutSeconds: 30, model: "m", arm: { label: "a", settings: { dialect: "harmony" } } };

describe("one benchmark sample", () => {
  test("a clean sample keeps its numbers and nothing else", async () => {
    const s = await runOne({ ...base, adapter: model("right") }, task, 1);
    assert.equal(s.ok, true);
    assert.equal(clean(s), true);
    assert.equal(s.requests, 3);
    assert.deepEqual(s.tokens, { in: 150, cached: 120, out: 21 });
    assert.equal(s.detail, undefined);
  });
  test("a wrong sample keeps the steps, the answer and what each request did", async () => {
    const s = await runOne({ ...base, adapter: model("no-tools") }, task, 2);
    assert.equal(s.ok, false);
    assert.equal(s.noTools, true);
    assert.equal(s.detail?.requests[0]?.stop_reason, "end_turn");
    assert.equal(s.detail?.answer, "no");
    assert.equal(s.detail?.settings["dialect"], "harmony");
    assert.equal(s.detail?.settings["temperature"], 0.5);
  });
  test("a failed request keeps the error with its kind and cause", async () => {
    const s = await runOne({ ...base, adapter: model("fails") }, task, 3);
    assert.match(s.status, /^error: /);
    const e = s.detail?.requests[0]?.error;
    assert.equal(e?.kind, "server");
    assert.match(e?.message ?? "", /peg-native/);
    assert.match(e?.cause ?? "", /inner/);
  });
});

describe("arms, arguments and the summary", () => {
  test("arms and dialect guesses", () => {
    assert.deepEqual(armsFor("harmony", ["jinja+replay", "dialect-no-reasoning"], []).map((a) => a.settings), [{ replay_reasoning: true }, { dialect: "harmony", dialect_options: { keep_reasoning: false } }]);
    assert.throws(() => armsFor(undefined, ["dialect"], []), /NAME=DIALECT/);
    assert.deepEqual(["gpt-oss-20b", "Qwen3.5-9B", "gemma4-12b", "llama"].map(guessDialect), ["harmony", "qwen-xml", "gemma", undefined]);
  });
  test("arguments", () => {
    const o = parseArgs(["--model", "gpt-oss-20b", "--model", "x=gemma", "--arms", "jinja,dialect", "--arm", 'mine={"dialect":"harmony","dialect_options":{"schema":"flat"}}', "--setting", "reasoning_effort=low", "--repeat", "3", "--yes"]);
    assert.deepEqual(o.models, [{ name: "gpt-oss-20b", dialect: "harmony" }, { name: "x", dialect: "gemma" }]);
    assert.deepEqual(o.arms, ["jinja", "dialect"]);
    assert.deepEqual(o.custom, [{ label: "mine", settings: { dialect: "harmony", dialect_options: { schema: "flat" } } }]);
    assert.deepEqual([o.settings, o.repeat, o.yes], [{ reasoning_effort: "low" }, 3, true]);
    assert.throws(() => parseArgs([]), /--model is required/);
    assert.throws(() => parseArgs(["--model", "a", "--nope", "1"]), /unknown flag/);
  });
  test("the summary counts, averages and tallies the errors, per model and arm", () => {
    const mk = (arm: string, n: number, ok: boolean, ms: number, extra: Partial<BenchSample> = {}): BenchSample => ({ model: "m", arm, task: "t", group: "edit", n, ok, firstTry: ok, status: "completed", noTools: false, ms, requests: 4, toolErrors: 0, tokens: { in: 100, cached: 60, out: 10 }, ...extra });
    const failed = mk("jinja", 3, false, 6000, { status: "error: x", detail: { steps: [{ name: "edit", args: {}, result: "failed: a: stale version 1f08cd1f", is_error: true }], answer: "", wire: [], settings: {}, requests: [{ error: { name: "ProviderError", kind: "server", message: "peg-native" } }] } });
    const sum = summarize([mk("jinja", 1, true, 2000), mk("jinja", 2, true, 4000), failed, mk("dialect", 1, true, 1000)]);
    const j = sum.find((s) => s.arm === "jinja")!;
    assert.deepEqual([j.samples, j.correct, j.firstTry, j.endedBadly, j.meanSeconds, j.meanOut], [3, 2, 2, 1, 4, 10]);
    assert.deepEqual(j.requestErrors, [{ count: 1, message: "server: peg-native" }]);
    assert.deepEqual(j.toolErrors, [{ count: 1, message: "edit: stale version <hash>" }]);
    const md = formatSummary(sum, { when: "now", repeat: 3 });
    assert.match(md, /\| jinja \| 2\/3 \(67%\)/);
    assert.match(md, /Failed requests, jinja/);
  });
});
