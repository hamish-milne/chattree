import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup } from "../../harness/setup.ts";
import { envSource } from "../../harness/secrets.ts";
import { collectStream } from "../../providers/conformance.ts";
import { buildProviders, defaultRegistry } from "../../providers/index.ts";
import { USER_AGENT } from "../../providers/identity.ts";
import { OPENCODE_GO_CATALOG } from "../../providers/opencode-go.ts";
import { OPENCODE_GO_ROWS } from "../../providers/catalog/opencode-go-rows.ts";
import { costOf } from "../../providers/pricing.ts";
import { FakeServer } from "../support/fake-server.ts";

const KEY = "ocgo-SECRET-key";
const data = (o: unknown): string => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: object, finish: string | null = null) => data({ id: "c1", object: "chat.completion.chunk", model: "glm-5.3-flash", choices: [{ index: 0, delta, finish_reason: finish }] });
const ANSWER = [chunk({ role: "assistant", content: "hi" }), chunk({}, "stop"), data({ id: "c1", model: "glm-5.3-flash", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }), data("[DONE]")];

describe("the OpenCode Go catalog", () => {
  const { models, prices, api } = OPENCODE_GO_CATALOG;

  test("every row becomes a model, a price and an API style", () => {
    assert.equal(OPENCODE_GO_ROWS.length, 28);
    for (const r of OPENCODE_GO_ROWS) {
      assert.ok(models[r.id] && prices.models[r.id] && api[r.id], r.id);
      assert.equal(models[r.id]?.context_window, r.context);
      assert.equal(models[r.id]?.max_output_tokens, r.output);
    }
    assert.equal(api["claude-haiku-5-5"], "messages");
    assert.equal(api["glm-5.3-flash"], "chat-completions");
  });

  test("free models are free, long-context bands and reasoning levels carry over, toggles have no levels", () => {
    assert.deepEqual(prices.models["beam-free"], { free: true });
    assert.equal(prices.models["claude-haiku-5-5"]?.long_context?.above_tokens, 100_000);
    assert.deepEqual(models["gpt-6-luna"]?.reasoning?.["off"], { reasoning_effort: "none" });
    assert.deepEqual(models["glm-5.3"]?.reasoning, { low: { reasoning_effort: "low" }, high: { reasoning_effort: "high" }, max: { reasoning_effort: "max" } });
    assert.equal(models["minimax-m3"]?.reasoning, undefined);
  });

  test("costs follow the table (per million tokens)", () => {
    const c = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, prices.models["deepseek-v4.1-flash"]);
    assert.equal(c.unknown, false);
    assert.ok(Math.abs(c.usd - 0.75) < 1e-9);
    // over the long-context threshold the higher band applies
    const long = costOf({ input_tokens: 200_000, output_tokens: 0 }, prices.models["claude-haiku-5-5"]);
    assert.ok(Math.abs(long.usd - 0.1) < 1e-9);
  });
});

describe("the opencode-go provider", () => {
  test("it needs its key, and a model's context window and price come from the catalog", async () => {
    await assert.rejects(buildProviders({ go: { $tag: "opencode-go", api_key_env: "OC_KEY" } as never }, defaultRegistry(), envSource({})), /OC_KEY/);
    const b = await buildProviders({ go: { $tag: "opencode-go", api_key_env: "OC_KEY" } as never }, defaultRegistry(), envSource({ OC_KEY: KEY }));
    assert.equal(b.models.get("go")?.["kimi-k3"]?.context_window, 1_048_576);
    assert.ok(b.prices.get("go")?.models["kimi-k3"]);
  });

  test("requests carry the key, our User-Agent and a stable session id, and the session header can be turned off", async () => {
    const server = await FakeServer.start([{ acts: ANSWER }, { acts: ANSWER }]);
    try {
      const setup = { ...emptySetup(), model: { provider: "go", id: "glm-5.3-flash", settings: { max_output_tokens: 256 } } };
      const ctx = { system: "s", instructions: undefined, turns: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools: [], cacheHints: [] };
      for (const [headers, session] of [[undefined, "thread-abc"], [{ "X-OpenCode-Session": null }, "thread-abc"]] as const) {
        const b = await buildProviders({ go: { $tag: "opencode-go", api_key_env: "OC_KEY", base_url: `${server.url}/openai/v1`, ...(headers === undefined ? {} : { headers }) } as never }, defaultRegistry(), envSource({ OC_KEY: KEY }));
        const r = await collectStream((b.adapters.get("go") as NonNullable<ReturnType<typeof b.adapters.get>>).stream({ context: ctx, setup, signal: new AbortController().signal, session }));
        assert.equal(r.error, undefined);
      }
      const [a, off] = server.seen;
      assert.match(a?.url ?? "", /\/openai\/v1\/chat\/completions$/);
      assert.equal(a?.headers["authorization"], `Bearer ${KEY}`);
      assert.equal(a?.headers["user-agent"], USER_AGENT);
      assert.equal(a?.headers["x-opencode-session"], "thread-abc");
      assert.equal(off?.headers["x-opencode-session"], undefined);
    } finally {
      await server.close();
    }
  });
});
