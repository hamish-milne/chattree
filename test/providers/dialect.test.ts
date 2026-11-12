import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { collectStream } from "../../providers/conformance.ts";
import { Assembler, type Dialect, type Emit } from "../../providers/dialect.ts";
import { AdapterRegistry } from "../../providers/index.ts";
import { localModelsDefinition, type LocalModelsRuntime } from "../../providers/local-models.ts";
import type { ProviderError } from "../../providers/types.ts";
import { FakeServer } from "../support/fake-server.ts";

/** A toy format: `<r>…</r>` reasoning, `[[name {json}]]` a call, anything else text. Reads text that may arrive in any pieces. */
const toy: Dialect = {
  id: "toy",
  render: ({ context, options, date, effort }) => ({
    prompt: `${date}|${effort ?? "-"}|${String(options["tag"] ?? "")}|${context.system}|${context.turns.length}|${context.tools.map((t) => t.name).join(",")}`,
    stop: ["<STOP>"],
  }),
  parser: () => {
    let buf = "";
    let inCall = false;
    return {
      push(text): Emit[] {
        buf += text;
        const out: Emit[] = [];
        for (;;) {
          if (inCall) {
            const i = buf.indexOf("]]");
            if (i < 0) return out;
            const body = buf.slice(0, i);
            buf = buf.slice(i + 2);
            inCall = false;
            out.push({ kind: "call.end", raw: body });
          } else {
            const i = buf.indexOf("[[");
            if (i < 0) {
              if (buf.endsWith("[")) {
                out.push({ kind: "text", text: buf.slice(0, -1) });
                buf = "[";
              } else {
                out.push({ kind: "text", text: buf });
                buf = "";
              }
              return out;
            }
            if (i > 0) out.push({ kind: "text", text: buf.slice(0, i) });
            const sp = buf.indexOf(" ", i);
            if (sp < 0) {
              buf = buf.slice(i);
              return out;
            }
            out.push({ kind: "call.start", name: buf.slice(i + 2, sp) });
            buf = buf.slice(sp + 1);
            inCall = true;
          }
        }
      },
      end: () => (inCall ? [{ kind: "call.end", raw: buf }] : buf === "" ? [] : [{ kind: "text", text: buf }]),
    };
  },
};

const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const last = (extra: object = {}) => chunk({ content: "", stop: true, stop_type: "eos", tokens_evaluated: 50, tokens_cached: 57, tokens_predicted: 7, timings: { cache_n: 30, prompt_n: 20 }, ...extra });

