import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContext, type ModelContext } from "../../harness/context-builder.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { emptySetup, foldSetup, type AgentSetup } from "../../harness/setup.ts";
import { anthropicAdapter, buildAnthropicBody, classifyAnthropic, parseAnthropicSettings } from "../../providers/anthropic.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../../providers/conformance.ts";
import { replayFetch, type Fixture } from "../../providers/fixtures.ts";
import { ProviderError } from "../../providers/types.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { Rng } from "../support/gen.ts";

// ---- helpers --------------------------------------------------------------------------------------------------

const KEY = "sk-ant-SECRET-key";
const ev = (name: string, data: object): string => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const start = (usage: object = { input_tokens: 25, output_tokens: 1 }) => ev("message_start", { message: { id: "msg_01", type: "message", role: "assistant", content: [], model: "claude-sonnet-5-5-20260301", stop_reason: null, usage } });
const blockStart = (index: number, content_block: object) => ev("content_block_start", { index, content_block });
const delta = (index: number, d: object) => ev("content_block_delta", { index, delta: d });
const stop = (index: number) => ev("content_block_stop", { index });
const end = (stop_reason: string, usage: object = { output_tokens: 15 }) => ev("message_delta", { delta: { stop_reason, stop_sequence: null }, usage }) + ev("message_stop", {});
const fixture = (events: string[], status = 200): Fixture => ({ version: 1, response: { status, headers: { "content-type": "text/event-stream" }, body: events.join("") } });

