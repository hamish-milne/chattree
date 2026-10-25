import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseArgs, runLiveChecks, type ScenarioResult } from "../../tools/live-check.ts";
import { FakeServer, type Reply, type Seen } from "../support/fake-server.ts";

const ev = (name: string, data: object): string => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const msgStart = ev("message_start", { message: { id: "m", model: "fake", usage: { input_tokens: 10, output_tokens: 1 } } });
const textBlock = (parts: string[]): string[] => [ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), ...parts.map((t) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })), ev("content_block_stop", { index: 0 })];
const endMsg = (reason: string): string => ev("message_delta", { delta: { stop_reason: reason }, usage: { output_tokens: 7 } }) + ev("message_stop", {});
const text = (parts: string[]): Reply => ({ acts: [msgStart, ...textBlock(parts), endMsg("end_turn")] });
const toolUse: Reply = { acts: [msgStart, ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "get_weather", input: {} } }), ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' } }), ev("content_block_stop", { index: 0 }), endMsg("tool_use")] };

/** A pretend Anthropic-compatible model server that answers according to the prompt. */
const pretend = (opts: { tools?: boolean } = {}) => (_n: number, seen: Seen): Reply => {
  const body = JSON.parse(seen.body) as { model: string; messages: { content: unknown }[]; tools?: unknown[] };
  if (body.model.includes("no-such")) return { status: 404, acts: [JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model not found" } })] };
  const last = JSON.stringify(body.messages[body.messages.length - 1]);
  if (last.includes("tool_result")) return text(["It is ", "18C."]);
  if (body.tools !== undefined && opts.tools !== false) return toolUse;
  if (last.includes("fox")) return { acts: [msgStart, ...textBlock(["Once", " upon"]), { wait: 5 }, ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: " a time" } }), { hang: true }] };
  if (last.includes("Count")) return text(["1 2 ", "3 4 ", "5 6"]);
  return text(["pong"]);
};

const check = async (flavor: "anthropic" | "openai-responses", script: ReturnType<typeof pretend>): Promise<ScenarioResult[]> => {
  const server = await FakeServer.start(script);
  try {
    return await runLiveChecks({ flavor, baseUrl: server.url, model: "fake-model", apiKey: "sk-secret" });
  } finally {
    await server.close();
  }
};
const byName = (rs: ScenarioResult[]): Record<string, ScenarioResult> => Object.fromEntries(rs.map((r) => [r.name, r]));

