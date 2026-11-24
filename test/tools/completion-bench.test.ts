import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { levenshtein, scoreFim, scoreText } from "../../tools/completion-score.ts";
import { parseArgs, repoFiles, rowFor, runFimSamples, summarize, type RunPlan } from "../../tools/completion-bench.ts";
import { placesIn, planFimTasks, rankContext, rng, type FimTask, type SourceFile } from "../../tools/completion-tasks.ts";
import { tempDir } from "../support/tmp.ts";

const ts = `import { a } from "./a.ts";
import { b } from "./b.ts";

// helpers for the totals
export function total(items: number[], tax: number): number {
  let sum = 0;
  for (const item of items) {
    sum += item * (1 + tax);
  }
  return Math.round(sum * 100) / 100;
}

export const names = ["one", "two", "three"].map((n) => n.toUpperCase());
`;

const py = `import os
import sys
import json

def read_config(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        text = f.read()
    return text.strip()

class Store:
    def __init__(self, root):
        self.root = root
        self.items = {}
`;

const files: SourceFile[] = [
  { path: "src/money.ts", text: ts },
  { path: "src/config.py", text: py },
  { path: "src/other.ts", text: `export function total2(x: number): number {\n  return total(x) + names.length;\n}\n` },
];

describe("tasks", () => {
  test("a task's prefix, answer and suffix make up the file again", () => {
    const tasks = planFimTasks(files, { seed: 3, perKind: 3, prefixChars: 99_999, suffixChars: 99_999 });
    assert.ok(tasks.length >= 3);
    for (const t of tasks) {
      const file = files.find((f) => f.path === t.path);
      assert.equal(t.prefix + t.expected + t.suffix, file?.text, t.id);
      assert.notEqual(t.expected.trim(), "");
    }
  });

  test("the same seed gives the same tasks, and another seed another choice", () => {
    const a = planFimTasks(files, { seed: 7, perKind: 2 }).map((t) => t.id);
    assert.deepEqual(
      planFimTasks(files, { seed: 7, perKind: 2 }).map((t) => t.id),
      a,
    );
    assert.notDeepEqual(
      planFimTasks(files, { seed: 8, perKind: 2 }).map((t) => t.id),
      a,
    );
  });

  test("the three kinds have their shapes", () => {
    const places = placesIn(ts);
    const at = (kind: string) => places.filter((p) => p.kind === kind).map((p) => ts.slice(p.start, p.end));
    assert.ok(at("line").includes("sum += item * (1 + tax);"));
    assert.ok(at("mid-line").some((s) => s.startsWith("items: number[], tax: number)")));
    assert.ok(
      at("block").includes(
        "  let sum = 0;\n  for (const item of items) {\n    sum += item * (1 + tax);\n  }\n  return Math.round(sum * 100) / 100;\n",
      ),
    );
    // Comments are not completed, and the first lines of a file are left to the imports.
    assert.ok(!at("line").some((s) => s.startsWith("//")));
    assert.ok(!at("line").some((s) => s.startsWith("import")));
  });

  test("a python block is the lines indented more than the line before", () => {
    const blocks = placesIn(py)
      .filter((p) => p.kind === "block")
      .map((p) => py.slice(p.start, p.end));
    assert.ok(
      blocks.includes(
        "    if not os.path.exists(path):\n        return default\n    with open(path) as f:\n        text = f.read()\n    return text.strip()\n",
      ),
    );
  });

  test("only the window around the cursor is kept, from the start of a line", () => {
    const t = planFimTasks(files, { seed: 1, perKind: 1, kinds: ["line"], prefixChars: 30, suffixChars: 20 })[0] as FimTask;
    assert.ok(t.prefix.length <= 30);
    assert.ok(t.suffix.length <= 20);
    assert.ok(t.suffix === "" || t.suffix.endsWith("\n"));
  });

  test("context is other files, the same folder and shared names first, the most relevant last", () => {
    const target = files[2] as SourceFile;
    const context = rankContext(target, "return total(x) + names.length;", files, 2, 50);
    assert.ok(context.every((c) => c.path !== target.path));
    assert.equal(context.at(-1)?.path, "src/money.ts", "it names total and names, and is in the same folder");
    assert.ok(context.every((c) => c.text.length <= 50));
  });

  test("the generator is deterministic and within [0, 1)", () => {
    const next = rng(5);
    const xs = Array.from({ length: 50 }, next);
    assert.ok(xs.every((x) => x >= 0 && x < 1));
    const again = rng(5);
    assert.deepEqual(Array.from({ length: 50 }, again), xs);
  });
});