const TEXT = [start(), blockStart(0, { type: "text", text: "" }), ev("ping", {}), delta(0, { type: "text_delta", text: "Hel" }), delta(0, { type: "text_delta", text: "lo" }), stop(0), end("end_turn")];
const TOOL = [
  start(),
  blockStart(0, { type: "text", text: "" }),
  delta(0, { type: "text_delta", text: "Checking." }),
  stop(0),
  blockStart(1, { type: "tool_use", id: "toolu_01", name: "get_weather", input: {} }),
  delta(1, { type: "input_json_delta", partial_json: "" }),
  delta(1, { type: "input_json_delta", partial_json: '{"location": "San' }),
  delta(1, { type: "input_json_delta", partial_json: ' Francisco, CA"}' }),
  stop(1),
  end("tool_use", { output_tokens: 89 }),
];
const THINKING = [
  start(),
  blockStart(0, { type: "thinking", thinking: "", signature: "" }),
  delta(0, { type: "thinking_delta", thinking: "Let me " }),
  delta(0, { type: "thinking_delta", thinking: "think." }),
  delta(0, { type: "signature_delta", signature: "EqQBCgIYAhIM" }),
  stop(0),
  blockStart(1, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" }),
  stop(1),
  blockStart(2, { type: "text", text: "" }),
  delta(2, { type: "text_delta", text: "Done." }),
  stop(2),
  end("end_turn", { output_tokens: 40, output_tokens_details: { thinking_tokens: 22 } }),
];

const setupFor = (settings: Record<string, unknown> = { max_output_tokens: 1024 }, extra: Partial<AgentSetup> = {}): AgentSetup => ({ ...emptySetup(), model: { provider: "main", id: "claude-sonnet-5-5", settings }, ...extra });
const ctx = (over: Partial<ModelContext> = {}): ModelContext => ({ system: "SYS", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [], ...over });
const req = (c: ModelContext = ctx(), setup = setupFor(), signal = new AbortController().signal) => ({ context: c, setup, signal });
const fast = { retry: { baseMs: 1, jitter: (ms: number) => ms }, sleep: async () => {} };
const replay = (events: string[], sizes: readonly number[] = [Number.MAX_SAFE_INTEGER], status = 200) => anthropicAdapter({ baseUrl: "https://api.anthropic.com", apiKey: KEY, http: { fetch: replayFetch(fixture(events, status), sizes), ...fast } });
const run = (a = replay(TEXT), c = ctx(), setup = setupFor()): Promise<StreamRun> => collectStream(a.stream(req(c, setup)));
const good = (r: StreamRun): StreamRun => {
  assert.deepEqual(conformanceProblems(r, { secrets: [KEY] }), []);
  assert.equal(r.error, undefined);
  return r;
};

// ---- settings -------------------------------------------------------------------------------------------------

describe("settings", () => {
  test("accepted and refused", () => {
    assert.deepEqual(parseAnthropicSettings({ max_output_tokens: 100, thinking: { type: "adaptive", display: "summarized" }, effort: "high", temperature: 0.5, stop_sequences: ["x"] }).effort, "high");
    for (const bad of [{}, { max_output_tokens: 0 }, { max_output_tokens: 10, effrot: "high" }, { max_output_tokens: 10, thinking: { type: "enabled" } }, { max_output_tokens: 10, temperature: 2 }]) {
      assert.throws(() => parseAnthropicSettings(bad), (e) => e instanceof ProviderError && e.kind === "invalid_request" && !e.retryable, JSON.stringify(bad));
    }
  });
});

// ---- request --------------------------------------------------------------------------------------------------

describe("request body", () => {
  const sig = JSON.stringify({ type: "thinking", thinking: "hmm", signature: "SIG", extra_field: 1 });
  const redacted = JSON.stringify({ type: "redacted_thinking", data: "OPAQUE" });
  const turns: ModelContext["turns"] = [
    { role: "user", parts: [{ type: "text", text: "weather?" }] },
    { role: "assistant", provider: "main", model: "claude-sonnet-5-5", blocks: [{ type: "reasoning", provider: "main", payload: sig, visible: "hmm" }, { type: "reasoning", provider: "main", payload: redacted }, { type: "text", text: "Let me look." }, { type: "tool_call", call_id: "toolu_1", name: "get_weather", args: { city: "SF" } }, { type: "tool_call", call_id: "toolu_2", name: "get_time", args: {} }] },
    { role: "tool_results", results: [{ call_id: "toolu_1", is_error: false, content: "sunny", truncated: false }, { call_id: "toolu_2", is_error: true, content: "no clock", truncated: false }] },
    { role: "user", parts: [{ type: "text", text: "and tomorrow?" }] },
    { role: "assistant", provider: "main", model: "claude-sonnet-5-5", blocks: [{ type: "text", text: "Rain." }] },
    { role: "user", parts: [{ type: "text", text: "thanks" }] },
  ];
  const tools = [{ name: "get_weather", description: "Weather", input_schema: { type: "object" }, flags: { read_only: true } }];

  test("system blocks, tools, messages: tool results first in one user message with the next user turn; thinking replayed verbatim", () => {
    const body = buildAnthropicBody(ctx({ instructions: "INSTR", tools, turns }), setupFor({ max_output_tokens: 2000, thinking: { type: "adaptive" }, effort: "medium", temperature: 0.2 }), { cacheControl: false });
    assert.deepEqual(body, {
      model: "claude-sonnet-5-5",
      max_tokens: 2000,
      stream: true,
      system: [{ type: "text", text: "SYS" }, { type: "text", text: "INSTR" }],
      tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        { role: "assistant", content: [JSON.parse(sig), JSON.parse(redacted), { type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } }, { type: "tool_use", id: "toolu_2", name: "get_time", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }, { type: "tool_result", tool_use_id: "toolu_2", content: "no clock", is_error: true }, { type: "text", text: "and tomorrow?" }] },
        { role: "assistant", content: [{ type: "text", text: "Rain." }] },
        { role: "user", content: [{ type: "text", text: "thanks" }] },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      temperature: 0.2,
    });
  });

  test("cache breakpoints: the end of the system prompt and the turns named by the hints, never on thinking", () => {
    const body = buildAnthropicBody(ctx({ instructions: "INSTR", turns, cacheHints: [4, 5] }), setupFor(), { cacheControl: true });
    const system = body["system"] as { cache_control?: unknown }[];
    assert.deepEqual(system.map((b) => "cache_control" in b), [false, true]);
    const messages = body["messages"] as { content: { cache_control?: unknown }[] }[];
    const marked = messages.map((m) => m.content.map((b) => "cache_control" in b));
    assert.deepEqual(marked, [[false], [false, false, false, false, false], [false, false, false], [true], [true]]);
    assert.ok(!JSON.stringify(buildAnthropicBody(ctx({ turns, cacheHints: [4, 5] }), setupFor(), { cacheControl: false })).includes("cache_control"));
    const thinkingLast = buildAnthropicBody(ctx({ turns: [turns[0]!, { role: "assistant", provider: "main", model: "m", blocks: [{ type: "reasoning", provider: "main", payload: sig }] }], cacheHints: [1] }), setupFor(), { cacheControl: true });
    assert.ok(!JSON.stringify(thinkingLast["messages"]).includes("cache_control"));
  });

  test("an empty system prompt and no tools leave those fields out; the dated model id is used once known", () => {
    const body = buildAnthropicBody(ctx({ system: "" }), { ...setupFor(), model: { provider: "main", id: "claude-sonnet-5-5", resolved: "claude-sonnet-5-5-20260301", settings: { max_output_tokens: 5 } } }, { cacheControl: false });
    assert.ok(!("system" in body) && !("tools" in body));
    assert.equal(body["model"], "claude-sonnet-5-5-20260301");
  });

  test("attachments are refused clearly; a missing model or bad settings never reach the network", async () => {
    const att = ctx({ turns: [{ role: "user", parts: [{ type: "attachment", name: "a.png", data: { $tag: "blob", sha256: "a".repeat(64), bytes: 1 } }] }] });
    assert.throws(() => buildAnthropicBody(att, setupFor(), { cacheControl: false }), /attachments/);
    const r = await collectStream(replay(TEXT).stream(req(ctx(), emptySetup())));
    assert.ok(r.error instanceof ProviderError && r.error.kind === "invalid_request");
    const r2 = await run(replay(TEXT), ctx(), setupFor({ max_output_tokens: -1 }));
    assert.ok(r2.error instanceof ProviderError && /invalid model settings/.test(r2.error.message));
  });

  test("built from a real conversation by the context builder", async () => {
    const entries: ChatEntry[] = [
      { $tag: "user", id: "01ARZ3NDEKTSV4RRFFQ69G0001", content: [{ $tag: "text", text: "q" }] },
      { $tag: "assistant", id: "01ARZ3NDEKTSV4RRFFQ69G0002", provider: "main", model: "claude-sonnet-5-5", stop_reason: "end_turn", blocks: [{ $tag: "reasoning", provider: "main", payload: sig, visible: "hmm" }, { $tag: "text", text: "a" }] },
      { $tag: "user", id: "01ARZ3NDEKTSV4RRFFQ69G0003", content: [{ $tag: "text", text: "q2" }] },
    ];
    const c = await buildContext(entries, { system: "S", target: { provider: "main", model: "claude-sonnet-5-5" } });
    const body = buildAnthropicBody(c, setupFor(), { cacheControl: false });
    assert.deepEqual(((body["messages"] as { content: unknown[] }[])[1] as { content: unknown[] }).content[0], JSON.parse(sig));
  });
});

