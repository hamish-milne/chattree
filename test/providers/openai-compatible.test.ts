import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContext, type ModelContext } from "../../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../../providers/conformance.ts";
import { replayFetch, type Fixture } from "../../providers/fixtures.ts";
import { buildChatBody, classifyCompatible, openaiCompatibleAdapter, parseCompatibleSettings } from "../../providers/openai-compatible.ts";
import { defaultRegistry } from "../../providers/index.ts";
import { ProviderError } from "../../providers/types.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { Rng } from "../support/gen.ts";

const KEY = "sk-local-SECRET-key";
const data = (o: unknown): string => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: object, finish: string | null = null, extra: object = {}) => data({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "qwen3:4b", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usage = (u: object) => data({ id: "chatcmpl-1", model: "qwen3:4b", choices: [], usage: u });
const DONE = data("[DONE]");
const fixture = (events: string[], status = 200): Fixture => ({ version: 1, response: { status, headers: { "content-type": "text/event-stream" }, body: events.join("") } });

const TEXT = [chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo" }), chunk({}, "stop"), usage({ prompt_tokens: 25, completion_tokens: 15, total_tokens: 40, prompt_tokens_details: { cached_tokens: 10 } }), DONE];
const TOOL = [
  chunk({ role: "assistant", content: "Checking." }),
  chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_weather", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city": "San' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: ' Francisco"}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } }] }),
  chunk({}, "tool_calls"),
  usage({ prompt_tokens: 50, completion_tokens: 30 }),
  DONE,
];
const LLAMA_THINKING = [chunk({ role: "assistant", reasoning_content: "Let me " }), chunk({ reasoning_content: "think." }), chunk({ content: "Done." }), chunk({}, "stop"), usage({ prompt_tokens: 9, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 22 } }), DONE];
const OLLAMA_THINKING = LLAMA_THINKING.map((c) => c.replaceAll("reasoning_content", "reasoning"));

const setupFor = (settings: Record<string, unknown> = { max_output_tokens: 1024 }): AgentSetup => ({ ...emptySetup(), model: { provider: "local", id: "qwen3:4b", settings } });
const ctx = (over: Partial<ModelContext> = {}): ModelContext => ({ system: "SYS", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [], ...over });
const req = (c: ModelContext = ctx(), setup = setupFor()) => ({ context: c, setup, signal: new AbortController().signal });
const fast = { retry: { baseMs: 1, jitter: (ms: number) => ms }, sleep: async () => {} };
const replay = (events: string[], sizes: readonly number[] = [Number.MAX_SAFE_INTEGER], status = 200) => openaiCompatibleAdapter({ baseUrl: "http://localhost:1/v1", apiKey: KEY, http: { fetch: replayFetch(fixture(events, status), sizes), ...fast } });
const run = (a = replay(TEXT), c = ctx(), setup = setupFor()): Promise<StreamRun> => collectStream(a.stream(req(c, setup)));
const good = (r: StreamRun): StreamRun => {
  assert.deepEqual(conformanceProblems(r, { secrets: [KEY] }), []);
  assert.equal(r.error, undefined);
  return r;
};

describe("settings", () => {
  test("accepted and refused", () => {
    assert.equal(parseCompatibleSettings({ max_output_tokens: 100, temperature: 0.5, stop: ["x"], reasoning_effort: "low", replay_reasoning: true, extra: { top_k: 40 } }).reasoning_effort, "low");
    for (const bad of [{}, { max_output_tokens: 0 }, { max_output_tokens: 10, temprature: 1 }, { max_output_tokens: 10, stop: ["a", "b", "c", "d", "e"] }]) {
      assert.throws(() => parseCompatibleSettings(bad), (e) => e instanceof ProviderError && e.kind === "invalid_request" && !e.retryable, JSON.stringify(bad));
    }
  });
});

