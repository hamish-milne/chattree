import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { leafTools } from "../../harness/starter/index.ts";
import { ToolRegistry } from "../../harness/tools.ts";
import { anthropicAdapter, buildAnthropicBody } from "../../providers/anthropic.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../../providers/conformance.ts";
import { replayFetch, type Fixture } from "../../providers/fixtures.ts";
import { buildChatBody, openaiCompatibleAdapter } from "../../providers/openai-compatible.ts";
import { buildResponsesBody, openaiResponsesAdapter } from "../../providers/openai-responses.ts";
import type { ProviderAdapter } from "../../providers/types.ts";

/**
 * What every adapter must do with tools (docs/tools.md, 3.6), checked with the real starter definitions:
 * definitions pass through unchanged, several calls in one response come out as several blocks with unique ids,
 * and several results go back in the form each API needs.
 */

const defs = new ToolRegistry(leafTools()).definitions();
const setupFor = (): AgentSetup => ({ ...emptySetup(), model: { provider: "p", id: "m", settings: { max_output_tokens: 256 } } });
const ctx = (over: Partial<ModelContext> = {}): ModelContext => ({ system: "S", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "go" }] }], tools: defs, cacheHints: [], ...over });
const fast = { retry: { baseMs: 1, jitter: (ms: number) => ms }, sleep: async () => {} };
const fixture = (events: string[]): Fixture => ({ version: 1, response: { status: 200, headers: { "content-type": "text/event-stream" }, body: events.join("") } });
const play = (a: ProviderAdapter): Promise<StreamRun> => collectStream(a.stream({ context: ctx(), setup: setupFor(), signal: new AbortController().signal }));

// ---- scripted responses: two calls in one response, one with empty arguments, one with broken JSON ------------------

