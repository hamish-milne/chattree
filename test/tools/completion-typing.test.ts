import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fimTasksOf, loadSuite } from "../../tools/exec-suite.ts";
import { typeThrough, typingRow, typingTable } from "../../tools/completion-typing.ts";

describe("typing replay", () => {
  test("a request is made after every step of the typed text, and the cached share is read from the server's figures", async () => {
    const suite = await loadSuite();
    const spec = suite.find((s) => s.id === "cross-lexer");
    const task = spec === undefined ? undefined : fimTasksOf(spec)[0];
    assert.ok(task !== undefined);
    let last = "";
    const sent: string[] = [];
    const fake: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { prompt: string };
      sent.push(body.prompt);
      let common = 0;
      while (common < last.length && common < body.prompt.length && last[common] === body.prompt[common]) common++;
      last = body.prompt;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: "x",
            stop_type: "limit",
            timings: { prompt_n: body.prompt.length - common, cache_n: common, predicted_n: 1 },
          }),
        ),
      );
    };
    const steps = await typeThrough({ label: "t", format: "qwen2.5-coder" }, task, { baseUrl: "http://x", fetch: fake }, 4);
    assert.equal(steps.length, Math.floor(task.expected.length / 4) + 1);
    assert.equal(new Set(sent).size, sent.length, "each request has more typed");
    const row = typingRow("t", "qwen2.5-coder", steps);
    assert.equal(row.steps, steps.length);
    assert.ok(row.cachedShare >= 0 && row.cachedShare <= 1);
    assert.match(typingTable([row]), /\| t \| qwen2\.5-coder \|/);
  });

  test("the row averages what was evaluated afresh, leaving the first request out", () => {
    const row = typingRow("m", "f", [
      { typed: 0, promptTokens: 100, cachedTokens: 0, totalMs: 50 },
      { typed: 1, promptTokens: 10, cachedTokens: 90, totalMs: 10 },
      { typed: 2, promptTokens: 30, cachedTokens: 70, totalMs: 20 },
    ]);
    assert.equal(row.meanEvaluated, 20);
    assert.equal(row.cachedShare, 0.8);
    assert.equal(row.meanPrompt, 100);
    assert.equal(row.msP50, 20);
  });
});