describe("request body", () => {
  const turns: ModelContext["turns"] = [
    { role: "user", parts: [{ type: "text", text: "weather?" }] },
    { role: "assistant", provider: "local", model: "qwen3:4b", blocks: [{ type: "reasoning", provider: "local", payload: "{}", visible: "hmm" }, { type: "text", text: "Let me look." }, { type: "tool_call", call_id: "c1", name: "get_weather", args: { city: "SF" } }, { type: "tool_call", call_id: "c2", name: "get_time", args: {} }] },
    { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "sunny", truncated: false }, { call_id: "c2", is_error: true, content: "no clock", truncated: false }] },
    { role: "assistant", provider: "local", model: "qwen3:4b", blocks: [{ type: "tool_call", call_id: "c3", name: "get_time", args: {} }] },
    { role: "assistant", provider: "local", model: "qwen3:4b", blocks: [{ type: "reasoning", provider: "local", payload: "{}", visible: "only thoughts" }] },
    { role: "user", parts: [{ type: "text", text: "thanks" }, { type: "text", text: "really" }] },
  ];
  const tools = [{ name: "get_weather", description: "Weather", input_schema: { type: "object" }, flags: { read_only: true } }];
  const opts = { maxTokensParam: "max_tokens", includeUsage: true } as const;

  test("system, user, assistant with tool calls, tool messages; tools as functions; usage asked for", () => {
    const b = buildChatBody(ctx({ turns, tools, instructions: "INS" }), setupFor({ max_output_tokens: 99, temperature: 0.2, stop: ["###"], seed: 7, reasoning_effort: "low" }), opts);
    assert.deepEqual(
      { ...b, messages: undefined },
      { model: "qwen3:4b", stream: true, max_tokens: 99, stream_options: { include_usage: true }, messages: undefined, tools: [{ type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object" } } }], temperature: 0.2, stop: ["###"], seed: 7, reasoning_effort: "low" },
    );
    assert.deepEqual(b["messages"], [
      { role: "system", content: "SYS\n\nINS" },
      { role: "user", content: "weather?" },
      { role: "assistant", content: "Let me look.", tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }, { id: "c2", type: "function", function: { name: "get_time", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
      { role: "tool", tool_call_id: "c2", content: "no clock" },
      { role: "assistant", content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "get_time", arguments: "{}" } }] },
      { role: "user", content: "thanks\n\nreally" },
    ]);
  });

  test("reasoning is replayed only when asked; the cap parameter and stream_options follow the config; extras cannot override owned fields", () => {
    const withReplay = buildChatBody(ctx({ turns }), setupFor({ max_output_tokens: 5, replay_reasoning: true }), opts)["messages"] as { reasoning_content?: string }[];
    assert.deepEqual(withReplay.map((m) => m.reasoning_content), [undefined, undefined, "hmm", undefined, undefined, undefined, undefined], "a turn of nothing but thoughts is dropped, not sent empty");
    assert.ok(!(buildChatBody(ctx({ turns }), setupFor({ max_output_tokens: 5 }), opts)["messages"] as { reasoning_content?: string }[]).some((m) => "reasoning_content" in m));
    const b = buildChatBody(ctx(), setupFor({ max_output_tokens: 5, extra: { top_k: 40, model: "evil", messages: [], max_tokens: 1 } }), { maxTokensParam: "max_completion_tokens", includeUsage: false });
    assert.equal(b["max_completion_tokens"], 5);
    assert.equal(b["max_tokens"], undefined);
    assert.equal(b["stream_options"], undefined);
    assert.equal(b["top_k"], 40);
    assert.equal(b["model"], "qwen3:4b");
    assert.equal((b["messages"] as unknown[]).length, 2);
    assert.equal(b["tools"], undefined);
  });

  test("an empty system prompt leaves the system message out; images, PDFs and a missing model never reach the network", async () => {
    assert.equal((buildChatBody(ctx({ system: "" }), setupFor(), opts)["messages"] as unknown[]).length, 1);
    const img = ctx({ turns: [{ role: "user", parts: [{ type: "text", text: "look" }, { type: "attachment", kind: "image", name: "a.png", mime: "image/png", sha256: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) }] }] });
    assert.deepEqual((buildChatBody(img, setupFor(), opts)["messages"] as { content: unknown }[]).at(-1)?.content, [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }]);
    const r = await run(replay(TEXT), ctx({ turns: [{ role: "user", parts: [{ type: "attachment", kind: "pdf", name: "r.pdf", mime: "application/pdf", sha256: "b".repeat(64), bytes: new Uint8Array([4, 5]) }] }] }));
    assert.ok(r.error instanceof ProviderError && /PDF/.test(r.error.message));
    const r2 = await collectStream(replay(TEXT).stream(req(ctx(), emptySetup())));
    assert.ok(r2.error instanceof ProviderError && /no model/.test(r2.error.message));
  });

  test("built from a real conversation by the context builder", async () => {
    const c = await buildContext(
      [
        { $tag: "header", format: "chattree/1" } as never,
        { $tag: "user", id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", content: [{ $tag: "text", text: "hello" }] },
        { $tag: "assistant", id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", provider: "local", model: "qwen3:4b", blocks: [{ $tag: "text", text: "hi there" }], stop_reason: "end_turn" },
        { $tag: "user", id: "01ARZ3NDEKTSV4RRFFQ69G5FAC", content: [{ $tag: "text", text: "again" }] },
      ],
      { system: "SYS", target: { provider: "local", model: "qwen3:4b" } },
    );
    const msgs = buildChatBody(c, setupFor(), opts)["messages"] as { role: string }[];
    assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "user"]);
  });
});

