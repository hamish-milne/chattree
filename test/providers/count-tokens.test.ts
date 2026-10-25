import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropicAdapter } from "../../providers/anthropic.ts";
import { openaiResponsesAdapter } from "../../providers/openai-responses.ts";
import { ProviderError } from "../../providers/types.ts";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(status: number, reply: unknown, calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
}

const context = { system: "sys", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], tools: [], cacheHints: [] } as never;
const signal = new AbortController().signal;

describe("countTokens", () => {
  test("anthropic: posts the request without generation settings and returns input_tokens", async () => {
    const calls: Call[] = [];
    const a = anthropicAdapter({ apiKey: "sk-ant-SECRET", http: { fetch: fakeFetch(200, { input_tokens: 17 }, calls) } } as never);
    const setup = { model: { provider: "a", id: "claude-x", settings: { max_output_tokens: 99 } } } as never;
    assert.equal(await (a.countTokens as NonNullable<typeof a.countTokens>)({ context, setup, signal }), 17);
    assert.match(calls[0]!.url, /\/v1\/messages\/count_tokens$/);
    assert.equal(calls[0]!.body["model"], "claude-x");
    assert.equal(calls[0]!.body["max_tokens"], undefined);
    assert.equal(calls[0]!.body["stream"], undefined);
    assert.ok(Array.isArray(calls[0]!.body["messages"]));
    assert.equal(calls[0]!.headers["x-api-key"], "sk-ant-SECRET");
  });

  test("failures are classified and never leak the key", async () => {
    const a = anthropicAdapter({ apiKey: "sk-ant-SECRET", http: { fetch: fakeFetch(401, "bad key sk-ant-SECRET", []) } } as never);
    const setup = { model: { provider: "a", id: "claude-x", settings: { max_output_tokens: 9 } } } as never;
    await assert.rejects((a.countTokens as NonNullable<typeof a.countTokens>)({ context, setup, signal }), (e) => e instanceof ProviderError && !/SECRET/.test(e.message) && e.kind !== "network");
    const b = anthropicAdapter({ apiKey: "k", http: { fetch: fakeFetch(200, { nope: 1 }, []) } } as never);
    await assert.rejects((b.countTokens as NonNullable<typeof b.countTokens>)({ context, setup, signal }), (e) => e instanceof ProviderError && e.kind === "protocol");
  });

  test("openai responses: posts input, instructions and tools to /responses/input_tokens", async () => {
    const calls: Call[] = [];
    const a = openaiResponsesAdapter({ apiKey: "sk-proj-K", http: { fetch: fakeFetch(200, { input_tokens: 5 }, calls) } } as never);
    const setup = { model: { provider: "o", id: "gpt-x", settings: { max_output_tokens: 10 } } } as never;
    assert.equal(await (a.countTokens as NonNullable<typeof a.countTokens>)({ context, setup, signal }), 5);
    assert.match(calls[0]!.url, /\/responses\/input_tokens$/);
    assert.equal(calls[0]!.body["model"], "gpt-x");
    assert.ok(calls[0]!.body["input"] !== undefined);
    assert.equal(calls[0]!.body["max_output_tokens"], undefined);
    assert.equal(calls[0]!.body["stream"], undefined);
  });
});