describe("runLiveChecks", () => {
  test("a well-behaved server passes; reasoning is skipped when the model has none", async () => {
    const r = byName(await check("anthropic", pretend()));
    for (const name of ["plain", "usage", "streaming", "tool-call", "abort", "bad-model"]) assert.equal(r[name]?.status, "pass", `${name}: ${r[name]?.detail}`);
    assert.equal(r["reasoning-replay"]?.status, "skip");
  });

  test("a model that never calls the tool is skipped, not failed", async () => {
    const r = byName(await check("anthropic", pretend({ tools: false })));
    assert.equal(r["tool-call"]?.status, "skip");
  });

  test("a server that does not stream incrementally fails the streaming check", async () => {
    const r = byName(await check("anthropic", (n, seen) => (seen.body.includes("Count") ? text(["1 2 3 4 5 6"]) : pretend()(n, seen))));
    assert.equal(r["streaming"]?.status, "fail");
    assert.match(r["streaming"]?.detail ?? "", /incrementally/);
  });

  test("a server that accepts any model fails bad-model", async () => {
    const r = byName(await check("anthropic", (n, seen) => pretend()(n, { ...seen, body: seen.body.replace("chattree-no-such-model", "x") })));
    assert.equal(r["bad-model"]?.status, "fail");
  });

  test("the OpenAI Responses flavor against a minimal server", async () => {
    const responses = (parts: string[]): Reply => ({
      acts: [
        ev("response.created", { response: { id: "r1", model: "fake" } }),
        ev("response.output_item.added", { output_index: 0, item: { id: "m1", type: "message", content: [] } }),
        ...parts.map((t) => ev("response.output_text.delta", { output_index: 0, delta: t })),
        ev("response.output_item.done", { output_index: 0, item: { id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: parts.join("") }] } }),
        ev("response.completed", { response: { id: "r1", model: "fake", status: "completed", usage: { input_tokens: 5, output_tokens: 4 } } }),
      ],
    });
    const server = await FakeServer.start((_n, seen) => {
      const body = JSON.parse(seen.body) as { model: string };
      if (body.model.includes("no-such")) return { status: 404, acts: [JSON.stringify({ error: { message: "model not found", code: "model_not_found" } })] };
      return seen.body.includes("Count") ? responses(["1 2 ", "3 4 ", "5"]) : responses(["pong"]);
    });
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-responses", baseUrl: `${server.url}/v1`, model: "fake", only: ["plain", "usage", "streaming", "bad-model"] }));
      for (const name of ["plain", "usage", "streaming", "bad-model"]) assert.equal(r[name]?.status, "pass", `${name}: ${r[name]?.detail}`);
    } finally {
      await server.close();
    }
  });

  test("chaining and retrieval scenarios against a Responses server that stores what it says", async () => {
    const item = (text: string) => ({ id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
    const done = (text: string, n: number): Reply => ({ acts: [ev("response.created", { response: { id: `r${n}`, model: "fake", store: true } }), ev("response.output_item.added", { output_index: 0, item: { id: "m1", type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 0, delta: text }), ev("response.output_item.done", { output_index: 0, item: item(text) }), ev("response.completed", { response: { id: `r${n}`, model: "fake", status: "completed", store: true, usage: { input_tokens: 5, output_tokens: 4 } } })] });
    const server = await FakeServer.start((n, seen) => (seen.method === "GET" ? { headers: { "content-type": "application/json" }, acts: [JSON.stringify({ id: "r1", model: "fake", status: "completed", store: true, usage: { input_tokens: 1, output_tokens: 1 }, output: [item("pong")] })] } : seen.body.includes("previous_response_id") || seen.body.includes("7421") && seen.body.includes("What number") ? done("7421", n + 1) : done("pong", n + 1)));
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-responses", baseUrl: `${server.url}/v1`, model: "fake", only: ["chaining", "retrieve"] }));
      assert.equal(r["chaining"]?.status, "pass", r["chaining"]?.detail);
      assert.match(r["chaining"]?.detail ?? "", /previous_response_id/);
      assert.equal(r["retrieve"]?.status, "pass", r["retrieve"]?.detail);
    } finally {
      await server.close();
    }
  });

  test("onRun sees every scenario's events and the key never appears in results", async () => {
    const server = await FakeServer.start(pretend());
    const seen: string[] = [];
    try {
      const rs = await runLiveChecks({ flavor: "anthropic", baseUrl: server.url, model: "m", apiKey: "sk-secret", only: ["plain"], onRun: (s) => void seen.push(s) });
      assert.deepEqual(seen, ["plain"]);
      assert.ok(!JSON.stringify(rs).includes("sk-secret"));
      assert.equal(server.seen[0]?.headers["x-api-key"], "sk-secret");
    } finally {
      await server.close();
    }
  });
});

describe("parseArgs", () => {
  test("flags, key from an environment variable, repeated --only", () => {
    const { options, record } = parseArgs(["--flavor", "openai-responses", "--base-url", "http://x", "--model", "m", "--api-key-env", "K", "--only", "plain", "--only", "usage", "--record", "out", "--max-tokens", "64"], { K: "secret" });
    assert.deepEqual(options, { flavor: "openai-responses", baseUrl: "http://x", model: "m", maxTokens: 64, apiKey: "secret", only: ["plain", "usage"] });
    assert.equal(record, "out");
  });
  test("errors", () => {
    for (const [argv, re] of [[[], /required/], [["--flavor", "x", "--base-url", "u", "--model", "m"], /flavor/], [["--base-url", "u", "--model", "m", "--api-key-env", "NOPE"], /NOPE/], [["--base-url", "u", "--model", "m", "--only", "zz"], /scenario/], [["--bogus", "1"], /unknown flag/], [["stray"], /unexpected/], [["--model"], /needs a value/]] as const) {
      assert.throws(() => parseArgs(argv, {}), re, JSON.stringify(argv));
    }
  });
});