const rt = (server: FakeServer): LocalModelsRuntime => ({ connect: async () => ({ baseUrl: server.url, ids: { qwen: "qwen@1a2b3c4d" } }), catalog: () => ({ qwen: { context_window: 16384 } }), resolve: (id) => id });
const setup = (settings: object): AgentSetup => ({ ...emptySetup(), model: { provider: "local-models", id: "qwen", settings: { max_output_tokens: 99, ...settings } } });
const context = { system: "SYS", instructions: undefined, turns: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hi" }] }], tools: [{ name: "read", description: "d", input_schema: { type: "object" } }], cacheHints: [] };

async function run(acts: string[], settings: object = { dialect: "toy" }, status = 200) {
  const server = await FakeServer.start([{ status, headers: { "content-type": "text/event-stream" }, acts }]);
  try {
    const def = new AdapterRegistry().register(localModelsDefinition(rt(server), { dialects: [toy], today: () => "2026-11-11" })).get("local-models")!;
    const adapter = def.create({ $tag: "local-models" } as never, { get: () => undefined });
    const result = await collectStream(adapter.stream({ context, setup: setup(settings), signal: new AbortController().signal }));
    return { result, server };
  } finally {
    await server.close();
  }
}

describe("a model with a dialect", () => {
  test("is sent the rendered prompt to /completion, with the sampling, the stop strings and special tokens on", async () => {
    const { result, server } = await run([chunk({ content: "ok", stop: false }), last()], { dialect: "toy", dialect_options: { tag: "T" }, reasoning_effort: "high", temperature: 0.5, stop: ["X"], extra: { top_k: 20, prompt: "no", cache_prompt: false } });
    assert.equal(result.error, undefined);
    assert.equal(server.seen[0]!.url, "/completion");
    const body = JSON.parse(server.seen[0]!.body) as Record<string, unknown>;
    assert.equal(body["prompt"], "2026-11-11|high|T|SYS|1|read");
    assert.deepEqual(body["stop"], ["X", "<STOP>"]);
    assert.equal(body["n_predict"], 99);
    assert.equal(body["temperature"], 0.5);
    assert.equal(body["top_k"], 20);
    assert.equal(body["cache_prompt"], false);
    assert.equal(body["special"], true);
    assert.equal(body["stream"], true);
    assert.equal(body["model"], "qwen");
  });

  test("text and calls are read out of the raw stream, whatever the pieces", async () => {
    const pieces = ["Let me ", "look. [", "[read {\"pa", "th\": \"a.txt\"}]", "]", " done"];
    const { result } = await run([...pieces.map((c) => chunk({ content: c, stop: false })), last()]);
    assert.equal(result.error, undefined);
    const c = result.completed!;
    assert.equal(c.stop_reason, "tool_use");
    assert.deepEqual(c.blocks.map((b) => b.type), ["text", "tool_call", "text"]);
    const call = c.blocks[1] as { name: string; args: unknown; call_id: string };
    assert.equal(call.name, "read");
    assert.deepEqual(call.args, { path: "a.txt" });
    assert.match(call.call_id, /^call_/);
    assert.deepEqual(result.events.filter((e) => e.type === "tool_call.start").length, 1);
  });

  test("a malformed call is a block with args_raw, not an error", async () => {
    const { result } = await run([chunk({ content: "[[read {not json}]]", stop: false }), last()]);
    assert.equal(result.error, undefined);
    const call = result.completed!.blocks[0] as { args: unknown; args_raw?: string };
    assert.deepEqual(call.args, {});
    assert.equal(call.args_raw, "{not json}");
  });

  test("a call cut off by the stream ending is closed as raw text", async () => {
    const { result } = await run([chunk({ content: "[[read {\"a\":", stop: false }), last()]);
    const call = result.completed!.blocks[0] as { args_raw?: string };
    assert.equal(call.args_raw, "{\"a\":");
  });

  test("usage comes from the final chunk, with cached tokens counted apart from the input", async () => {
    const { result } = await run([chunk({ content: "x", stop: false }), last()]);
    const u = result.completed!.usage;
    assert.equal(u.input_tokens, 20);
    assert.equal(u.cache_read_tokens, 30);
    assert.equal(u.output_tokens, 7);
    assert.equal(result.completed!.observed.model, "qwen@1a2b3c4d");
  });

  test("hitting the token limit is max_tokens", async () => {
    const { result } = await run([chunk({ content: "x", stop: false }), last({ stop_type: "limit" })]);
    assert.equal(result.completed!.stop_reason, "max_tokens");
  });

  test("a server error says what it said", async () => {
    const { result } = await run([JSON.stringify({ error: { type: "exceed_context_size_error", message: "too long" } })], { dialect: "toy" }, 400);
    const e = result.error as ProviderError;
    assert.equal(e.kind, "invalid_request");
    assert.match(e.message, /too long/);
  });

  test("an unknown dialect names the ones there are", async () => {
    const { result } = await run([last()], { dialect: "nope" });
    assert.match((result.error as ProviderError).message, /unknown dialect "nope"; known: toy/);
  });

  test("attachments are refused: dialects take text", async () => {
    const server = await FakeServer.start([{ acts: [last()] }]);
    try {
      const def = new AdapterRegistry().register(localModelsDefinition(rt(server), { dialects: [toy] })).get("local-models")!;
      const adapter = def.create({ $tag: "local-models" } as never, { get: () => undefined });
      const ctx = { ...context, turns: [{ role: "user" as const, parts: [{ type: "attachment" as const, kind: "image" as const, name: "a.png", mime: "image/png", sha256: "x", bytes: new Uint8Array(1) }] }] };
      const r = await collectStream(adapter.stream({ context: ctx, setup: setup({ dialect: "toy" }), signal: new AbortController().signal }));
      assert.match((r.error as ProviderError).message, /text only/);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });

  test("without a dialect the chat endpoint is used as before", async () => {
    const server = await FakeServer.start([{ acts: [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "a" }, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"] }]);
    try {
      const def = new AdapterRegistry().register(localModelsDefinition(rt(server), { dialects: [toy] })).get("local-models")!;
      const adapter = def.create({ $tag: "local-models" } as never, { get: () => undefined });
      await collectStream(adapter.stream({ context, setup: setup({}), signal: new AbortController().signal }));
      assert.equal(server.seen[0]!.url, "/v1/chat/completions");
    } finally {
      await server.close();
    }
  });

  test("changing the dialect or its options is a cache break", () => {
    const def = localModelsDefinition(rt(undefined as never), { dialects: [toy] });
    const adapter = def.create({ $tag: "local-models" } as never, { get: () => undefined });
    assert.equal(adapter.classify!(setup({ dialect: "toy" }), setup({ dialect: "toy", dialect_options: { a: 1 } }), { midLoop: false }).length, 1);
    assert.equal(adapter.classify!(setup({ dialect: "toy" }), setup({ dialect: "toy" }), { midLoop: false }).length, 0);
  });
});

describe("the assembler", () => {
  test("reasoning, text and calls become separate blocks in order, and open ones are closed at the end", () => {
    const a = new Assembler("p", () => "c1");
    a.feed([{ kind: "reasoning", text: "think" }, { kind: "text", text: "say" }, { kind: "call.start", name: "x" }, { kind: "call.args", delta: "{\"a\"" }, { kind: "call.args", delta: ":1}" }]);
    a.end();
    assert.deepEqual(a.blocks, [{ type: "reasoning", provider: "p", visible: "think" }, { type: "text", text: "say" }, { type: "tool_call", call_id: "c1", name: "x", args: { a: 1 } }]);
  });
});