// ---- stream ---------------------------------------------------------------------------------------------------

describe("stream", () => {
  test("text: events, usage, observed model, response id", async () => {
    const r = good(await run());
    assert.deepEqual(r.events.map((e) => e.type), ["started", "observed", "text.delta", "text.delta", "block.done", "usage"]);
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "Hello" }]);
    assert.equal(r.completed?.stop_reason, "end_turn");
    assert.deepEqual(r.completed?.observed, { model: "claude-sonnet-5-5-20260301", response_id: "msg_01" });
    assert.deepEqual([r.completed?.usage.input_tokens, r.completed?.usage.output_tokens], [25, 15]);
  });

  test("a tool call: arguments assembled from fragments (including an empty one)", async () => {
    const r = good(await run(replay(TOOL)));
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "Checking." }, { type: "tool_call", call_id: "toolu_01", name: "get_weather", args: { location: "San Francisco, CA" } }]);
    assert.equal(r.completed?.stop_reason, "tool_use");
  });

  test("a tool call with no arguments, and one with invalid JSON (kept as args_raw)", async () => {
    const none = good(await run(replay([start(), blockStart(0, { type: "tool_use", id: "t", name: "n", input: {} }), stop(0), end("tool_use")])));
    assert.deepEqual(none.completed?.blocks, [{ type: "tool_call", call_id: "t", name: "n", args: {} }]);
    const bad = good(await run(replay([start(), blockStart(0, { type: "tool_use", id: "t", name: "n", input: {} }), delta(0, { type: "input_json_delta", partial_json: '{"a": ' }), stop(0), end("max_tokens")])));
    assert.deepEqual(bad.completed?.blocks, [{ type: "tool_call", call_id: "t", name: "n", args: {}, args_raw: '{"a": ' }]);
    assert.equal(bad.completed?.stop_reason, "max_tokens");
  });

  test("thinking and redacted thinking are kept whole, and come back identically in the next request", async () => {
    const r = good(await run(replay(THINKING)));
    const [t, red, text] = r.completed?.blocks ?? [];
    assert.deepEqual(t, { type: "reasoning", provider: "main", payload: JSON.stringify({ type: "thinking", thinking: "Let me think.", signature: "EqQBCgIYAhIM" }), visible: "Let me think." });
    assert.deepEqual(red, { type: "reasoning", provider: "main", payload: JSON.stringify({ type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" }) });
    assert.deepEqual(text, { type: "text", text: "Done." });
    assert.equal(r.completed?.usage.reasoning_tokens, 22);
    const next = buildAnthropicBody(ctx({ turns: [{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", provider: "main", model: "m", blocks: r.completed?.blocks ?? [] }, { role: "user", parts: [{ type: "text", text: "q2" }] }] }), setupFor(), { cacheControl: false });
    const content = ((next["messages"] as { content: unknown[] }[])[1] as { content: unknown[] }).content;
    assert.deepEqual(content.slice(0, 2), [{ type: "thinking", thinking: "Let me think.", signature: "EqQBCgIYAhIM" }, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" }]);
  });

  test("unknown block types are skipped and noted; unknown events, deltas and fields are tolerated", async () => {
    const r = good(await run(replay([start(), blockStart(0, { type: "server_tool_use", id: "s", name: "web_search", input: {} }), delta(0, { type: "input_json_delta", partial_json: "{}" }), stop(0), ev("brand_new_event", { x: 1 }), blockStart(1, { type: "text", text: "", citations: [] }), delta(1, { type: "citations_delta", citation: {} }), delta(1, { type: "text_delta", text: "ok" }), stop(1), end("end_turn")])));
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "ok" }]);
    assert.deepEqual(r.completed?.ext, { skipped_block_types: ["server_tool_use"] });
  });

  test("stop reasons are normalised", async () => {
    for (const [given, want] of [["end_turn", "end_turn"], ["stop_sequence", "end_turn"], ["max_tokens", "max_tokens"], ["refusal", "refusal"], ["pause_turn", "pause"], ["model_context_window_exceeded", "model_context_window_exceeded"]] as const) {
      const r = good(await run(replay([start(), end(given)])));
      assert.equal(r.completed?.stop_reason, want, given);
    }
  });

  test("a server that revises its input count downwards (Ollama, seen live) still gives non-decreasing events", async () => {
    const r = good(await run(replay([start({ input_tokens: 189, output_tokens: 0 }), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "x" }), stop(0), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 25, cache_read_input_tokens: 33, output_tokens: 75 } }), ev("message_stop", {})])));
    assert.deepEqual([r.completed?.usage.input_tokens, r.completed?.usage.cache_read_tokens, r.completed?.usage.output_tokens], [25, 33, 75]);
  });

  test("cache writes are split by lifetime when the provider says", async () => {
    const r = good(await run(replay([start({ input_tokens: 10, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, output_tokens: 1 }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }), ev("message_stop", {})])));
    assert.equal(r.completed?.usage.cache_write_tokens, 300);
    assert.deepEqual(r.completed?.usage.cache_write_by_minutes, { "5": 100, "60": 200 });
  });

  test("usage is cumulative and carries the cache counts", async () => {
    const r = good(await run(replay([start({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 40, output_tokens: 1 }), ev("message_delta", { delta: {}, usage: { output_tokens: 20 } }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } }), ev("message_stop", {})])));
    assert.deepEqual([r.completed?.usage.input_tokens, r.completed?.usage.cache_read_tokens, r.completed?.usage.cache_write_tokens, r.completed?.usage.output_tokens], [10, 500, 40, 30]);
  });

  test("the result does not depend on how the bytes are cut", async () => {
    const baseline = await run(replay(THINKING));
    const rng = new Rng(3);
    for (let i = 0; i < 40; i++) {
      const sizes = Array.from({ length: 1 + rng.int(4) }, () => 1 + rng.int(30));
      assert.deepEqual(await run(replay(THINKING, sizes)), baseline, `sizes ${sizes}`);
    }
  });
});

