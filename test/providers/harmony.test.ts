import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Block, ModelContext, Turn } from "../../harness/context-builder.ts";
import type { Emit } from "../../providers/dialect.ts";
import { harmonyParser, renderHarmony } from "../../providers/dialects/harmony.ts";

const dir = new URL("../fixtures/templates/gpt-oss/", import.meta.url);
const fixture = (name: string) => ({ request: JSON.parse(readFileSync(new URL(`${name}.request.json`, dir), "utf8")) as Request, prompt: readFileSync(new URL(`${name}.prompt.txt`, dir), "utf8") });

interface Request {
  messages: { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools: { function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

/** The chat-completions request of a fixture, as the context the harness would fold. */
function contextOf(r: Request): ModelContext {
  const turns: Turn[] = [];
  let system = "";
  for (const m of r.messages) {
    if (m.role === "system") system = m.content ?? "";
    else if (m.role === "user") turns.push({ role: "user", parts: [{ type: "text", text: m.content ?? "" }] });
    else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.reasoning_content !== undefined) blocks.push({ type: "reasoning", provider: "local-models", visible: m.reasoning_content });
      if (m.content !== null && m.content !== "") blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) blocks.push({ type: "tool_call", call_id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments) as Record<string, unknown> });
      turns.push({ role: "assistant", provider: "local-models", model: "gpt-oss@abcd1234", blocks });
    } else {
      const last = turns[turns.length - 1];
      const result = { call_id: m.tool_call_id as string, is_error: false, content: m.content ?? "", truncated: false };
      if (last?.role === "tool_results") last.results.push(result);
      else turns.push({ role: "tool_results", results: [result] });
    }
  }
  return { system, instructions: undefined, turns, tools: r.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })), cacheHints: [] };
}

