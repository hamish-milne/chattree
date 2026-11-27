import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { sweepNextEdit, zeta21 } from "../../providers/completion/index.ts";
import { execRowFor, parseExecArgs, planTasks, runExecSamples, spread, summarizeExec, type ExecPlan } from "../../tools/exec-bench.ts";
import {
  applyLines,
  editTasksOf,
  fimTasksOf,
  grade,
  loadSuite,
  parseHoles,
  parseSpec,
  recentChangeOf,
  referenceOutcome,
  runTests,
  withFill,
  type Spec,
} from "../../tools/exec-suite.ts";

import { tempDir } from "../support/tmp.ts";

const run = promisify(execFile);
let suite: Spec[] = [];
before(async () => {
  suite = await loadSuite();
});

/** Run `fn` over the items a few at a time: each check starts a process. */
async function each<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += 6) await Promise.all(items.slice(i, i + 6).map(fn));
}

describe("the suite", () => {
  test("markers come out of the text and leave the spans noted", () => {
    const { reference, holes } = parseHoles("a ⟦bb⟧ c ⟦d⟧");
    assert.equal(reference, "a bb c d");
    assert.deepEqual(
      holes.map((h) => reference.slice(h.start, h.end)),
      ["bb", "d"],
    );
    assert.throws(() => parseHoles("a ⟦b"), /not closed/);
  });

  test("a file has its header read, and the header is not part of the module", () => {
    const s = parseSpec(
      "x",
      "//! entry f\n//! tests [[1]]\n//! rename a b\n//! change a ==> b\\nc\n//! follow d ==> e\nfunction f(a) { return ⟦a⟧; }",
    );
    assert.equal(s.entry, "f");
    assert.equal(s.reference, "function f(a) { return a; }");
    assert.deepEqual(s.renames, [["a", "b"]]);
    assert.deepEqual(s.change, [["a", "b\nc"]]);
    assert.throws(() => parseSpec("y", "function f() {}"), /no entry/);
  });

  test("there are dozens of modules, and every reference runs and gives an output for every test", async () => {
    assert.ok(suite.length >= 30);
    await each(suite, async (s) => {
      const o = await referenceOutcome(s);
      assert.equal(o.kind, "ok", s.id);
      assert.ok(
        o.kind === "ok" &&
          o.results.length >= 3 &&
          o.results.every((r) => !r.startsWith("throws") || s.id === "rpn" || s.id === "chunk" || s.id === "tokenize"),
        s.id,
      );
    });
    assert.equal(new Set(suite.map((s) => s.id)).size, suite.length);
  });

  test("every span makes a task whose original text works, and which does not work with the span left empty", async () => {
    const tasks = suite.flatMap((s) => fimTasksOf(s).map((t) => ({ s, t })));
    assert.ok(tasks.length >= 50);
    assert.deepEqual(new Set(tasks.map(({ t }) => t.kind)), new Set(["line", "mid-line", "block"]));
    await each(tasks, async ({ s, t }) => {
      assert.equal(await grade(s, withFill(s, t, t.expected)), "pass", t.id);
      assert.notEqual(await grade(s, withFill(s, t, "")), "pass", `${t.id}: the tests do not need the span`);
    });
  });

  test("every edit task is broken as the person left it, works when finished, and the change reaches no further than the block", async () => {
    const tasks = suite.flatMap((s) => editTasksOf(s).map((t) => ({ s, t })));
    assert.ok(tasks.length >= 30);
    assert.deepEqual(new Set(tasks.map(({ t }) => t.kind)), new Set(["rename", "call-site"]));
    await each(tasks, async ({ s, t }) => {
      assert.equal(await grade(s, t.after), "pass", t.id);
      assert.notEqual(await grade(s, t.stale), "pass", `${t.id}: the half-made change should not work`);
      assert.ok(t.linesAfter >= 10 && t.linesAfter <= 25, `${t.id}: ${t.linesAfter}`);
      assert.ok(t.cursor > 0 && t.cursor <= t.stale.length);
    });
  });

  test("a rename is made at the first use outside the comments, and the cursor is after it", () => {
    const s = suite.find((x) => x.id === "clamp") as Spec;
    const t = editTasksOf(s).find((x) => x.id === "clamp/rename-n") as ReturnType<typeof editTasksOf>[number];
    assert.match(t.stale, /function clamp\(value, lo, hi\)/);
    assert.match(t.stale, /if \(n < lo\)/);
    assert.match(t.after, /if \(value < lo\) return lo;/);
    assert.match(t.stale, /Restrict n to/, "comments are left as they are");
    assert.equal(t.stale.slice(0, t.cursor).endsWith("function clamp(value"), true);
    assert.deepEqual(t.recent, {
      path: "clamp.js",
      start: 2,
      end: 2,
      original: "function clamp(n, lo, hi) {",
      updated: "function clamp(value, lo, hi) {",
    });
  });

  test("an edit written by hand shows the lines that changed, which can be several", () => {
    const s = suite.find((x) => x.id === "sentence") as Spec;
    const [t] = editTasksOf(s);
    assert.equal(t?.kind, "call-site");
    assert.equal(t?.recent.start, 2);
    assert.equal(t?.recent.end, 3);
    assert.match(t?.recent.original ?? "", /words\.join\(" "\)/);
    assert.deepEqual(recentChangeOf("p", "a\nb\nc", "a\nB\nc"), { path: "p", start: 2, end: 2, original: "b", updated: "B" });
    assert.throws(() => editTasksOf({ ...s, change: [["not there", "x"]] }), /exactly once/);
  });

  test("lines are replaced by the lines the model wrote, with or without a closing newline", () => {
    assert.equal(applyLines("a\nb\nc\nd", 1, 3, "X\nY\n"), "a\nX\nY\nd");
    assert.equal(applyLines("a\nb\nc\nd", 1, 3, "X\nY"), "a\nX\nY\nd");
    assert.equal(applyLines("a\nb\nc", 1, 2, ""), "a\nc");
  });
});

