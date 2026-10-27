import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../../providers/conformance.ts";
import { replayFetch, type Fixture } from "../../providers/fixtures.ts";
import { buildResponsesBody, classifyOpenAI, openaiResponsesAdapter, parseOpenAISettings } from "../../providers/openai-responses.ts";
import { ProviderError } from "../../providers/types.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { Rng } from "../support/gen.ts";

const KEY = "sk-proj-SECRET-key";
let seq = 0;
const ev = (type: string, data: object = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: ++seq })}\n\n`;
const resp = (extra: object = {}) => ({ id: "resp_01", object: "response", model: "gpt-5.4-2026-03-05", status: "in_progress", store: true, output: [], ...extra });
const created = () => ev("response.created", { response: resp() }) + ev("response.in_progress", { response: resp() });
const usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 150 };
const completed = (extra: object = {}) => ev("response.completed", { response: resp({ status: "completed", usage, ...extra }) });
const fixture = (events: string[], status = 200): Fixture => ({ version: 1, response: { status, headers: { "content-type": "text/event-stream" }, body: events.join("") } });

const messageItem = (text: string) => ({ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const TEXT = [
  created(),
  ev("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } }),
  ev("response.content_part.added", { item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
  ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" }),
  ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" }),
  ev("response.output_text.done", { item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello" }),
  ev("response.output_item.done", { output_index: 0, item: messageItem("Hello") }),
  completed(),
];
const REASONING_ITEM = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Thinking it over." }], encrypted_content: "gAAAA-ENCRYPTED" };
const FN_ITEM = { id: "fc_1", type: "function_call", status: "completed", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' };
const TOOL = [
  created(),
  ev("response.output_item.added", { output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
  ev("response.reasoning_summary_part.added", { item_id: "rs_1", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } }),
  ev("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "Thinking " }),
  ev("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "it over." }),
  ev("response.output_item.done", { output_index: 0, item: REASONING_ITEM }),
  ev("response.output_item.added", { output_index: 1, item: { id: "fc_1", type: "function_call", status: "in_progress", call_id: "call_1", name: "get_weather", arguments: "" } }),
  ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 1, delta: '{"city":' }),
  ev("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 1, delta: '"SF"}' }),
  ev("response.function_call_arguments.done", { item_id: "fc_1", output_index: 1, arguments: '{"city":"SF"}' }),
  ev("response.output_item.done", { output_index: 1, item: FN_ITEM }),
  completed(),
];

const setupFor = (settings: Record<string, unknown> = { max_output_tokens: 1000 }): AgentSetup => ({ ...emptySetup(), model: { provider: "main", id: "gpt-5.4", settings } });
const ctx = (over: Partial<ModelContext> = {}): ModelContext => ({ system: "SYS", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [], ...over });
const req = (c: ModelContext = ctx(), setup = setupFor(), signal = new AbortController().signal) => ({ context: c, setup, signal });
const fast = { retry: { baseMs: 1, jitter: (ms: number) => ms }, sleep: async () => {} };
const replay = (events: string[], sizes: readonly number[] = [Number.MAX_SAFE_INTEGER], status = 200) => openaiResponsesAdapter({ apiKey: KEY, http: { fetch: replayFetch(fixture(events, status), sizes), ...fast } });
const run = (a = replay(TEXT), c = ctx(), setup = setupFor()): Promise<StreamRun> => collectStream(a.stream(req(c, setup)));
const good = (r: StreamRun): StreamRun => {
  assert.deepEqual(conformanceProblems(r, { secrets: [KEY] }), []);
  assert.equal(r.error, undefined);
  return r;
};
const opts = { store: true, replayItemIds: true, chain: true, pruneAtCompaction: true };

describe("settings", () => {
  test("accepted and refused", () => {
    assert.equal(parseOpenAISettings({ max_output_tokens: 5, effort: "low", reasoning_summary: "detailed", extra: { think: true } }).effort, "low");
    for (const bad of [{}, { max_output_tokens: 5, effrot: 1 }, { max_output_tokens: 5, reasoning_summary: "full" }, { max_output_tokens: 5.5 }]) {
      assert.throws(() => parseOpenAISettings(bad), (e) => e instanceof ProviderError && e.kind === "invalid_request", JSON.stringify(bad));
    }
  });
});

describe("request body", () => {
  const turns: ModelContext["turns"] = [
    { role: "user", parts: [{ type: "text", text: "weather?" }] },
    { role: "assistant", provider: "main", model: "gpt-5.4", blocks: [{ type: "reasoning", provider: "main", payload: REASONING_ITEM, visible: "Thinking it over." }, { type: "text", text: "Let me look.", ext: { item_id: "msg_1" } }, { type: "tool_call", call_id: "call_1", name: "get_weather", args: { city: "SF" }, ext: { item_id: "fc_1" } }, { type: "tool_call", call_id: "call_2", name: "broken", args: {}, args_raw: '{"a": ' }] },
    { role: "tool_results", results: [{ call_id: "call_1", is_error: false, content: "sunny", truncated: false }, { call_id: "call_2", is_error: true, content: "bad", truncated: false }] },
    { role: "user", parts: [{ type: "text", text: "thanks" }] },
  ];

  test("instructions, tools, input items; reasoning replayed verbatim; ids kept", () => {
    const body = buildResponsesBody(ctx({ instructions: "INSTR", turns, tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object" } }] }), setupFor({ max_output_tokens: 2000, effort: "low", temperature: 0.3, extra: { think: true, model: "evil", store: false } }), opts);
    assert.deepEqual(body, {
      model: "gpt-5.4",
      stream: true,
      store: true,
      max_output_tokens: 2000,
      instructions: "SYS\n\nINSTR",
      input: [
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
        REASONING_ITEM,
        { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Let me look.", annotations: [] }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}', status: "completed" },
        { type: "function_call", call_id: "call_2", name: "broken", arguments: '{"a": ', status: "completed" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
        { type: "function_call_output", call_id: "call_2", output: "bad" },
        { role: "user", content: [{ type: "input_text", text: "thanks" }] },
      ],
      tools: [{ type: "function", name: "get_weather", description: "Weather", parameters: { type: "object" }, strict: false }],
      reasoning: { summary: "auto", effort: "low" },
      include: ["reasoning.encrypted_content"],
      temperature: 0.3,
      think: true,
    });
  });

  test("opt-out of storage, of item ids, and of reasoning", () => {
    const off = buildResponsesBody(ctx({ turns }), setupFor({ max_output_tokens: 5, reasoning: false }), { store: false, replayItemIds: false, chain: true, pruneAtCompaction: true });
    assert.equal(off["store"], false);
    assert.ok(!("reasoning" in off) && !("include" in off));
    const input = JSON.stringify(off["input"]);
    assert.ok(!input.includes('"id":"msg_1"') && !input.includes('"id":"fc_1"'));
    assert.ok(input.includes("gAAAA-ENCRYPTED"), "reasoning items are replayed as they are");
    assert.deepEqual(buildResponsesBody(ctx(), setupFor({ max_output_tokens: 5, reasoning: false, effort: "none" }), opts)["reasoning"], { effort: "none" });
  });

  test("no instructions and no tools leave those fields out; the dated model is used once known; bad requests never reach the network", async () => {
    const body = buildResponsesBody(ctx({ system: "" }), { ...setupFor(), model: { provider: "main", id: "gpt-5.4", resolved: "gpt-5.4-2026-03-05", settings: { max_output_tokens: 5 } } }, opts);
    assert.ok(!("instructions" in body) && !("tools" in body));
    assert.equal(body["model"], "gpt-5.4-2026-03-05");
    const r = await collectStream(replay(TEXT).stream(req(ctx(), emptySetup())));
    assert.ok(r.error instanceof ProviderError && r.error.kind === "invalid_request");
    const body2 = buildResponsesBody(ctx({ turns: [{ role: "user", parts: [{ type: "attachment", kind: "image", name: "a.png", mime: "image/png", sha256: "a".repeat(64), bytes: new Uint8Array([1, 2, 3]) }, { type: "attachment", kind: "pdf", name: "r.pdf", mime: "application/pdf", sha256: "b".repeat(64), bytes: new Uint8Array([4, 5]) }] }] }), setupFor(), opts);
    assert.deepEqual((body2["input"] as { content: unknown[] }[])[0]?.content, [
      { type: "input_image", image_url: "data:image/png;base64,AQID" },
      { type: "input_file", filename: "r.pdf", file_data: "data:application/pdf;base64,BAU=" },
    ]);
  });
});

describe("cache lifetime", () => {
  test("cache_ttl becomes prompt_cache_options.ttl; unset leaves it out; other values are refused", () => {
    assert.deepEqual(buildResponsesBody(ctx(), setupFor({ max_output_tokens: 5, cache_ttl: "12h" }), opts)["prompt_cache_options"], { ttl: "12h" });
    assert.ok(!("prompt_cache_options" in buildResponsesBody(ctx(), setupFor(), opts)));
    assert.throws(() => parseOpenAISettings({ max_output_tokens: 5, cache_ttl: "1h" }), (e) => e instanceof ProviderError);
    assert.equal(buildResponsesBody(ctx(), setupFor({ max_output_tokens: 5, extra: { prompt_cache_options: { ttl: "x" }, prompt_cache_retention: "24h" } }), opts)["prompt_cache_retention"], "24h", "the older parameter goes through extra");
  });

  test("usage splits cache writes by lifetime when the server says", async () => {
    const withWrites = { input_tokens: 1000, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 300, cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 200 } }, output_tokens: 5 };
    const r = good(await run(replay([created(), ev("response.output_item.added", { output_index: 0, item: { id: "m", type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 0, delta: "x" }), ev("response.output_item.done", { output_index: 0, item: messageItem("x") }), completed({ usage: withWrites })])));
    const u = r.completed?.usage;
    assert.deepEqual([u?.input_tokens, u?.cache_read_tokens, u?.cache_write_tokens], [600, 100, 300]);
    assert.deepEqual(u?.cache_write_by_minutes, { "30": 100, "720": 200 });
  });
});

describe("stream", () => {
  test("text: events, usage normalised (cached tokens separate), observed model and response id", async () => {
    const r = good(await run());
    assert.deepEqual(r.events.map((e) => e.type), ["started", "observed", "text.delta", "text.delta", "block.done", "usage"]);
    assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "Hello", ext: { item_id: "msg_1" } }]);
    assert.equal(r.completed?.stop_reason, "end_turn");
    assert.deepEqual(r.completed?.observed, { model: "gpt-5.4-2026-03-05", response_id: "resp_01" });
    const u = r.completed?.usage;
    assert.deepEqual([u?.input_tokens, u?.cache_read_tokens, u?.output_tokens, u?.reasoning_tokens], [20, 100, 30, 12]);
    assert.equal(r.completed?.ext?.["response_id"], "resp_01");
    assert.equal(r.completed?.ext?.["store"], true);
    assert.match(String(r.completed?.ext?.["prefix_digest"]), /^[0-9a-f]{64}$/);
    assert.ok(!("chained" in (r.completed?.ext ?? {})));
  });

  test("reasoning item kept whole; a function call with its ids; stop reason tool_use; both replay in the next request", async () => {
    const r = good(await run(replay(TOOL)));
    assert.deepEqual(r.completed?.blocks, [
      { type: "reasoning", provider: "main", payload: REASONING_ITEM, visible: "Thinking it over." },
      { type: "tool_call", call_id: "call_1", name: "get_weather", args: { city: "SF" }, ext: { item_id: "fc_1" } },
    ]);
    assert.equal(r.completed?.stop_reason, "tool_use");
    assert.deepEqual(r.events.filter((e) => e.type === "reasoning.delta").map((e) => (e as { text: string }).text).join(""), "Thinking it over.");
    const next = buildResponsesBody(ctx({ turns: [{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", provider: "main", model: "m", blocks: r.completed?.blocks ?? [] }, { role: "tool_results", results: [{ call_id: "call_1", is_error: false, content: "sunny", truncated: false }] }] }), setupFor(), opts);
    const input = next["input"] as Record<string, unknown>[];
    assert.deepEqual(input[1], REASONING_ITEM);
    assert.deepEqual(input[2], { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}', status: "completed" });
  });

  test("a server that never sends output_item.done: blocks are closed from what streamed", async () => {
    const r = good(await run(replay([created(), ev("response.output_item.added", { output_index: 0, item: { id: "rs_9", type: "reasoning", summary: [] } }), ev("response.reasoning_summary_text.delta", { output_index: 0, delta: "hm" }), ev("response.output_item.added", { output_index: 1, item: { id: "msg_9", type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 1, delta: "ok" }), ev("response.output_item.added", { output_index: 2, item: { id: "fc_9", type: "function_call", call_id: "c9", name: "n" } }), ev("response.function_call_arguments.delta", { output_index: 2, delta: '{"a":1}' }), completed()])));
    assert.deepEqual(r.completed?.blocks.map((b) => b.type), ["reasoning", "text", "tool_call"]);
    assert.deepEqual((r.completed?.blocks[2] as { args: unknown }).args, { a: 1 });
    assert.equal((r.completed?.blocks[0] as { visible?: string }).visible, "hm");
    assert.equal(r.completed?.stop_reason, "tool_use");
  });

  test("response.incomplete: max_output_tokens and content_filter; refusals; unknown output items and events are tolerated", async () => {
    const inc = (reason: string) => [created(), ev("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 0, delta: "par" }), ev("response.output_item.done", { output_index: 0, item: messageItem("par") }), ev("response.incomplete", { response: resp({ status: "incomplete", incomplete_details: { reason }, usage }) })];
    assert.equal(good(await run(replay(inc("max_output_tokens")))).completed?.stop_reason, "max_tokens");
    assert.equal(good(await run(replay(inc("content_filter")))).completed?.stop_reason, "refusal");
    const refusal = good(await run(replay([created(), ev("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", content: [] } }), ev("response.refusal.delta", { output_index: 0, delta: "No." }), ev("response.output_item.done", { output_index: 0, item: { ...messageItem(""), content: [{ type: "refusal", refusal: "No." }] } }), completed()])));
    assert.equal(refusal.completed?.stop_reason, "refusal");
    assert.equal((refusal.completed?.blocks[0] as { text: string }).text, "No.");
    const odd = good(await run(replay([created(), ev("response.output_item.added", { output_index: 0, item: { id: "ws_1", type: "web_search_call" } }), ev("response.web_search_call.in_progress", { output_index: 0 }), ev("response.output_item.done", { output_index: 0, item: { id: "ws_1", type: "web_search_call" } }), ev("something.new", {}), "data: [DONE]\n\n", completed()])));
    assert.deepEqual(odd.completed?.blocks, []);
  });

  test("invalid function arguments are kept as args_raw", async () => {
    const r = good(await run(replay([created(), ev("response.output_item.added", { output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "c", name: "n" } }), ev("response.output_item.done", { output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "c", name: "n", arguments: '{"a": ' } }), completed()])));
    assert.deepEqual(r.completed?.blocks, [{ type: "tool_call", call_id: "c", name: "n", args: {}, args_raw: '{"a": ', ext: { item_id: "fc_1" } }]);
  });

  test("the result does not depend on how the bytes are cut", async () => {
    const baseline = await run(replay(TOOL));
    const rng = new Rng(5);
    for (let i = 0; i < 40; i++) {
      const sizes = Array.from({ length: 1 + rng.int(4) }, () => 1 + rng.int(40));
      assert.deepEqual(await run(replay(TOOL, sizes)), baseline, `sizes ${sizes}`);
    }
  });
});

describe("stream failures", () => {
  test("response.failed and error events: kind and retryability from the code; partial blocks kept", async () => {
    const start = [created(), ev("response.output_item.added", { output_index: 0, item: { id: "msg_1", type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 0, delta: "a" }), ev("response.output_item.done", { output_index: 0, item: messageItem("a") })];
    const failed = await run(replay([...start, ev("response.failed", { response: resp({ status: "failed", error: { code: "server_error", message: "boom" } }) })]));
    assert.ok(failed.error instanceof ProviderError && failed.error.kind === "server" && failed.error.retryable && failed.error.message === "server_error: boom");
    assert.equal(failed.error.partial.length, 1);
    assert.deepEqual(conformanceProblems(failed), []);
    const quota = await run(replay([...start, ev("error", { code: "insufficient_quota", message: "no money", param: null })]));
    assert.ok(quota.error instanceof ProviderError && quota.error.kind === "rate_limit" && !quota.error.retryable);
  });

  test("a stream that ends before response.completed, and malformed events, are protocol errors", async () => {
    for (const events of [TEXT.slice(0, 5), [created(), "event: response.output_text.delta\ndata: {nope\n\n"]]) {
      const r = await run(replay(events));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "protocol");
      assert.deepEqual(conformanceProblems(r), []);
    }
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
  const errBody = (code: string, message: string) => JSON.stringify({ error: { message, type: "x", code } });

  test("path, bearer key, body; storage opt-out", async () => {
    await serve([{ acts: TEXT }], async (server) => {
      good(await collectStream(openaiResponsesAdapter({ baseUrl: `${server.url}/v1`, apiKey: KEY, store: false, http: fast }).stream(req())));
      const seen = server.seen[0];
      assert.equal(seen?.url, "/v1/responses");
      assert.equal(seen?.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(JSON.parse(seen?.body ?? "").store, false);
    });
  });

  test("errors by status and code, scrubbed; rate limits retried, exhausted quota not", async () => {
    await serve([{ status: 429, acts: [errBody("rate_limit_exceeded", "slow")] }, { acts: TEXT }], async (server) => {
      good(await collectStream(openaiResponsesAdapter({ baseUrl: server.url, apiKey: KEY, http: fast }).stream(req())));
      assert.equal(server.seen.length, 2);
    });
    for (const [status, code, kind, retryable] of [[429, "insufficient_quota", "rate_limit", false], [401, "invalid_api_key", "auth", false], [400, "context_length_exceeded", "invalid_request", false], [500, "server_error", "server", true]] as const) {
      await serve([{ status, acts: [errBody(code, `bad ${KEY}`)] }], async (server) => {
        const r = await collectStream(openaiResponsesAdapter({ baseUrl: server.url, apiKey: KEY, http: { ...fast, retry: { maxAttempts: 1 } } }).stream(req()));
        assert.ok(r.error instanceof ProviderError && r.error.kind === kind && r.error.retryable === retryable, `${status} ${code}`);
        assert.equal(r.error.message, `${status} ${code}: bad [redacted]`);
      });
    }
  });
});

describe("classify", () => {
  const m = (settings: Record<string, unknown>, id = "gpt-5.4"): AgentSetup => ({ ...emptySetup(), model: { provider: "main", id, settings } });
  test("what breaks the cache", () => {
    const base = m({ max_output_tokens: 1, effort: "low" });
    assert.deepEqual(classifyOpenAI(base, m({ max_output_tokens: 9, effort: "low", temperature: 1 })), []);
    assert.deepEqual(classifyOpenAI(base, m({ max_output_tokens: 1, effort: "high" })).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyOpenAI(base, m({ max_output_tokens: 1, effort: "low" }, "gpt-5.4-mini")).map((c) => c.kind), ["cache_break"]);
    assert.deepEqual(classifyOpenAI(emptySetup(), base), []);
  });
});
