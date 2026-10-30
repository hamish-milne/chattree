import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup } from "../../harness/setup.ts";
import { envSource } from "../../harness/secrets.ts";
import { collectStream } from "../../providers/conformance.ts";
import { GEMINI_CATALOG, geminiCatalogFrom } from "../../providers/gemini.ts";
import { buildProviders, defaultRegistry } from "../../providers/index.ts";
import { USER_AGENT } from "../../providers/identity.ts";
import { costOf } from "../../providers/pricing.ts";
import { FakeServer } from "../support/fake-server.ts";

const KEY = "AIza-SECRET-key";
const data = (o: unknown): string => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: object, finish: string | null = null) => data({ id: "c1", object: "chat.completion.chunk", model: "gemini-3.8-flash", choices: [{ index: 0, delta, finish_reason: finish }] });
const ANSWER = [chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), data({ id: "c1", model: "gemini-3.8-flash", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }), data("[DONE]")];

describe("the Gemini catalog", () => {
  test("prices, long-context bands and reasoning levels", () => {
    const { models, prices } = GEMINI_CATALOG;
    assert.ok(models["gemini-3.8-flash"] && prices.models["gemini-3.8-flash"]);
    assert.equal(prices.models["gemini-3.1-pro-preview"]?.long_context?.above_tokens, 200_000);
    assert.deepEqual(Object.keys(models["gemini-3.5-flash-lite"]?.reasoning ?? {}), ["low", "medium", "high"]);
    const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices.models["gemini-3.5-flash-lite"]);
    assert.ok(Math.abs(c.usd - 2.8) < 1e-9);
  });

  test("limits appear once the model list has been read", () => {
    const { models } = geminiCatalogFrom([{ id: "x", name: "X", tier: "low", price: { input: 1, output: 2 }, free_tier: true, context: 1_048_576, output: 65_536 }], "2026-01-01");
    assert.equal(models["x"]?.context_window, 1_048_576);
    assert.equal(models["x"]?.max_output_tokens, 65_536);
    assert.equal(GEMINI_CATALOG.models["gemini-4-argon"]?.context_window, undefined, "unknown until refreshed, not guessed");
  });
});

describe("the gemini provider", () => {
  test("a request goes to the compatibility endpoint with the key as a bearer token, our User-Agent and no session header", async () => {
    const server = await FakeServer.start([{ acts: ANSWER }]);
    try {
      const b = await buildProviders({ g: { $tag: "gemini", api_key_env: "GEMINI_API_KEY", base_url: `${server.url}/v1beta/openai`, pricing: { free: true } } as never }, defaultRegistry(), envSource({ GEMINI_API_KEY: KEY }));
      const setup = { ...emptySetup(), model: { provider: "g", id: "gemini-3.8-flash", settings: { max_output_tokens: 256, reasoning_effort: "low" } } };
      const ctx = { system: "s", instructions: undefined, turns: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools: [], cacheHints: [] };
      const r = await collectStream((b.adapters.get("g") as NonNullable<ReturnType<typeof b.adapters.get>>).stream({ context: ctx, setup, signal: new AbortController().signal, session: "t1" }));
      assert.equal(r.error, undefined);
      const seen = server.seen[0];
      assert.match(seen?.url ?? "", /\/v1beta\/openai\/chat\/completions$/);
      assert.equal(seen?.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(seen?.headers["user-agent"], USER_AGENT);
      assert.equal(seen?.headers["x-opencode-session"], undefined);
      assert.equal(JSON.parse(seen?.body ?? "{}").reasoning_effort, "low");
      assert.equal(b.prices.get("g")?.models["gemini-3.8-flash"] !== undefined, true);
    } finally {
      await server.close();
    }
  });

  test("it needs its key", async () => {
    await assert.rejects(buildProviders({ g: { $tag: "gemini", api_key_env: "GEMINI_API_KEY" } as never }, defaultRegistry(), envSource({})), /GEMINI_API_KEY/);
  });
});