describe("stream failures", () => {
  test("a stream that ends without message_stop, a message_stop without a stop reason, and malformed events are protocol errors", async () => {
    for (const events of [TEXT.slice(0, 4), [start(), ev("message_stop", {})], [start(), "event: content_block_start\ndata: {nope\n\n"], [start(), delta(3, { type: "text_delta", text: "x" })]]) {
      const r = await run(replay(events));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "protocol", events.join("").slice(0, 60));
      assert.deepEqual(conformanceProblems(r), []);
    }
  });

  test("an error event after content: kind and retryability from the error type; the complete blocks are kept", async () => {
    const r = await run(replay([start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "a" }), stop(0), blockStart(1, { type: "text", text: "" }), delta(1, { type: "text_delta", text: "b" }), ev("error", { error: { type: "overloaded_error", message: "Overloaded" } })]));
    assert.ok(r.error instanceof ProviderError && r.error.kind === "overloaded" && r.error.retryable && r.error.message === "overloaded_error: Overloaded");
    assert.deepEqual(r.error.partial, [{ type: "text", text: "a" }]);
    assert.deepEqual(conformanceProblems(r), []);
  });
});

// ---- over HTTP ------------------------------------------------------------------------------------------------

describe("HTTP", () => {
  const serve = async (script: Reply[], fn: (s: FakeServer) => Promise<void>): Promise<void> => {
    const server = await FakeServer.start(script);
    try {
      await fn(server);
    } finally {
      await server.close();
    }
  };
  const errBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

  test("the request: path, headers, key, body", async () => {
    await serve([{ acts: TEXT }], async (server) => {
      good(await collectStream(anthropicAdapter({ baseUrl: server.url, apiKey: KEY, betas: ["x-beta-1", "x-beta-2"], http: fast }).stream(req())));
      const seen = server.seen[0];
      assert.equal(seen?.url, "/v1/messages");
      assert.equal(seen?.headers["x-api-key"], KEY);
      assert.equal(seen?.headers["anthropic-version"], "2023-06-01");
      assert.equal(seen?.headers["anthropic-beta"], "x-beta-1,x-beta-2");
      const body = JSON.parse(seen?.body ?? "");
      assert.equal(body.stream, true);
      assert.ok(!seen?.body.includes("cache_control"), "no cache markers for a compatible server");
    });
  });

  test("bearer authorization, key from a function, no key at all", async () => {
    await serve([{ acts: TEXT }], async (server) => {
      await collectStream(anthropicAdapter({ baseUrl: server.url, apiKey: async () => KEY, authorization: "bearer", http: fast }).stream(req()));
      assert.equal(server.seen[0]?.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(server.seen[0]?.headers["x-api-key"], undefined);
      await collectStream(anthropicAdapter({ baseUrl: server.url, http: fast }).stream(req()));
      assert.equal(server.seen[1]?.headers["authorization"], undefined);
    });
  });

  test("cache markers are sent to api.anthropic.com and can be forced on elsewhere", async () => {
    await serve([{ acts: TEXT }], async (server) => {
      await collectStream(anthropicAdapter({ baseUrl: server.url, cacheControl: true, http: fast }).stream(req()));
      assert.ok(server.seen[0]?.body.includes("cache_control"));
    });
  });

  test("errors by status, with the provider's message, scrubbed; overload and rate limits are retried", async () => {
    await serve([{ status: 529, acts: [errBody("overloaded_error", "Overloaded")] }, { status: 429, headers: { "retry-after": "1" }, acts: [errBody("rate_limit_error", "slow")] }, { acts: TEXT }], async (server) => {
      good(await collectStream(anthropicAdapter({ baseUrl: server.url, apiKey: KEY, http: fast }).stream(req())));
      assert.equal(server.seen.length, 3);
    });
    for (const [status, type, kind, retryable] of [[401, "authentication_error", "auth", false], [400, "invalid_request_error", "invalid_request", false], [413, "request_too_large", "invalid_request", false], [500, "api_error", "server", true]] as const) {
      await serve([{ status, acts: [errBody(type, `bad ${KEY}`)] }], async (server) => {
        const r = await collectStream(anthropicAdapter({ baseUrl: server.url, apiKey: KEY, http: { ...fast, retry: { maxAttempts: 1 } } }).stream(req()));
        assert.ok(r.error instanceof ProviderError && r.error.kind === kind && r.error.retryable === retryable && r.error.status === status, `${status}`);
        assert.equal(r.error.message, `${status} ${type}: bad [redacted]`);
      });
    }
  });
});

describe("classify", () => {
  const m = (settings: Record<string, unknown>, id = "claude-sonnet-5-5", resolved?: string): AgentSetup => ({ ...emptySetup(), model: { provider: "main", id, ...(resolved === undefined ? {} : { resolved }), settings } });
  test("what breaks the cache", () => {
    const base = m({ max_output_tokens: 1, effort: "low" });
    assert.deepEqual(classifyAnthropic(base, m({ max_output_tokens: 99, effort: "low" })), [], "output cap and sampling are free");
    assert.deepEqual(classifyAnthropic(base, m({ max_output_tokens: 1, effort: "high" })).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyAnthropic(base, m({ max_output_tokens: 1, effort: "low", thinking: { type: "adaptive" } })).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyAnthropic(base, m({ max_output_tokens: 1, effort: "low" }, "claude-opus-5-5")).map((c) => c.kind), ["cache_break"]);
    const withTool = foldSetup([{ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: { provider: "main", id: "x" }, tools: { set: { a: { hash: "a".repeat(64), store: "blob" } } } }]);
    assert.deepEqual(classifyAnthropic(base, { ...base, tools: withTool.tools }).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyAnthropic(emptySetup(), base), []);
  });
});