describe("scoring", () => {
  test("edit distance and the scores built on it", () => {
    assert.equal(levenshtein("kitten", "sitting"), 3);
    assert.deepEqual(scoreText("a + b", " a + b\n"), { exact: true, firstLine: true, similarity: 1, empty: false });
    assert.equal(scoreText("a + b", "").empty, true);
    assert.equal(scoreText("a + b", "").similarity, 0);
    const s = scoreText("one\ntwo", "one\nthree");
    assert.equal(s.exact, false);
    assert.equal(s.firstLine, true);
  });

  test("a sample is scored as written and as it would be shown", () => {
    const task: FimTask = { id: "t", path: "p", kind: "line", prefix: "f(", suffix: ")\nnext", expected: "a, b", context: [] };
    const r = scoreFim(task, "a, b)");
    assert.equal(r.raw.exact, false);
    assert.equal(r.filtered.exact, true);
    assert.equal(r.trimmed, true);
    assert.equal(scoreFim(task, "  ").suppressed, true);
  });
});

describe("the run", () => {
  let server: Server;
  let base = "";
  const calls: { path: string; model: unknown; cache: unknown }[] = [];
  let tasks: FimTask[] = [];

  before(async () => {
    tasks = planFimTasks(files, { seed: 2, perKind: 2, prefixChars: 99_999, suffixChars: 99_999 });
    server = createServer((rq, res) => {
      let raw = "";
      rq.on("data", (c: Buffer) => (raw += c.toString()));
      rq.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        calls.push({ path: rq.url ?? "", model: body["model"], cache: body["cache_prompt"] });
        res.setHeader("content-type", "application/json");
        if (rq.url === "/infill" && body["model"] === "no-fim") {
          res.writeHead(501).end(JSON.stringify({ error: { message: "no infill" } }));
          return;
        }
        // The oracle: the answer to whichever task's question is in the request, found by the exact text that Qwen's format or /infill carries.
        const task = tasks.find((t) =>
          rq.url === "/infill"
            ? body["input_prefix"] === t.prefix && body["input_suffix"] === t.suffix
            : String(body["prompt"]).includes(`${t.prefix}<|fim_suffix|>${t.suffix}<|fim_middle|>`),
        );
        res.end(
          JSON.stringify({
            content: body["model"] === "wrong" ? "zzz" : (task?.expected ?? ""),
            stop_type: "eos",
            timings: { prompt_n: 12, cache_n: body["cache_prompt"] === true ? 10 : 0, prompt_ms: 5, predicted_n: 4, predicted_ms: 40 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const plan = (over: Partial<RunPlan>): RunPlan => ({
    baseUrl: base,
    targets: [
      { label: "oracle", format: "qwen2.5-coder", model: "oracle" },
      { label: "seed", format: "seed-coder", model: "no-fim" },
    ],
    arms: ["completion", "infill", "completion+files"],
    tasks,
    warm: true,
    maxTokens: 16,
    timeoutMs: 5000,
    ...over,
  });

  test("every task goes to every target by every arm that applies, cold and then warm", async () => {
    calls.length = 0;
    const samples = await runFimSamples(plan({}));
    const of = (target: string, arm: string) => samples.filter((s) => s.target === target && s.arm === arm);
    assert.equal(of("oracle", "completion").length, tasks.length);
    assert.ok(
      of("oracle", "completion").every((s) => s.raw?.exact === true),
      "the oracle is right through /completion",
    );
    assert.ok(
      of("oracle", "infill").every((s) => s.raw?.exact === true),
      "and through /infill",
    );
    assert.ok(of("oracle", "completion").every((s) => s.cold?.cachedTokens === 0 && s.warm?.cachedTokens === 10));
    // Seed-Coder has no place for other files; its server has no infill tokens.
    assert.equal(of("seed", "completion+files").length, 0);
    assert.ok(of("seed", "infill").every((s) => s.unsupported === true));
    assert.equal(calls.filter((c) => c.path === "/infill" && c.model === "no-fim").length, 1, "once it said 501 it was not asked again");
  });

  test("a wrong answer scores as one, and without --warm there is one request", async () => {
    calls.length = 0;
    const samples = await runFimSamples(
      plan({ targets: [{ label: "bad", format: "mellum", model: "wrong" }], arms: ["completion"], warm: false }),
    );
    assert.ok(samples.every((s) => s.raw?.exact === false && s.warm === undefined));
    assert.equal(calls.length, tasks.length);
    assert.ok(calls.every((c) => c.cache === true));
  });

  test("samples already done are skipped, and each is reported as it finishes", async () => {
    const first = await runFimSamples(
      plan({ arms: ["completion"], targets: [{ label: "oracle", format: "qwen2.5-coder", model: "oracle" }] }),
    );
    const done = new Set(first.slice(0, 2).map((s) => `${s.target}|${s.arm}|${s.task}`));
    const seen: string[] = [];
    const again = await runFimSamples(
      plan({ arms: ["completion"], targets: [{ label: "oracle", format: "qwen2.5-coder", model: "oracle" }] }),
      {
        done,
        onSample: (s) => void seen.push(s.task),
      },
    );
    assert.equal(again.length, first.length - 2);
    assert.deepEqual(
      seen,
      again.map((s) => s.task),
    );
  });

  test("the summary has a row for each model, arm and kind, with rates and times", async () => {
    const samples = await runFimSamples(plan({}));
    const row = rowFor("oracle", "completion", "all", samples);
    assert.equal(row.n, tasks.length);
    assert.equal(row.exact, "100%");
    assert.equal(row.warmMs.includes("/"), true);
    assert.equal(row.tokensPerSecond, "100.0");
    const infill = rowFor("seed", "infill", "all", samples);
    assert.equal(infill.unsupported, tasks.length);
    const s = summarize(samples);
    assert.match(s.markdown, /\| oracle \| completion \| all \|/);
    assert.match(s.markdown, /\| seed \| infill \| all \| 0 \| 0 \| \d+ \|/);
  });
});

describe("the command", () => {
  test("options", () => {
    const o = parseArgs([
      "--model",
      "a=qwen2.5-coder",
      "--model",
      "b/c=mellum",
      "--arms",
      "completion,infill",
      "--per-kind",
      "4",
      "--no-warm",
      "--server",
      "http://x",
    ]);
    assert.deepEqual(o.models, [
      { name: "a", format: "qwen2.5-coder" },
      { name: "b/c", format: "mellum" },
    ]);
    assert.deepEqual(o.arms, ["completion", "infill"]);
    assert.equal(o.perKind, 4);
    assert.equal(o.warm, false);
    assert.equal(o.server, "http://x");
    assert.throws(() => parseArgs(["--model", "a=nope"]), /unknown completion format/);
    assert.throws(() => parseArgs(["--model", "a"]), /NAME=FORMAT/);
    assert.throws(() => parseArgs(["--arms", "x"]), /unknown arm/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
  });

  test("the files of a repository are the tracked source files of a usable size, in order", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    const big = "const x = 1;\n".repeat(60);
    await writeFile(join(dir, "src", "b.ts"), big);
    await writeFile(join(dir, "src", "a.ts"), big);
    await writeFile(join(dir, "src", "tiny.ts"), "x");
    await writeFile(join(dir, "src", "notes.md"), big);
    await writeFile(join(dir, "node_modules", "dep.ts"), big);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A", "-f"], { cwd: dir });
    const found = await repoFiles(dir, ["ts"], 10);
    assert.deepEqual(
      found.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
  });
});
