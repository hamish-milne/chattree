import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "../../tools/spec-bench.ts";

const s = (model: string, n: number, result: string, extra: object = {}) => ({ model, task: "copy", n, ms: 1000, output_tokens: 100, drafted: undefined, accepted: undefined, result, calls: 0, ...extra });

test("the report compares each arm with the baseline", () => {
  const text = report([s("a", 1, "x = 1"), s("b", 1, "x = 1", { ms: 500, drafted: 40, accepted: 30 }), s("b", 2, "x = 2", { drafted: 10, accepted: 0 })], ["a", "b"]);
  assert.match(text, /\| copy \| b \| 750 \| 133\.3 \| 50 \| 30 \(60%\) \| 1\/2 \|/);
  assert.match(text, /copy b #2: at character 4: baseline "x = 1", arm "x = 2"/);
  assert.match(text, /\| copy \| a \| 1000 \| 100\.0 \| n\/a \| n\/a \| - \|/);
});
test("an error is listed and not counted in the means", () => {
  const text = report([s("a", 1, "x"), s("b", 1, "", { error: "no server" })], ["a", "b"]);
  assert.match(text, /\| copy \| b \| - \| - \| n\/a \| n\/a \| 0\/0 \| 0\/0 \| 1 \|/);
  assert.match(text, /error: no server/);
});
test("a task that should end in a call and has none is said so, even when the baseline has none too", () => {
  const text = report([s("a", 1, "write{}", { task: "call", calls_expected: true }), s("b", 1, "write{}", { task: "call", calls_expected: true })], ["a", "b"]);
  assert.match(text, /\*\*call a: no tool call in 1 of its runs/);
  assert.match(text, /\*\*call b: no tool call/);
});