describe("running the code", () => {
  const echo = "function f(x) { return x * 2; }";
  test("outputs come back as JSON, a throw as its name, and nothing as undefined", async () => {
    const o = await runTests(
      "function f(x) { if (x < 0) throw new RangeError('no'); if (x === 0) return; return { v: x }; }",
      "f",
      "[[1],[0],[-1]]",
    );
    assert.deepEqual(o, { kind: "ok", results: ['{"v":1}', "undefined", "throws RangeError"] });
  });

  test("a module that does not parse, loops for ever or gives other outputs is told apart", async () => {
    const spec = parseSpec("t", `//! entry f\n//! tests [[1],[2]]\n${echo}`);
    assert.equal(await grade(spec, echo), "pass");
    assert.equal(await grade(spec, "function f(x) { return x * 3; }"), "wrong");
    assert.equal(await grade(spec, "function f(x) { return x * ; }"), "syntax");
    assert.equal(await grade(spec, "function f(x) { while (true) {} }"), "timeout");
    assert.equal(await grade(spec, "function f(x) { throw new Error('x'); }"), "wrong");
  });

  test("the code has the language's own objects and nothing of the machine", async () => {
    const o = await runTests(
      "function f() { return [typeof process, typeof require, typeof fetch, typeof globalThis.constructor, typeof Math, typeof Map]; }",
      "f",
      "[[]]",
    );
    assert.deepEqual(o, { kind: "ok", results: ['["undefined","undefined","undefined","function","object","function"]'] });
  });
});

