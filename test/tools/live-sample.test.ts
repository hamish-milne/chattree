import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import type { Completed, ProviderAdapter } from "../../providers/types.ts";
import { blur, formatReport, parseArgs, runSamples, selectTasks } from "../../tools/live-sample.ts";

const usage = { input_tokens: 1, output_tokens: 1 };
const reply = (blocks: Completed["blocks"], stop = "tool_use"): Completed => ({ blocks, stop_reason: stop, usage, observed: { model: "m" }, ext: {} });
const text = (t: string) => reply([{ type: "text", text: t }], "end_turn");
const call = (id: string, name: string, args: unknown) => reply([{ type: "tool_call", call_id: id, name, args: args as never }]);

/** A pretend model: reads, then edits (on every other sample it first mangles the version), answers the read task, ignores the rest. */
function pretendModel(): ProviderAdapter {
  let edits = 0;
  return {
    $tag: "pretend",
    // eslint-disable-next-line require-yield
    async *stream(req: { context: ModelContext }) {
      const c: ModelContext = req.context;
      const prompt = (c.turns[0] as { parts: { text: string }[] }).parts[0]?.text ?? "";
      const results = c.turns.filter((t) => t.role === "tool_results");
      const last = (results.at(-1) as { results: { content: string }[] } | undefined)?.results[0]?.content ?? "";
      const version = /[0-9a-f]{8}/.exec(last)?.[0] ?? "";
      if (prompt.startsWith("In notes.txt change the word draft")) {
        if (results.length === 0) return call("r", "read", { path: "notes.txt" });
        if (results.length === 1) {
          edits++;
          return call("e", "edit", { path: "notes.txt", version: edits % 2 === 0 ? "latest" : `v ${version}`, start: 1, end: 1, content: "status: final" });
        }
        if (results.length === 2 && last.startsWith("failed:")) return call("e2", "edit", { path: "notes.txt", version, start: 1, end: 1, content: "status: final" });
        return text("done");
      }
      if (prompt.startsWith("What is the code word")) return results.length === 0 ? call("r", "read", { path: "a.txt" }) : results.length === 1 ? call("r2", "read", { path: "b.txt" }) : text("WALRUS and 4417");
      return text("I would rather not.");
    },
    retrieve: async () => undefined,
  } as unknown as ProviderAdapter;
}

describe("selecting tasks", () => {
  test("by name part and group; tasks that need a missing program are skipped with the reason", () => {
    assert.deepEqual(selectTasks({ tasks: ["one line", "read two"] }).run.map((t) => t.name), ["one line", "read two files"]);
    assert.ok(selectTasks({ groups: ["edit"] }).run.every((t) => t.group === "edit"));
    const all = selectTasks({ groups: ["run"], busybox: "C:\\bb\\busybox.exe" });
    const without = selectTasks({ groups: ["run"] });
    assert.equal(all.run.length + all.skipped.length, without.run.length + without.skipped.length);
    if (process.platform === "win32") assert.ok(without.skipped.some((t) => t.task === "utility pipe" && /utils/.test(t.why)), "no busybox on Windows: the utility tasks are skipped");
    else assert.ok(without.run.some((t) => t.name === "utility pipe"));
  });
});

describe("blurring errors", () => {
  test("hashes, numbers and long quoted text do not make the same mistake look different", () => {
    assert.equal(blur("edit", "failed: a.txt: a.txt has changed since you read it (you gave 1f08cd1f, it is at ab12cd34 now); read it again\nnothing"), "edit: a.txt has changed since you read it (you gave <hash>, it is at <hash> now); read it again");
    assert.equal(blur("edit", "failed: b.txt: change 2: lines 9-9 are not within the file's 4 lines"), "edit: change #: lines #-# are not within the file's # lines");
  });
});

describe("running samples", () => {
  test("scores outcomes, counts first-try success and tool errors, and reports what the tools said most", async () => {
    const seen: string[] = [];
    const report = await runSamples({ flavor: "anthropic", baseUrl: "x", model: "m", repeat: 4, tasks: ["one line", "read two", "write a new"], adapter: pretendModel(), onSample: (s) => void seen.push(`${s.task}:${s.problem === undefined ? "ok" : "bad"}`) });
    const by = Object.fromEntries(report.stats.map((s) => [s.task, s]));
    assert.equal(by["one line"]?.correct, 4);
    assert.equal(by["one line"]?.firstTry, 2, "two samples hit a stale version first and recovered");
    assert.equal(by["one line"]?.meanErrors, 0.5);
    assert.equal(by["read two files"]?.correct, 4);
    assert.equal(by["write a new file"]?.correct, 0);
    assert.equal(by["write a new file"]?.noTools, 4);
    assert.equal(seen.length, 12);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.count, 2);
    assert.match(report.errors[0]?.message ?? "", /^edit: `version` must be the # hex digits that read shows after "version" \(the file is at <hash> now\)/);
    const text = formatReport(report, { flavor: "anthropic", model: "m", repeat: 4 });
    assert.match(text, /one line\s+4\/4\s+2\/4\s+\d\.\d\s+0\.5\s+0/);
    assert.match(text, /write a new file\s+0\/4/);
    assert.match(text, /wrong outcomes[\s\S]*write a new file: the model made no tool call/);
    assert.match(text, /most common tool errors:\s+2\s+edit: `version` must be/);
  });
});

describe("parseArgs", () => {
  test("flags, repeats, a key from the environment", () => {
    const { options, out, record } = parseArgs(["--flavor", "openai-compatible", "--base-url", "http://x", "--model", "m", "--api-key-env", "K", "--repeat", "20", "--group", "edit", "--task", "one", "--busybox", "bb.exe", "--out", "o.json", "--record", "d"], { K: "s" });
    assert.deepEqual(options, { flavor: "openai-compatible", baseUrl: "http://x", model: "m", apiKey: "s", repeat: 20, tasks: ["one"], groups: ["edit"], busybox: "bb.exe" });
    assert.equal(out, "o.json");
    assert.equal(record, "d");
  });
  test("errors", () => {
    for (const [argv, re] of [[[], /required/], [["--base-url", "u", "--model", "m", "--repeat", "0"], /whole number/], [["--base-url", "u", "--model", "m", "--group", "zz"], /--group/], [["--bogus", "1"], /unknown flag/]] as const) assert.throws(() => parseArgs(argv, {}), re, JSON.stringify(argv));
  });
});
