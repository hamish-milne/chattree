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

/** A pretend Chat Completions server (llama-server style) that answers according to the prompt. */
const chatChunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ id: "c1", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const chatText = (parts: string[]): Reply => ({ acts: [...parts.map((t) => chatChunk({ content: t })), chatChunk({}, "stop"), `data: ${JSON.stringify({ id: "c1", model: "fake", choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } })}\n\n`, "data: [DONE]\n\n"] });
const chatPretend = (_n: number, seen: Seen): Reply => {
  const body = JSON.parse(seen.body) as { model: string; messages: { role: string; content?: string }[]; tools?: unknown[] };
  if (body.model.includes("no-such")) return { status: 404, acts: [JSON.stringify({ error: { message: "model not found", type: "invalid_request_error", code: "model_not_found" } })] };
  const last = body.messages[body.messages.length - 1];
  if (last?.role === "tool") return chatText(["It is ", "18C."]);
  if (body.tools !== undefined) return { acts: [chatChunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }), chatChunk({}, "tool_calls"), "data: [DONE]\n\n"] };
  if (last?.content?.includes("fox")) return { acts: [chatChunk({ content: "Once" }), { wait: 5 }, chatChunk({ content: " upon" }), { hang: true }] };
  if (last?.content?.includes("Count")) return chatText(["1 2 ", "3 4 ", "5 6"]);
  if (last?.content?.includes("What number")) return chatText(["7421"]);
  if (last?.content?.includes("remember")) return chatText(["ok"]);
  return chatText(["pong"]);
};

describe("runLiveChecks", () => {
  test("the Chat Completions flavor against a minimal server: retrieval is skipped, chaining falls back to replay", async () => {
    const server = await FakeServer.start(chatPretend);
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake" }));
      for (const name of ["plain", "usage", "streaming", "tool-call", "chaining", "abort", "bad-model"]) assert.equal(r[name]?.status, "pass", `${name}: ${r[name]?.detail}`);
      assert.equal(r["retrieve"]?.status, "skip");
    } finally {
      await server.close();
    }
  });

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

// ---- Stage A: the tool scenarios against a pretend Chat Completions server that uses the real starter tools --------

const toolCalls = (...cs: { id: string; name: string; args: unknown }[]): Reply => ({
  acts: [...cs.map((c, index) => chatChunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })), chatChunk({}, "tool_calls"), "data: [DONE]\n\n"],
});
const lastVersion = (body: { messages: { role: string; content?: string }[] }): string => {
  const tools = body.messages.filter((m) => m.role === "tool");
  return /v ([0-9a-f]{8})/.exec(tools.at(-1)?.content ?? "")?.[1] ?? "00000000";
};
const agentPretend = (opts: { tools?: boolean; badArgv?: boolean; wrongLines?: boolean } = {}) => (_n: number, seen: Seen): Reply => {
  const body = JSON.parse(seen.body) as { messages: { role: string; content?: string }[]; tools?: unknown[] };
  const results = body.messages.filter((m) => m.role === "tool").length;
  const prompt = body.messages.find((m) => m.role === "user")?.content ?? "";
  if (opts.tools === false || body.tools === undefined) return chatText(["no tools here"]);
  const read = (path: string) => toolCalls({ id: `r${results}`, name: "read", args: { files: [{ path }] } });
  const edit = (path: string, changes: unknown[]) => toolCalls({ id: `e${results}`, name: "edit", args: { files: [{ path, version: lastVersion(body), changes }] } });
  if (prompt.includes("Read notes.txt, then use the edit tool")) {
    if (results === 0) return read("notes.txt");
    if (results === 1) return edit("notes.txt", [{ start: 1, end: 1, content: "status: final" }]);
    if (results === 2) return toolCalls({ id: "x1", name: "run", args: { argv: ["cat", "notes.txt"] } });
    return chatText(["It prints status: final."]);
  }
  // tools-edit cases: read the file, then edit it with the version read showed
  const cases: [string, string, unknown[]][] = [
    ["change the word draft", "notes.txt", [{ start: 1, end: 1, content: opts.wrongLines === true ? "oops" : "status: final" }]],
    ["set retries to 5", "app.conf", [{ start: 2, end: 2, content: "retries = 5" }, { start: 3, end: 3, content: "verbose = true" }]],
    ["start with `drop`", "list.txt", [{ start: 2, end: 4, content: "" }]],
    ["import sys", "main.py", [{ after: 1, content: "import sys" }, { after: 4, content: "main()" }]],
  ];
  for (const [key, path, changes] of cases) if (prompt.includes(key)) return results === 0 ? read(path) : results === 1 ? edit(path, changes) : chatText(["done"]);
  if (prompt.includes("insert the line `# v2`")) return results === 0 ? read("f.txt") : results === 1 ? edit("f.txt", [{ after: 0, content: "# v2" }]) : results === 2 ? edit("f.txt", [{ start: 4, end: 4, content: "GAMMA" }]) : chatText(["done"]);
  if (results > 0) return chatText(["done"]);
  if (prompt.includes("two independent things")) return toolCalls({ id: "p1", name: "read", args: { files: [{ path: "a.txt" }] } }, { id: "p2", name: "run", args: { argv: ["ls", "-la"] } });
  if (prompt.includes("Use the read tool")) return toolCalls({ id: "s1", name: "read", args: { files: [{ path: "notes.txt" }] } });
  if (prompt.includes("run tool")) return toolCalls({ id: "ru", name: "run", args: opts.badArgv === true ? { argv: "ls -la" } : { argv: ["ls", "-la"] } });
  return chatText(["pong"]);
};