describe("the run", () => {
  let server: Server;
  let base = "";
  const asked: string[] = [];
  let plan: ExecPlan;

  before(async () => {
    const specs = suite.filter((s) => ["clamp", "gcd", "sentence"].includes(s.id));
    const fimTasks = specs.flatMap(fimTasksOf);
    const edits = specs.flatMap(editTasksOf);
    server = createServer((rq, res) => {
      let raw = "";
      rq.on("data", (c: Buffer) => (raw += c.toString()));
      rq.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        asked.push(`${rq.url ?? ""} ${String(body["model"])}`);
        res.setHeader("content-type", "application/json");
        if (rq.url === "/infill" && body["model"] === "no-fim") {
          res.writeHead(501).end(JSON.stringify({ error: { message: "no infill" } }));
          return;
        }
        let content = "";
        if (body["model"] !== "silent") {
          const prompt = String(body["prompt"] ?? "");
          const task = fimTasks.find((t) =>
            rq.url === "/infill"
              ? body["input_prefix"] === t.prefix && body["input_suffix"] === t.suffix
              : prompt.includes(`${t.prefix}<|fim_suffix|>${t.suffix}<|fim_middle|>`),
          );
          const small = edits.find((t) => prompt.endsWith(`<|file_sep|>current/${t.path}\n${t.stale}\n<|file_sep|>updated/${t.path}`));
          const edit = edits.find((t) => prompt.includes(`<|file_sep|>updated/${t.path}:`) && prompt.includes(t.recent.updated));
          const zeta = prompt.includes("<|marker_1|>") ? edits.find((t) => prompt.includes(`<filename>${t.path}\n`)) : undefined;
          if (zeta !== undefined) {
            const r = zeta21.render({
              path: zeta.path,
              text: zeta.stale,
              cursor: zeta.cursor,
              recentChanges: [zeta.recent],
              linesAfter: zeta.linesAfter,
            });
            const region = zeta.after.split("\n").slice(r.block.startLine, r.block.endLine).join("\n");
            content = `<|marker_1|>${region}<|marker_${r.markers?.length ?? 0}|>`;
          }
          if (small !== undefined) content = `\n${small.after}`;
          if (task !== undefined) content = body["model"] === "wrong" ? "zzz" : task.expected;
          else if (edit !== undefined) {
            const r = sweepNextEdit.render({
              path: edit.path,
              text: edit.stale,
              cursor: edit.cursor,
              recentChanges: [edit.recent],
              linesAfter: edit.linesAfter,
            });
            content = edit.after.split("\n").slice(r.block.startLine, r.block.endLine).join("\n").slice(r.prefill.length);
          }
        }
        res.end(JSON.stringify({ content, stop_type: "eos", timings: { prompt_n: 12, predicted_n: 4, predicted_ms: 40, prompt_ms: 5 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    plan = {
      baseUrl: base,
      targets: [
        { label: "oracle", format: "qwen2.5-coder", model: "oracle" },
        { label: "seed", format: "seed-coder", model: "no-fim" },
        { label: "sweep", format: "sweep-next-edit", model: "oracle" },
        { label: "small", format: "sweep-next-edit-1.5b", model: "oracle" },
        { label: "zeta", format: "zeta-2.1", model: "oracle" },
      ],
      arms: ["completion", "infill"],
      specs,
      fim: fimTasks,
      edits,
      maxTokens: 64,
      editTokens: 256,
      timeoutMs: 5000,
      filters: true,
    };
  });
  after(() => server.close());

  test("fill-in-the-middle formats get the fill-in tasks by each arm and the next-edit format gets the edits", async () => {
    asked.length = 0;
    const samples = await runExecSamples(plan);
    const of = (t: string, a: string) => samples.filter((s) => s.target === t && s.arm === a);
    assert.equal(of("oracle", "completion").length, plan.fim.length);
    assert.ok(of("oracle", "completion").every((s) => s.verdict === "pass" && s.exact === true && s.shownVerdict === "pass"));
    assert.ok(of("oracle", "infill").every((s) => s.verdict === "pass"));
    assert.ok(
      of("seed", "completion").every((s) => s.verdict !== undefined && s.verdict !== "pass"),
      "the server only knows Qwen's sentinels, so it answers nothing to another format's prompt",
    );
    assert.ok(of("seed", "infill").every((s) => s.unsupported === true));
    assert.equal(asked.filter((a) => a === "/infill no-fim").length, 1, "the server is asked once, then the target is known to have none");
    assert.equal(of("sweep", "edit").length, plan.edits.length);
    assert.ok(
      of("sweep", "edit").every((s) => s.verdict === "pass" && s.kind !== undefined),
      JSON.stringify(
        of("sweep", "edit")
          .filter((s) => s.verdict !== "pass")
          .map((s) => [s.task, s.verdict, s.text]),
      ),
    );
    assert.equal(samples.filter((s) => s.target === "sweep" && s.arm !== "edit").length, 0);
    assert.equal(of("small", "edit").length, plan.edits.length);
    assert.ok(of("small", "edit").every((s) => s.verdict === "pass" && s.exact === true));
    assert.equal(of("zeta", "edit").length, plan.edits.length);
    assert.ok(
      of("zeta", "edit").every((s) => s.verdict === "pass" && s.exact === true),
      JSON.stringify(
        of("zeta", "edit")
          .filter((s) => s.verdict !== "pass")
          .map((s) => [s.task, s.verdict, s.text]),
      ),
    );
  });

  test("a wrong answer is graded wrong, an empty one fails, and an answer that works in other words is not an exact one", async () => {
    const wrong = await runExecSamples({
      ...plan,
      targets: [{ label: "w", format: "qwen2.5-coder", model: "wrong" }],
      arms: ["completion"],
    });
    assert.ok(wrong.every((s) => s.verdict !== "pass" && s.exact === false));
    const silent = await runExecSamples({
      ...plan,
      targets: [{ label: "s", format: "qwen2.5-coder", model: "silent" }],
      arms: ["completion"],
    });
    assert.ok(silent.every((s) => s.verdict !== "pass" && s.shownVerdict === "suppressed"));
    const t = plan.fim.find((x) => x.id === "clamp/fim3");
    assert.ok(t);
    assert.equal(t.expected, "if (n > hi) return hi;");
    const s = plan.specs.find((x) => x.id === "clamp") as Spec;
    assert.equal(await grade(s, withFill(s, t, "if (hi < n) return hi;")), "pass");
  });

  test("samples already done are skipped, and each one is reported as it finishes", async () => {
    const seen: string[] = [];
    const first = await runExecSamples({ ...plan, targets: plan.targets.slice(0, 1) }, { onSample: (s) => void seen.push(s.task) });
    assert.equal(seen.length, first.length);
    const done = new Set(first.map((s) => `${s.target}|${s.arm}|${s.task}`));
    const second = await runExecSamples({ ...plan, targets: plan.targets.slice(0, 1) }, { done });
    assert.equal(second.length, 0);
  });

  test("the summary counts how each failed, and how many worked that an exact match would have refused", async () => {
    const samples = await runExecSamples({ ...plan, targets: plan.targets.slice(0, 1) });
    const row = execRowFor("oracle", "completion", "all", samples);
    assert.equal(row.n, plan.fim.length);
    assert.equal(row.pass, row.n);
    assert.equal(row.passNotExact, 0);
    const mixed = [
      ...samples,
      { ...(samples[0] as NonNullable<(typeof samples)[0]>), task: "x", exact: false },
      { ...(samples[0] as NonNullable<(typeof samples)[0]>), task: "y", verdict: "syntax" as const, exact: false },
    ];
    const r = execRowFor("oracle", "completion", "all", mixed);
    assert.equal(r.passNotExact, 1);
    assert.equal(r.syntax, 1);
    const md = summarizeExec(mixed).markdown;
    assert.match(md, /\| oracle \| completion \| all \| \d+ \| 0 \| 0 \| \*\*\d+%\*\* \|/);
  });
});

describe("the command", () => {
  test("several runs are summarised together", async () => {
    const dir = await tempDir();
    const line = (target: string): string =>
      JSON.stringify({ target, format: "f", arm: "completion", task: "t", kind: "line", verdict: "pass", exact: true });
    for (const t of ["a", "b"]) {
      await mkdir(join(dir, t), { recursive: true });
      await writeFile(join(dir, t, "samples.jsonl"), `${line(t)}\n`);
    }
    const { stdout } = await run(process.execPath, [
      "--no-warnings",
      "tools/exec-bench.ts",
      "--summarize",
      `${join(dir, "a")},${join(dir, "b")}`,
      "--out",
      join(dir, "all"),
    ]);
    assert.match(stdout, /\| a \| completion \| all \| 1 /);
    assert.match(stdout, /\| b \| completion \| all \| 1 /);
    assert.match(await readFile(join(dir, "all", "summary.md"), "utf8"), /\| b \|/);
  });

  test("options", () => {
    const o = parseExecArgs([
      "--model",
      "a=qwen2.5-coder",
      "--model",
      "b=sweep-next-edit",
      "--limit",
      "5",
      "--only",
      "gcd",
      "--arms",
      "infill",
      "--no-filters",
    ]);
    assert.deepEqual(o.models, [
      { name: "a", format: "qwen2.5-coder" },
      { name: "b", format: "sweep-next-edit" },
    ]);
    assert.equal(o.limit, 5);
    assert.equal(o.only, "gcd");
    assert.deepEqual(o.arms, ["infill"]);
    assert.equal(o.filters, false);
    assert.throws(() => parseExecArgs(["--model", "nope"]), /NAME=FORMAT/);
    assert.throws(() => parseExecArgs(["--model", "a=nonsense"]), /unknown/i);
    assert.throws(() => parseExecArgs(["--arms", "edit"]), /unknown arm/);
    assert.throws(() => parseExecArgs(["--wat"]), /unknown option/);
  });

  test("a limit takes tasks spread through the suite, of each kind", () => {
    assert.deepEqual(spread([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
    assert.deepEqual(spread([1, 2], 5), [1, 2]);
    assert.equal(spread([1, 2, 3], undefined).length, 3);
    const all = planTasks(suite, {});
    const some = planTasks(suite, { limit: 4 });
    assert.equal(some.fim.length, 12);
    assert.equal(some.edits.length, 8, "four of each kind");
    assert.ok(all.fim.length > some.fim.length);
    assert.deepEqual(
      planTasks(suite, { only: "gcd/" }).fim.map((t) => t.id),
      ["gcd/fim1", "gcd/fim2"],
    );
  });
});