const render = (name: string, options: Record<string, unknown> = {}) => renderHarmony({ context: contextOf(fixture(name).request), options, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss" }).prompt;

describe("harmony rendering matches the model's own template where they agree", () => {
  for (const name of ["one-call", "reasoning-between-calls", "error-result", "multiline-argument"]) {
    test(name, () => assert.equal(render(name), fixture(name).prompt));
  }
  test("nested-schema, with the template's flat declaration", () => assert.equal(render("nested-schema", { schema: "flat" }), fixture("nested-schema").prompt));
});

describe("harmony rendering departs from the template on purpose", () => {
  test("D1: a finished answer is in the final channel and its reasoning is dropped", () => {
    const p = render("after-final-answer");
    assert.ok(p.includes("<|start|>user<|message|>What is 2 + 2?<|end|><|start|>assistant<|channel|>final<|message|>4.<|end|><|start|>user<|message|>And 9 / 2?<|end|><|start|>assistant"));
    assert.ok(!p.includes("MARK-GAMMA"));
  });
  test("D2: two calls in a turn are call/result pairs, in order", () => {
    const p = render("two-calls-at-once");
    const tail = p.slice(p.indexOf("<|start|>user<|message|>Read"));
    assert.equal(
      tail,
      "<|start|>user<|message|>Read a.txt and b.txt.<|end|>" +
        '<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path": "a.txt"}<|call|>' +
        "<|start|>functions.read to=assistant<|channel|>commentary<|message|>=== a.txt (1 line, version 11111111) ===\n1\talpha<|end|>" +
        '<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path": "b.txt"}<|call|>' +
        "<|start|>functions.read to=assistant<|channel|>commentary<|message|>=== b.txt (1 line, version 22222222) ===\n1\tbeta<|end|><|start|>assistant",
    );
  });
  test("D3: nested schemas are declared in full", () => {
    const p = render("nested-schema");
    assert.ok(p.includes("items: {\n// The product code.\nsku: string,\n// How many.\nquantity: number,\n// Chosen options.\noptions?: string[],\n}[],"), p);
  });
  test("reasoning is not replayed with keep_reasoning off, nor to another model, nor from before the last user message", () => {
    assert.ok(!render("reasoning-between-calls", { keep_reasoning: false }).includes("MARK-ALPHA"));
    const ctx = contextOf(fixture("reasoning-between-calls").request);
    assert.ok(!renderHarmony({ context: ctx, options: {}, effort: undefined, date: "d", provider: "local-models", model: "other@1" }).prompt.includes("MARK-ALPHA"));
    ctx.turns.push({ role: "user", parts: [{ type: "text", text: "next" }] });
    assert.ok(!renderHarmony({ context: ctx, options: {}, effort: undefined, date: "d", provider: "local-models", model: "gpt-oss" }).prompt.includes("MARK-ALPHA"));
  });
  test("the effort is told to the model, and instructions and a preamble have their places", () => {
    const ctx: ModelContext = { system: "S", instructions: "I", turns: [{ role: "assistant", provider: "p", model: "m", blocks: [{ type: "text", text: "Looking." }, { type: "tool_call", call_id: "1", name: "t", args: {} }] }], tools: [], cacheHints: [] };
    const p = renderHarmony({ context: ctx, options: {}, effort: "high", date: "d", provider: "p", model: "m" }).prompt;
    assert.ok(p.includes("Reasoning: high"));
    assert.ok(!p.includes("Calls to these tools"));
    assert.ok(p.includes("<|start|>developer<|message|># Instructions\n\nS\n\nI<|end|>"));
    assert.ok(p.includes("<|start|>assistant<|channel|>commentary<|message|>Looking.<|end|><|start|>assistant<|channel|>commentary to=functions.t <|constrain|>json<|message|>{}<|call|>"));
  });
});

/** Everything a parser says for text pushed in pieces of `size` characters. */
function parse(text: string, size: number, why: "stop" | "length" = "stop"): Emit[] {
  const p = harmonyParser();
  const out: Emit[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  out.push(...p.end(why));
  return out;
}

/** The emissions with the runs of text merged, so that pieces of any size give the same answer. */
function merged(emits: Emit[]): Emit[] {
  const out: Emit[] = [];
  for (const e of emits) {
    const l = out[out.length - 1];
    if (l !== undefined && (e.kind === "text" || e.kind === "reasoning" || e.kind === "call.args") && l.kind === e.kind) {
      if (l.kind === "call.args" && e.kind === "call.args") l.delta += e.delta;
      else if (l.kind !== "call.args" && e.kind !== "call.args") l.text += e.text;
    } else out.push({ ...e });
  }
  return out;
}

describe("the harmony parser", () => {
  const call = '<|channel|>analysis<|message|>Need the file.<|end|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path": "a.txt"}<|call|>';
  const final = "<|channel|>final<|message|>It is 4.<|return|>";

  for (const size of [1, 2, 3, 7, 1000]) {
    test(`reasoning then a call, in pieces of ${size}`, () => {
      assert.deepEqual(merged(parse(call, size)), [
        { kind: "reasoning", text: "Need the file." },
        { kind: "call.start", name: "read" },
        { kind: "call.args", delta: '{"path": "a.txt"}' },
        { kind: "call.end", raw: '{"path": "a.txt"}' },
      ]);
    });
    test(`reasoning then a final answer, in pieces of ${size}`, () => {
      assert.deepEqual(merged(parse(`<|channel|>analysis<|message|>Easy.<|end|><|start|>assistant${final}`, size)), [
        { kind: "reasoning", text: "Easy." },
        { kind: "text", text: "It is 4." },
      ]);
    });
  }

  test("a preamble in commentary is text, and several calls are several calls", () => {
    const t = '<|channel|>commentary<|message|>Reading both.<|end|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a"}<|call|>';
    assert.deepEqual(merged(parse(t, 5)).map((e) => e.kind), ["text", "call.start", "call.args", "call.end"]);
  });

  test("a call from the analysis channel is still a call", () => {
    const e = merged(parse('<|channel|>analysis to=functions.read <|constrain|>json<|message|>{}<|call|>', 4));
    assert.deepEqual(e[0], { kind: "call.start", name: "read" });
  });

  test("a stream that ends inside a call closes it with what there is", () => {
    const e = merged(parse('<|channel|>commentary to=functions.write <|constrain|>json<|message|>{"path": "a', 6, "length"));
    assert.deepEqual(e[e.length - 1], { kind: "call.end", raw: '{"path": "a' });
  });

  test("text that is not in the format at all is text", () => {
    assert.deepEqual(merged(parse("Just an answer.", 4)), [{ kind: "text", text: "Just an answer." }]);
  });

  test("a stream that ends without the closing token keeps what was said", () => {
    assert.deepEqual(merged(parse("<|channel|>final<|message|>Hello", 3)), [{ kind: "text", text: "Hello" }]);
  });

  test("angle brackets in the body that are not tokens are kept", () => {
    assert.deepEqual(merged(parse("<|channel|>final<|message|>a < b <|not a token|> c<|return|>", 3)), [{ kind: "text", text: "a < b <|not a token|> c" }]);
  });
});
