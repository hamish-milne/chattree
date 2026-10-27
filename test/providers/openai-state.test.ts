import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildContext, type ModelContext, type Turn } from "../../harness/context-builder.ts";
import { toEntryBlocks } from "../../harness/blocks.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { collectStream, conformanceProblems } from "../../providers/conformance.ts";
import { buildResponsesBody, openaiResponsesAdapter, planChain, type OpenAIResponsesOptions } from "../../providers/openai-responses.ts";
import { ProviderError, type Completed } from "../../providers/types.ts";
import { FakeServer, type Reply, type Seen } from "../support/fake-server.ts";

const KEY = "sk-proj-SECRET-key";
let seq = 0;
const ev = (type: string, data: object = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: ++seq })}\n\n`;
const resp = (id: string, extra: object = {}) => ({ id, object: "response", model: "gpt-5.4-2026-03-05", status: "in_progress", store: true, output: [], ...extra });
const usage = { input_tokens: 50, output_tokens: 10 };
const msg = (id: string, text: string) => ({ id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

/** A reply that streams one message (and optionally a function call or compaction item) as response `id`. */
const reply = (id: string, text: string, more: { call?: boolean; compaction?: boolean; store?: boolean } = {}): Reply => {
  const store = more.store ?? true;
  const acts = [ev("response.created", { response: resp(id, { store }) }), ev("response.output_item.added", { output_index: 0, item: { id: `${id}_m`, type: "message", content: [] } }), ev("response.output_text.delta", { output_index: 0, delta: text }), ev("response.output_item.done", { output_index: 0, item: msg(`${id}_m`, text) })];
  let n = 1;
  if (more.compaction) acts.push(ev("response.output_item.added", { output_index: n, item: { id: `${id}_c`, type: "compaction" } }), ev("response.output_item.done", { output_index: n++, item: { id: `${id}_c`, type: "compaction", encrypted_content: "gAAAA-COMPACT" } }));
  if (more.call) acts.push(ev("response.output_item.added", { output_index: n, item: { id: `${id}_f`, type: "function_call", call_id: `${id}_call`, name: "lookup" } }), ev("response.output_item.done", { output_index: n++, item: { id: `${id}_f`, type: "function_call", call_id: `${id}_call`, name: "lookup", arguments: "{}" } }));
  acts.push(ev("response.completed", { response: resp(id, { status: "completed", store, usage }) }));
  return { acts };
};

const setupFor = (settings: Record<string, unknown> = { max_output_tokens: 100 }, id = "gpt-5.4"): AgentSetup => ({ ...emptySetup(), model: { provider: "main", id, settings } });
const user = (text: string): Turn => ({ role: "user", parts: [{ type: "text", text }] });
const ctx = (turns: Turn[], over: Partial<ModelContext> = {}): ModelContext => ({ system: "SYS", instructions: "INSTR", turns, tools: [{ name: "lookup", description: "d", input_schema: { type: "object" } }], cacheHints: [], ...over });
const asTurn = (c: Completed, over: Partial<Extract<Turn, { role: "assistant" }>> = {}): Turn => ({ role: "assistant", provider: "main", model: "gpt-5.4", blocks: c.blocks, ...(c.ext === undefined ? {} : { ext: c.ext }), ...over });
const fast = { retry: { baseMs: 1, jitter: (ms: number) => ms }, sleep: async () => {} };

const withServer = async (script: Reply[] | ((n: number, s: Seen) => Reply), fn: (server: FakeServer, make: (o?: OpenAIResponsesOptions) => ReturnType<typeof openaiResponsesAdapter>) => Promise<void>): Promise<void> => {
  const server = await FakeServer.start(script);
  try {
    await fn(server, (o = {}) => openaiResponsesAdapter({ baseUrl: `${server.url}/v1`, apiKey: KEY, http: fast, ...o }));
  } finally {
    await server.close();
  }
};
const go = async (a: ReturnType<typeof openaiResponsesAdapter>, c: ModelContext, setup = setupFor()): Promise<Completed> => {
  const run = await collectStream(a.stream({ context: c, setup, signal: new AbortController().signal }));
  assert.deepEqual(conformanceProblems(run, { secrets: [KEY] }), []);
  if (run.error !== undefined) throw run.error;
  return run.completed as Completed;
};
const bodyOf = (s: Seen | undefined): Record<string, unknown> => JSON.parse(s?.body ?? "{}") as Record<string, unknown>;

describe("chaining", () => {
  test("the second request continues the first: only new items, instructions and tools still sent", async () => {
    await withServer([reply("resp_1", "Hello"), reply("resp_2", "Again")], async (server, make) => {
      const a = make();
      const t1 = [user("hi")];
      const c1 = await go(a, ctx(t1));
      assert.equal(bodyOf(server.seen[0])["previous_response_id"], undefined);
      assert.equal(c1.ext?.["store"], true);
      const c2 = await go(a, ctx([...t1, asTurn(c1), user("more")]));
      const second = bodyOf(server.seen[1]);
      assert.equal(second["previous_response_id"], "resp_1");
      assert.deepEqual(second["input"], [{ role: "user", content: [{ type: "input_text", text: "more" }] }]);
      assert.equal(second["instructions"], "SYS\n\nINSTR");
      assert.ok(Array.isArray(second["tools"]));
      assert.equal(c2.ext?.["chained"], true);
      // and a third continues the second
      await go(a, ctx([...t1, asTurn(c1), user("more"), asTurn(c2), user("third")]));
      assert.equal(bodyOf(server.seen[2])["previous_response_id"], "resp_2");
    });
  });

  test("a tool loop chains with only the function outputs", async () => {
    await withServer([reply("resp_1", "Looking", { call: true }), reply("resp_2", "Done")], async (server, make) => {
      const a = make();
      const c1 = await go(a, ctx([user("go")]));
      await go(a, ctx([user("go"), asTurn(c1), { role: "tool_results", results: [{ call_id: "resp_1_call", is_error: false, content: "found", truncated: false }] }]));
      assert.deepEqual(bodyOf(server.seen[1])["input"], [{ type: "function_call_output", call_id: "resp_1_call", output: "found" }]);
    });
  });

  test("whenever the prefix is not provably the same, everything is replayed", async () => {
    await withServer([reply("resp_1", "Hello")], async (_server, make) => {
      const c1 = await go(make(), ctx([user("hi")]));
      const next = (over: Partial<Extract<Turn, { role: "assistant" }>> = {}, first: Turn = user("hi")): ModelContext => ctx([first, asTurn(c1, over), user("more")]);
      const opts = { store: true, replayItemIds: true, chain: true, pruneAtCompaction: true };
      const plan = (c: ModelContext, setup = setupFor()) => planChain(c, setup, opts);
      assert.equal(plan(next())?.previous_response_id, "resp_1");
      assert.equal(plan(next({}, user("hi, edited"))), undefined, "history was edited");
      assert.equal(plan(next({ provider: "other" })), undefined, "another provider's response");
      assert.equal(plan(next(), setupFor(undefined, "gpt-5.4-mini")), undefined, "another model");
      assert.equal(plan(next({ blocks: [{ type: "text", text: "tampered" }] })), undefined, "the assistant turn is not what the response produced");
      const noExt = { ...asTurn(c1) } as Extract<Turn, { role: "assistant" }>;
      delete noExt.ext;
      assert.equal(plan(ctx([user("hi"), noExt, user("more")])), undefined, "no response id");
      assert.equal(plan(ctx([user("hi"), asTurn(c1)])), undefined, "nothing new to send");
      assert.equal(planChain(next(), setupFor(), { ...opts, chain: false }), undefined);
      assert.equal(planChain(next(), setupFor(), { ...opts, store: false }), undefined);
      // an interrupted turn after the response (no ext) means the latest assistant turn is not that response
      assert.equal(plan(ctx([user("hi"), asTurn(c1), user("more"), { role: "assistant", provider: "", model: "", blocks: [{ type: "text", text: "cut" }] }, user("x")])), undefined);
    });
  });

  test("a server that does not confirm storage is never chained (Ollama)", async () => {
    await withServer([reply("resp_1", "Hello", { store: false }), reply("resp_2", "Again")], async (server, make) => {
      const a = make();
      const c1 = await go(a, ctx([user("hi")]));
      assert.equal(c1.ext?.["store"], false);
      assert.ok(!("prefix_digest" in (c1.ext ?? {})));
      await go(a, ctx([user("hi"), asTurn(c1), user("more")]));
      const second = bodyOf(server.seen[1]);
      assert.equal(second["previous_response_id"], undefined);
      assert.equal((second["input"] as unknown[]).length, 3);
    });
  });

  test("options turn chaining off", async () => {
    for (const o of [{ chain: false }, { store: false }]) {
      await withServer([reply("resp_1", "Hello"), reply("resp_2", "Again")], async (server, make) => {
        const a = make(o);
        const c1 = await go(a, ctx([user("hi")]));
        await go(a, ctx([user("hi"), asTurn(c1), user("more")]));
        assert.equal(bodyOf(server.seen[1])["previous_response_id"], undefined, JSON.stringify(o));
      });
    }
  });

  test("an expired id falls back to a full replay, once, without the caller seeing the failure", async () => {
    const gone: Reply = { status: 400, acts: [JSON.stringify({ error: { message: "Previous response with id 'resp_1' not found.", type: "invalid_request_error", param: "previous_response_id", code: "previous_response_not_found" } })] };
    await withServer((n, s) => (n === 0 ? reply("resp_1", "Hello") : s.body.includes("previous_response_id") ? gone : reply("resp_3", "Recovered")), async (server, make) => {
      const a = make();
      const c1 = await go(a, ctx([user("hi")]));
      const c2 = await go(a, ctx([user("hi"), asTurn(c1), user("more")]));
      assert.equal(server.seen.length, 3);
      assert.equal(bodyOf(server.seen[1])["previous_response_id"], "resp_1");
      assert.equal(bodyOf(server.seen[2])["previous_response_id"], undefined);
      assert.equal((bodyOf(server.seen[2])["input"] as unknown[]).length, 3);
      assert.equal(c2.observed.response_id, "resp_3");
      assert.ok(!("chained" in (c2.ext ?? {})));
    });
  });

  test("other invalid requests on a chained request are not retried", async () => {
    const bad: Reply = { status: 400, acts: [JSON.stringify({ error: { message: "nope", code: "invalid_prompt" } })] };
    await withServer((n) => (n === 0 ? reply("resp_1", "Hello") : bad), async (server, make) => {
      const a = make();
      const c1 = await go(a, ctx([user("hi")]));
      const run = await collectStream(a.stream({ context: ctx([user("hi"), asTurn(c1), user("more")]), setup: setupFor(), signal: new AbortController().signal }));
      assert.ok(run.error instanceof ProviderError && run.error.kind === "invalid_request");
      assert.equal(server.seen.length, 2);
    });
  });
});

describe("compaction", () => {
  const opts = { store: true, replayItemIds: true, chain: true, pruneAtCompaction: true };

  test("a compaction item in the stream is kept whole as an opaque block", async () => {
    await withServer([reply("resp_1", "Hello", { compaction: true })], async (_s, make) => {
      const c = await go(make(), ctx([user("hi")]));
      assert.deepEqual(c.blocks.map((b) => b.type), ["text", "provider_compaction"]);
      assert.equal(JSON.parse((c.blocks[1] as { payload: string }).payload)["encrypted_content"], "gAAAA-COMPACT");
    });
  });

  test("the threshold is requested; replay drops what came before the latest compaction item; chaining survives it", async () => {
    await withServer([reply("resp_1", "Hello", { compaction: true }), reply("resp_2", "Next")], async (server, make) => {
      const a = make();
      const setup = setupFor({ max_output_tokens: 100, compact_threshold: 5000 });
      const c1 = await go(a, ctx([user("hi")]), setup);
      assert.deepEqual(bodyOf(server.seen[0])["context_management"], [{ type: "compaction", compact_threshold: 5000 }]);
      const turns = [user("hi"), asTurn(c1), user("more")];
      const body = buildResponsesBody(ctx(turns), setup, opts);
      const input = body["input"] as Record<string, unknown>[];
      assert.equal(input[0]?.["type"], "compaction", "everything before the compaction item is gone");
      assert.equal(input.length, 2);
      const c2 = await go(a, ctx(turns), setup);
      assert.equal(bodyOf(server.seen[1])["previous_response_id"], "resp_1");
      assert.equal(c2.ext?.["chained"], true);
      // without pruning, the whole history is replayed
      const full = buildResponsesBody(ctx(turns), setup, { ...opts, pruneAtCompaction: false })["input"] as unknown[];
      assert.equal(full.length, 4);
    });
  });

  test("it goes only to the model that made it; the Anthropic adapter never sends it", async () => {
    const block = { $tag: "provider_compaction" as const, provider: "main", payload: JSON.stringify({ type: "compaction", encrypted_content: "x" }) };
    const entries: ChatEntry[] = [
      { $tag: "user", id: "01J00000000000000000000001", content: [{ $tag: "text", text: "hi" }] } as ChatEntry,
      { $tag: "assistant", id: "01J00000000000000000000002", provider: "main", model: "gpt-5.4", blocks: [{ $tag: "text", text: "ok" }, block], stop_reason: "end_turn", ext: { response_id: "resp_1" } } as ChatEntry,
    ];
    const same = await buildContext(entries, { system: "s", target: { provider: "main", model: "gpt-5.4" } });
    assert.deepEqual((same.turns[1] as { blocks: { type: string }[] }).blocks.map((b) => b.type), ["text", "provider_compaction"]);
    assert.deepEqual((same.turns[1] as { ext?: unknown }).ext, { response_id: "resp_1" });
    const other = await buildContext(entries, { system: "s", target: { provider: "main", model: "other" } });
    assert.deepEqual((other.turns[1] as { blocks: { type: string }[] }).blocks.map((b) => b.type), ["text"]);
    assert.deepEqual(toEntryBlocks(same.turns[1]?.role === "assistant" ? same.turns[1].blocks : [])[1], block);
  });
});

describe("retrieval", () => {
  const done = (extra: object = {}) => JSON.stringify(resp("resp_9", { status: "completed", usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5 }, output: [{ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" }, msg("msg_9", "Recovered text"), { id: "fc_9", type: "function_call", call_id: "c9", name: "lookup", arguments: '{"q":1}' }], ...extra }));
  const get = (a: ReturnType<typeof openaiResponsesAdapter>, id = "resp_9", signal = new AbortController().signal) => (a.retrieve as NonNullable<typeof a.retrieve>)({ responseId: id, setup: setupFor(), signal });

  test("a stored response becomes the same blocks, stop reason and usage the stream would have given", async () => {
    await withServer([{ headers: { "content-type": "application/json" }, acts: [done()] }], async (server, make) => {
      const c = await get(make());
      assert.equal(server.seen[0]?.method, "GET");
      assert.equal(server.seen[0]?.url, "/v1/responses/resp_9");
      assert.equal(server.seen[0]?.headers["authorization"], `Bearer ${KEY}`);
      assert.deepEqual(c?.blocks, [
        { type: "reasoning", provider: "main", payload: { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "hm" }], encrypted_content: "ENC" }, visible: "hm" },
        { type: "text", text: "Recovered text", ext: { item_id: "msg_9" } },
        { type: "tool_call", call_id: "c9", name: "lookup", args: { q: 1 }, ext: { item_id: "fc_9" } },
      ]);
      assert.equal(c?.stop_reason, "tool_use");
      assert.deepEqual([c?.usage.input_tokens, c?.usage.cache_read_tokens, c?.usage.output_tokens], [20, 10, 5]);
      assert.deepEqual(c?.observed, { model: "gpt-5.4-2026-03-05", response_id: "resp_9" });
      assert.deepEqual(c?.ext, { response_id: "resp_9", store: true, retrieved: true });
    });
  });

  test("incomplete responses keep their reason; gone, cancelled, running, failed and refused requests", async () => {
    const json = { "content-type": "application/json" };
    await withServer([{ headers: json, acts: [done({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })] }, { status: 404, headers: json, acts: ["{}"] }, { headers: json, acts: [done({ status: "cancelled" })] }, { headers: json, acts: [done({ status: "in_progress" })] }, { headers: json, acts: [done({ status: "failed", error: { code: "server_error", message: "boom" } })] }, { status: 401, headers: json, acts: [JSON.stringify({ error: { message: `bad key ${KEY}`, code: "invalid_api_key" } })] }], async (_s, make) => {
      const a = make({ http: { ...fast, retry: { maxAttempts: 1 } } });
      assert.equal((await get(a))?.stop_reason, "max_tokens");
      assert.equal(await get(a), undefined);
      assert.equal(await get(a), undefined);
      await assert.rejects(get(a), (e) => e instanceof ProviderError && e.retryable && /still in_progress/.test(e.message));
      await assert.rejects(get(a), (e) => e instanceof ProviderError && e.kind === "server" && e.message === "server_error: boom");
      await assert.rejects(get(a), (e) => e instanceof ProviderError && e.kind === "auth" && !e.message.includes(KEY));
    });
  });

  test("abort and an unreachable server end as ProviderErrors", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = openaiResponsesAdapter({ baseUrl: "http://127.0.0.1:1/v1", apiKey: KEY, http: fast });
    await assert.rejects(get(a, "r", ac.signal), (e) => e instanceof ProviderError && e.kind === "aborted");
    await assert.rejects(get(a), (e) => e instanceof ProviderError && !e.message.includes(KEY));
  });
});