const ant = (name: string, data: object): string => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
const anthropicTwoCalls = [
  ant("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "claude-x", stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }),
  ant("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "read", input: {} } }),
  ant("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"files":[{"path":"a.txt"}]}' } }),
  ant("content_block_stop", { index: 0 }),
  ant("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_b", name: "run", input: {} } }),
  ant("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls' } }),
  ant("content_block_stop", { index: 1 }),
  ant("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
  ant("message_stop", {}),
];

let seq = 0;
const rs = (type: string, data: object = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: ++seq })}\n\n`;
const fn = (id: string, call_id: string, name: string, args: string) => ({ id, type: "function_call", status: "completed", call_id, name, arguments: args });
const resp = (extra: object = {}) => ({ id: "resp_1", object: "response", model: "gpt-x", status: "in_progress", store: true, output: [], ...extra });
const responsesTwoCalls = [
  rs("response.created", { response: resp() }),
  rs("response.output_item.added", { output_index: 0, item: { id: "fc_a", type: "function_call", call_id: "call_a", name: "read" } }),
  rs("response.output_item.done", { output_index: 0, item: fn("fc_a", "call_a", "read", '{"files":[{"path":"a.txt"}]}') }),
  rs("response.output_item.added", { output_index: 1, item: { id: "fc_b", type: "function_call", call_id: "call_b", name: "run" } }),
  rs("response.output_item.done", { output_index: 1, item: fn("fc_b", "call_b", "run", '{"command":"ls') }),
  rs("response.completed", { response: resp({ status: "completed", usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 }, output: [] }) }),
];

const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const compatTwoCalls = [
  // a server that sends no ids at all
  chunk({ tool_calls: [{ index: 0, function: { name: "read", arguments: '{"files":[{"path":"a.txt"}]}' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { name: "run", arguments: '{"command":"ls' } }] }),
  chunk({}, "tool_calls"),
  "data: [DONE]\n\n",
];

const FLAVOURS: { name: string; adapter: (events: string[]) => ProviderAdapter }[] = [
  { name: "anthropic", adapter: (e) => anthropicAdapter({ baseUrl: "https://api.anthropic.com", apiKey: "k", http: { fetch: replayFetch(fixture(e), [Number.MAX_SAFE_INTEGER]), ...fast } }) },
  { name: "openai-responses", adapter: (e) => openaiResponsesAdapter({ apiKey: "k", http: { fetch: replayFetch(fixture(e), [Number.MAX_SAFE_INTEGER]), ...fast } }) },
  { name: "openai-compatible", adapter: (e) => openaiCompatibleAdapter({ baseUrl: "http://localhost:1/v1", apiKey: "k", http: { fetch: replayFetch(fixture(e), [Number.MAX_SAFE_INTEGER]), ...fast } }) },
];
const SCRIPTS: Record<string, string[]> = { anthropic: anthropicTwoCalls, "openai-responses": responsesTwoCalls, "openai-compatible": compatTwoCalls };

describe("the starter definitions through each flavour", () => {
  test("every definition arrives unchanged: name, description and the schema as given", () => {
    const a = buildAnthropicBody(ctx(), setupFor(), { cacheControl: false })["tools"] as Record<string, unknown>[];
    const r = buildResponsesBody(ctx(), setupFor(), { store: true, replayItemIds: true, chain: true, pruneAtCompaction: true })["tools"] as Record<string, unknown>[];
    const c = buildChatBody(ctx(), setupFor(), { maxTokensParam: "max_tokens", includeUsage: true })["tools"] as { function: Record<string, unknown> }[];
    assert.equal(defs.length, 5);
    defs.forEach((d, i) => {
      assert.deepEqual(a[i], { name: d.name, description: d.description, input_schema: d.input_schema });
      assert.deepEqual(r[i], { type: "function", name: d.name, description: d.description, parameters: d.input_schema, strict: false });
      assert.deepEqual(c[i]?.function, { name: d.name, description: d.description, parameters: d.input_schema });
    });
  });
});

describe("several calls in one response", () => {
  for (const f of FLAVOURS) {
    test(`${f.name}: separate blocks, in order, unique ids, stop reason tool_use; broken arguments kept as args_raw`, async () => {
      const r = await play(f.adapter(SCRIPTS[f.name] as string[]));
      assert.deepEqual(conformanceProblems(r), []);
      assert.equal(r.error, undefined);
      const calls = (r.completed?.blocks ?? []).filter((b) => b.type === "tool_call");
      assert.deepEqual(calls.map((c) => c.name), ["read", "run"]);
      assert.equal(new Set(calls.map((c) => c.call_id)).size, 2);
      assert.ok(calls.every((c) => c.call_id !== ""));
      assert.deepEqual(calls[0]?.args, { files: [{ path: "a.txt" }] });
      assert.equal(calls[1]?.args_raw, '{"command":"ls');
      assert.deepEqual(calls[1]?.args, {});
      assert.equal(r.completed?.stop_reason, "tool_use");
    });
  }
});

describe("several results for one assistant turn", () => {
  const turns: ModelContext["turns"] = [
    { role: "user", parts: [{ type: "text", text: "go" }] },
    { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "c1", name: "read", args: {} }, { type: "tool_call", call_id: "c2", name: "run", args: {} }] },
    { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "fine", truncated: false }, { call_id: "c2", is_error: true, content: "exit 1", truncated: false }] },
  ];
  test("anthropic: one user message holding both results, the failed one flagged", () => {
    const m = (buildAnthropicBody(ctx({ turns }), setupFor(), { cacheControl: false })["messages"] as { role: string; content: Record<string, unknown>[] }[]).at(-1);
    assert.equal(m?.role, "user");
    assert.deepEqual(m?.content.map((c) => [c["tool_use_id"], c["is_error"]]), [["c1", undefined], ["c2", true]]);
  });
  test("openai-responses: one function_call_output each (the API has no error flag, so the text carries it)", () => {
    const input = buildResponsesBody(ctx({ turns }), setupFor(), { store: false, replayItemIds: true, chain: false, pruneAtCompaction: true })["input"] as Record<string, unknown>[];
    assert.deepEqual(input.slice(-2), [{ type: "function_call_output", call_id: "c1", output: "fine" }, { type: "function_call_output", call_id: "c2", output: "exit 1" }]);
  });
  test("openai-compatible: one tool message each, in call order", () => {
    const msgs = buildChatBody(ctx({ turns }), setupFor(), { maxTokensParam: "max_tokens", includeUsage: true })["messages"] as Record<string, unknown>[];
    assert.deepEqual(msgs.slice(-2), [{ role: "tool", tool_call_id: "c1", content: "fine" }, { role: "tool", tool_call_id: "c2", content: "exit 1" }]);
  });
});