describe("stream", () => {
  test("text: events, usage with cached tokens taken out of the input, observed model and id", async () => {
    const r = good(await run());
    assert.deepEqual(r.events.map((e) => e.type), ["started", "observed", "text.delta", "text.delta", "block.done", "usage"]);
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "Hello" }]);
    assert.equal(r.completed?.stop_reason, "end_turn");
    assert.deepEqual({ ...r.completed?.usage, raw: undefined }, { input_tokens: 15, output_tokens: 15, cache_read_tokens: 10, raw: undefined });
    assert.deepEqual(r.completed?.observed, { model: "qwen3:4b", response_id: "chatcmpl-1" });
    assert.equal(r.completed?.ext, undefined);
  });

  test("tool calls: arguments assembled from fragments, several calls, text first; stop reason is tool_use", async () => {
    const r = good(await run(replay(TOOL)));
    assert.deepEqual(r.completed?.blocks, [
      { type: "text", text: "Checking." },
      { type: "tool_call", call_id: "call_a", name: "get_weather", args: { city: "San Francisco" } },
      { type: "tool_call", call_id: "call_b", name: "get_time", args: {} },
    ]);
    assert.equal(r.completed?.stop_reason, "tool_use");
    assert.deepEqual(r.events.filter((e) => e.type === "tool_call.start").map((e) => (e as { call_id: string }).call_id), ["call_a", "call_b"]);
  });

  test("Ollama's way: a whole call in one chunk, arguments as an object, no id, finish_reason stop", async () => {
    const r = good(await run(replay([chunk({ role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "SF" } } }] }), chunk({}, "stop"), DONE])));
    assert.deepEqual(r.completed?.blocks, [{ type: "tool_call", call_id: "call_chatcmpl-1_0", name: "get_weather", args: { city: "SF" } }]);
    assert.equal(r.completed?.stop_reason, "tool_use", "a finished call is tool_use whatever the server calls it");
    assert.equal(r.completed?.ext?.["usage_reported"], false);
    assert.deepEqual(r.completed?.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test("a call with invalid JSON arguments is kept as args_raw", async () => {
    const r = good(await run(replay([chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: '{"a":' } }] }), chunk({}, "tool_calls"), DONE])));
    assert.deepEqual(r.completed?.blocks, [{ type: "tool_call", call_id: "c", name: "f", args: {}, args_raw: '{"a":' }]);
  });

  test("reasoning in either field becomes a reasoning block before the text", async () => {
    for (const [events, field] of [[LLAMA_THINKING, "reasoning_content"], [OLLAMA_THINKING, "reasoning"]] as const) {
      const r = good(await run(replay(events)));
      assert.deepEqual(r.completed?.blocks, [{ type: "reasoning", provider: "local", payload: JSON.stringify({ [field]: "Let me think." }), visible: "Let me think." }, { type: "text", text: "Done." }]);
      assert.equal(r.completed?.usage.reasoning_tokens, 22);
      assert.ok(r.events.findIndex((e) => e.type === "block.done") < r.events.findIndex((e) => e.type === "text.delta"), "the thinking block is complete before the answer starts");
    }
  });

  test("inline <think> in the content becomes a reasoning block, whichever way the tags are split across chunks", async () => {
    const pieces = ["<th", "ink>Let me ", "think.</th", "ink>\n\n", "The ", "answer."];
    const r = good(await run(replay([...pieces.map((c) => chunk({ content: c })), chunk({}, "stop"), DONE])));
    assert.deepEqual(r.completed?.blocks, [{ type: "reasoning", provider: "local", payload: JSON.stringify({ think_tags: "Let me think." }), visible: "Let me think." }, { type: "text", text: "The answer." }]);
    assert.ok(r.events.findIndex((e) => e.type === "block.done") < r.events.findIndex((e) => e.type === "text.delta"));
    const sizes = good(await run(replay([...pieces.map((c) => chunk({ content: c })), chunk({}, "stop"), DONE], [7, 3, 11])));
    assert.deepEqual(sizes, r);
  });

  test("think_tags: off leaves the tags in the text; implicit and custom tags work; a response without tags is unchanged under auto", async () => {
    const tagged = [chunk({ content: "<think>x</think>y" }), chunk({}, "stop"), DONE];
    const off = good(await run(replay(tagged), ctx(), setupFor({ max_output_tokens: 9, think_tags: "off" })));
    assert.deepEqual(off.completed?.blocks, [{ type: "text", text: "<think>x</think>y" }]);
    const implicit = good(await run(replay([chunk({ content: "pondering</think>\nok" }), chunk({}, "stop"), DONE]), ctx(), setupFor({ max_output_tokens: 9, think_tags: "implicit" })));
    assert.deepEqual(implicit.completed?.blocks.map((b) => b.type), ["reasoning", "text"]);
    assert.equal(implicit.completed?.blocks[1]?.type === "text" && implicit.completed.blocks[1].text, "ok");
    const custom = good(await run(replay([chunk({ content: "[[a]]b" }), chunk({}, "stop"), DONE]), ctx(), setupFor({ max_output_tokens: 9, think_tags: { open: "[[", close: "]]" } })));
    assert.deepEqual(custom.completed?.blocks.map((b) => b.type), ["reasoning", "text"]);
    assert.deepEqual((await run(replay(TEXT))).completed?.blocks, [{ type: "text", text: "Hello" }]);
    assert.throws(() => parseCompatibleSettings({ max_output_tokens: 1, think_tags: "maybe" }));
  });

  test("a tool call right after inline reasoning, and a stream that ends inside the reasoning, still produce complete blocks", async () => {
    const r = good(await run(replay([chunk({ content: "<think>plan</think>" }), chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] }), chunk({}, "tool_calls"), DONE])));
    assert.deepEqual(r.completed?.blocks.map((b) => b.type), ["reasoning", "tool_call"]);
    const cut = good(await run(replay([chunk({ content: "<think>never finished" }), chunk({}, "length"), DONE])));
    assert.deepEqual(cut.completed?.blocks.map((b) => b.type), ["reasoning"]);
    assert.equal(cut.completed?.stop_reason, "max_tokens");
  });

  test("finish reasons are normalised; a refusal is text with the refusal stop reason", async () => {
    for (const [finish, want] of [["stop", "end_turn"], ["length", "max_tokens"], ["content_filter", "refusal"], ["eos", "eos"]] as const) {
      const r = good(await run(replay([chunk({ content: "x" }), chunk({}, finish), DONE])));
      assert.equal(r.completed?.stop_reason, want);
    }
    const r = good(await run(replay([chunk({ refusal: "I can't." }), chunk({}, "stop"), DONE])));
    assert.equal(r.completed?.stop_reason, "refusal");
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "I can't." }]);
  });

  test("usage that is revised, or reported as running totals, never goes down", async () => {
    const r = good(await run(replay([chunk({ content: "a" }, null, { usage: { prompt_tokens: 20, completion_tokens: 1 } }), chunk({ content: "b" }, null, { usage: { prompt_tokens: 18, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }), chunk({}, "stop"), DONE])));
    assert.deepEqual(r.completed?.usage.input_tokens, 15, "the result is the last word");
    assert.equal(r.completed?.usage.output_tokens, 2);
    assert.deepEqual(r.events.filter((e) => e.type === "usage").length, 1, "usage is reported once, at the end, because a revision cannot be taken back");
  });

  test("a stream with no finish chunk after output ends normally at [DONE]; unknown fields and empty lines are tolerated", async () => {
    const r = good(await run(replay([data({ choices: [{ delta: { content: "hi", unknown: 1 } }], timings: { predicted_n: 3 }, system_fingerprint: "x" }), ": keep-alive\n\n", DONE])));
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "hi" }]);
    assert.equal(r.completed?.stop_reason, "end_turn");
  });

  test("the result does not depend on how the bytes are cut", async () => {
    const all = [...LLAMA_THINKING.slice(0, 3), ...TOOL.slice(1, 6), usage({ prompt_tokens: 9, completion_tokens: 4 }), DONE];
    const baseline = await run(replay(all));
    good(baseline);
    const rng = new Rng(5);
    for (let i = 0; i < 40; i++) {
      const sizes = Array.from({ length: 1 + rng.int(4) }, () => 1 + rng.int(30));
      assert.deepEqual(await run(replay(all, sizes)), baseline, `sizes ${sizes}`);
    }
  });
});

