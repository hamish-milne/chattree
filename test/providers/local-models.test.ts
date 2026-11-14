import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { collectStream } from "../../providers/conformance.ts";
import { AdapterRegistry } from "../../providers/index.ts";
import { localModelsDefinition, type LocalModelsRuntime } from "../../providers/local-models.ts";
import { costOf, findModel } from "../../providers/pricing.ts";
import type { ProviderError } from "../../providers/types.ts";
import { FakeServer } from "../support/fake-server.ts";

const data = (o: unknown): string => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;
const chunk = (delta: object, finish: string | null = null) => data({ id: "c1", object: "chat.completion.chunk", model: "whatever-the-server-says", choices: [{ index: 0, delta, finish_reason: finish }] });
const REPLY = [chunk({ role: "assistant", content: "Hello" }), chunk({}, "stop"), data({ id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), data("[DONE]")];

const setupFor = (id: string): AgentSetup => ({ ...emptySetup(), model: { provider: "local-models", id, settings: { max_output_tokens: 256, temperature: 0.6, extra: { top_k: 20 } } } });

function runtime(server: FakeServer | undefined, over: Partial<LocalModelsRuntime> = {}): LocalModelsRuntime {
  return {
    connect: async () => {
      if (server === undefined) throw new Error("the local model host is not running: start it with `chattree models start`");
      return { baseUrl: server.url, ids: { qwen: "qwen@1a2b3c4d" } };
    },
    catalog: () => ({ qwen: { context_window: 16384 }, q: { context_window: 16384 } }),
    resolve: (id) => (id === "q" ? "qwen" : id),
    ...over,
  };
}

const adapterFor = (rt: LocalModelsRuntime) => {
  const def = new AdapterRegistry().register(localModelsDefinition(rt)).get("local-models")!;
  return { def, adapter: def.create({ $tag: "local-models" } as never, { get: () => undefined }) };
};

describe("the media a local server takes", () => {
  test("is what its projector says: asked of /props for this model, with no PDF and no webp", async () => {
    const server = await FakeServer.start((_n, req) => (req.url.startsWith("/props") ? { status: 200, headers: { "content-type": "application/json" }, acts: [JSON.stringify({ modalities: { vision: true, audio: false } })] } : { acts: [] }));
    try {
      const { adapter } = adapterFor(runtime(server));
      const spec = await adapter.mediaSpec!(setupFor("q"));
      assert.deepEqual((spec.image ?? []).map((t) => t.mime), ["image/png", "image/jpeg", "image/gif", "image/bmp"]);
      assert.equal(spec.audio, undefined);
      assert.equal(spec.pdf, undefined);
      assert.match(server.seen[0]!.url, /^\/props/);
      assert.match(server.seen[0]!.url, /model=qwen/);
    } finally {
      await server.close();
    }
  });
});

describe("the local-models adapter", () => {
  test("asks the server for the model's own name, and records the identity of the file that answered", async () => {
    const server = await FakeServer.start([{ headers: { "content-type": "text/event-stream" }, acts: REPLY }]);
    try {
      const { adapter } = adapterFor(runtime(server));
      const run = await collectStream(adapter.stream({ context: { system: "S", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [] }, setup: setupFor("q"), signal: new AbortController().signal }));
      assert.equal(run.error, undefined);
      const seen = server.seen[0]!;
      assert.equal(seen.url, "/v1/chat/completions");
      const body = JSON.parse(seen.body) as Record<string, unknown>;
      assert.equal(body["model"], "qwen"); // the alias is resolved
      assert.equal(body["temperature"], 0.6);
      assert.equal(body["top_k"], 20);
      assert.equal(run.completed?.observed?.model, "qwen@1a2b3c4d");
    } finally {
      await server.close();
    }
  });

  test("a model recorded as served by name@hash is asked for by name", async () => {
    const server = await FakeServer.start([{ headers: { "content-type": "text/event-stream" }, acts: REPLY }]);
    try {
      const { adapter } = adapterFor(runtime(server));
      const setup = setupFor("qwen");
      setup.model!.resolved = "qwen@1a2b3c4d";
      await collectStream(adapter.stream({ context: { system: "S", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [] }, setup, signal: new AbortController().signal }));
      assert.equal((JSON.parse(server.seen[0]!.body) as { model: string }).model, "qwen");
    } finally {
      await server.close();
    }
  });

  test("a host that is not running is an error that says how to start it", async () => {
    const { adapter } = adapterFor(runtime(undefined));
    const run = await collectStream(adapter.stream({ context: { system: "S", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], cacheHints: [] }, setup: setupFor("qwen"), signal: new AbortController().signal }));
    const error = run.error as ProviderError;
    assert.equal(error.kind, "network");
    assert.match(error.message, /chattree models start/);
    assert.equal(error.retryable, false);
  });

  test("the catalog and the prices come from the settings: everything is free", () => {
    const { def } = adapterFor(runtime(undefined));
    const config = { $tag: "local-models" } as never;
    assert.deepEqual(Object.keys(def.models?.(config) ?? {}).sort(), ["q", "qwen"]);
    assert.equal(def.models?.(config).qwen?.context_window, 16384);
    const prices = def.prices?.(config);
    assert.ok(prices !== undefined);
    assert.deepEqual(costOf({ input_tokens: 100, output_tokens: 50 }, findModel(prices, "qwen")), { usd: 0, unknown: false });
    assert.deepEqual(def.secrets(config), []);
  });

  test("the config takes no address and no unknown keys", async () => {
    const { def } = adapterFor(runtime(undefined));
    assert.equal((await def.config["~standard"].validate({ $tag: "local-models" })).issues, undefined);
    assert.notEqual((await def.config["~standard"].validate({ $tag: "local-models", base_url: "http://x" })).issues, undefined);
  });
});