describe("runLiveChecks, tool scenarios", () => {
  const names = ["tools-schema", "tools-parallel", "tools-reliability", "tools-edit", "agent-loop"];
  test("a model that uses the tools well passes all four, including the real loop in a temporary workspace", async () => {
    const server = await FakeServer.start(agentPretend());
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only: names }));
      for (const name of names) assert.equal(r[name]?.status, "pass", `${name}: ${r[name]?.detail}`);
      assert.match(r["tools-parallel"]?.detail ?? "", /2 calls \(read, run\) with distinct ids/);
      assert.match(r["tools-reliability"]?.detail ?? "", /run 4\/4 valid/);
      assert.match(r["tools-edit"]?.detail ?? "", /^5\/5 correct/);
      assert.match(r["agent-loop"]?.detail ?? "", /tools used: edit, read, run/);
    } finally {
      await server.close();
    }
  });

  test("tools-edit scores the file, not the call: a call that passes the schema but changes the wrong text is wrong", async () => {
    const server = await FakeServer.start(agentPretend({ wrongLines: true }));
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only: ["tools-edit"] }));
      assert.equal(r["tools-edit"]?.status, "pass");
      assert.match(r["tools-edit"]?.detail ?? "", /^4\/5 correct; one line: WRONG.*"notes.txt":"oops/);
    } finally {
      await server.close();
    }
  });

  test("a model without tool support skips all of them", async () => {
    const server = await FakeServer.start(agentPretend({ tools: false }));
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only: names }));
      for (const name of names) assert.equal(r[name]?.status, "skip", `${name}: ${r[name]?.detail}`);
    } finally {
      await server.close();
    }
  });

  test("a model whose run calls all break the schema fails the reliability check, and says why", async () => {
    const server = await FakeServer.start(agentPretend({ badArgv: true }));
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only: ["tools-reliability"] }));
      assert.equal(r["tools-reliability"]?.status, "fail");
      assert.match(r["tools-reliability"]?.detail ?? "", /no valid run call.*argv must be a list/);
    } finally {
      await server.close();
    }
  });

  test("a model that uses another tool is not counted as malformed, and every request is recorded in its own file", async () => {
    const server = await FakeServer.start((n, seen) => (JSON.stringify(JSON.parse(seen.body).messages).includes("run tool") && !seen.body.includes("Read notes.txt, then") ? toolCalls({ id: "q", name: "read", args: { files: [{ path: "notes.txt" }] } }) : agentPretend()(n, seen)));
    const runs: string[] = [];
    const logs: string[] = [];
    try {
      const r = byName(await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only: ["tools-reliability", "agent-loop"], onRun: (s, _run, req) => void runs.push(`${s}:${req?.tools.length}`), onLog: (s, label) => void logs.push(`${s}:${label}`) }));
      assert.equal(r["tools-reliability"]?.status, "pass");
      assert.match(r["tools-reliability"]?.detail ?? "", /run 0\/0 valid; 4 used another tool \(read, read, read, read\)/);
      assert.equal(runs.filter((x) => x.startsWith("tools-reliability")).length, 4);
      assert.equal(runs.filter((x) => x.startsWith("agent-loop")).length >= 1, true, "the loop's requests are recorded too");
      assert.ok(logs.includes("agent-loop:loop"));
    } finally {
      await server.close();
    }
  });
});