describe("stream failures", () => {
  test("a stream that ends before [DONE], and malformed chunks, are protocol errors", async () => {
    for (const events of [[chunk({ content: "a" }), chunk({}, "stop")], ["data: {not json\n\n"]]) {
      const r = await run(replay(events));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "protocol", events[0]);
    }
  });

  test("an error chunk after content: kind from the code, and the complete blocks are kept", async () => {
    const r = await run(replay([chunk({ content: "partial" }), chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "{}" } }] }), data({ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } })]));
    assert.ok(r.error instanceof ProviderError && r.error.kind === "rate_limit" && r.error.retryable);
    assert.equal(r.error.message, "rate_limit_exceeded: slow down");
    assert.deepEqual(r.error.partial, [{ type: "text", text: "partial" }]);
    assert.equal(conformanceProblems(r).length, 0);
  });
});

describe("HTTP", () => {
  const serve = async (script: Reply[], fn: (s: FakeServer) => Promise<void>): Promise<void> => {
    const server = await FakeServer.start(script);
    try {
      await fn(server);
    } finally {
      await server.close();
    }
  };
  const errBody = (code: string, message: string, type = "invalid_request_error") => JSON.stringify({ error: { message, type, code } });

  test("the request: path under the base URL, bearer key, JSON body; no key means no header", async () => {
    await serve([{ acts: TEXT }], async (server) => {
      good(await collectStream(openaiCompatibleAdapter({ baseUrl: `${server.url}/v1/`, apiKey: KEY, http: fast }).stream(req())));
      const seen = server.seen[0];
      assert.equal(seen?.url, "/v1/chat/completions");
      assert.equal(seen?.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(JSON.parse(seen?.body ?? "").stream, true);
      await collectStream(openaiCompatibleAdapter({ baseUrl: `${server.url}/v1`, apiKey: async () => KEY, maxTokensParam: "max_completion_tokens", includeUsage: false, http: fast }).stream(req()));
      assert.equal(JSON.parse(server.seen[1]?.body ?? "").max_completion_tokens, 1024);
      assert.equal(JSON.parse(server.seen[1]?.body ?? "").stream_options, undefined);
      await collectStream(openaiCompatibleAdapter({ baseUrl: `${server.url}/v1`, http: fast }).stream(req()));
      assert.equal(server.seen[2]?.headers["authorization"], undefined);
    });
  });

  test("errors by status with the server's message, scrubbed; overload and rate limits are retried; a context overflow is not", async () => {
    await serve([{ status: 503, acts: [errBody("unavailable_error", "loading model", "unavailable_error")] }, { status: 429, headers: { "retry-after": "1" }, acts: [errBody("rate_limit_exceeded", "slow", "rate_limit_error")] }, { acts: TEXT }], async (server) => {
      good(await collectStream(openaiCompatibleAdapter({ baseUrl: server.url, apiKey: KEY, http: fast }).stream(req())));
      assert.equal(server.seen.length, 3);
    });
    for (const [status, code, kind, retryable] of [[401, "invalid_api_key", "auth", false], [400, "context_length_exceeded", "invalid_request", false], [400, "exceed_context_size_error", "invalid_request", false], [500, "server_error", "server", true]] as const) {
      await serve([{ status, acts: [errBody(code, `bad ${KEY}`)] }], async (server) => {
        const r = await collectStream(openaiCompatibleAdapter({ baseUrl: server.url, apiKey: KEY, http: { ...fast, retry: { maxAttempts: 1 } } }).stream(req()));
        assert.ok(r.error instanceof ProviderError && r.error.kind === kind && r.error.retryable === retryable && r.error.status === status, `${status} ${code}`);
        assert.equal(r.error.message, `${status} ${code}: bad [redacted]`);
      });
    }
    await serve([{ status: 404, acts: ["model 'x' not found"] }], async (server) => {
      const r = await collectStream(openaiCompatibleAdapter({ baseUrl: server.url, http: { ...fast, retry: { maxAttempts: 1 } } }).stream(req()));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "invalid_request" && /not found/.test(r.error.message));
    });
  });
});

describe("registration and classify", () => {
  test("the registry has it, with base_url required and the key named, never stored", async () => {
    const reg = defaultRegistry();
    const def = reg.get("openai-compatible");
    assert.ok(def !== undefined);
    const ok = await def.config["~standard"].validate({ $tag: "openai-compatible", base_url: "http://localhost:8080/v1", pricing: { free: true } });
    assert.equal(ok.issues, undefined);
    assert.notEqual((await def.config["~standard"].validate({ $tag: "openai-compatible" })).issues, undefined, "base_url is required");
    assert.notEqual((await def.config["~standard"].validate({ $tag: "openai-compatible", base_url: "http://x/v1", api_key_env: "sk-pasted-key-123" })).issues, undefined);
  });

  const m = (settings: Record<string, unknown>, id = "qwen3:4b"): AgentSetup => ({ ...emptySetup(), model: { provider: "local", id, settings } });
  test("what breaks a server's cache", () => {
    const base = m({ max_output_tokens: 1 });
    assert.deepEqual(classifyCompatible(base, m({ max_output_tokens: 99, temperature: 1 })), []);
    assert.deepEqual(classifyCompatible(base, m({ max_output_tokens: 1, reasoning_effort: "high" })).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyCompatible(base, m({ max_output_tokens: 1, replay_reasoning: true })).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyCompatible(base, m({ max_output_tokens: 1 }, "llama3")).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyCompatible(emptySetup(), base), []);
  });
});
