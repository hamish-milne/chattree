import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Dialect, Emit } from "../../providers/dialect.ts";
import { glmDialect, glm46Dialect, hermesDialect, mistralDialect } from "../../providers/dialects/families.ts";
import { dialectForModel } from "../../providers/dialects/index.ts";
import { contextOf, fixture } from "../support/templates.ts";

// The fixtures are each model's own chat template rendered over the scenarios (tools/jinja-fixture.py).
const SCENARIOS = ["one-call", "reasoning-between-calls", "after-final-answer", "nested-schema", "multiline-argument", "error-result", "two-calls-at-once"];

const input = (family: string, name: string, options: Record<string, unknown> = {}, tools = true) => {
  const context = contextOf(fixture(family, name).request);
  return { context: tools ? context : { ...context, tools: [] }, options, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss" };
};
/** The render of the first message of a scenario alone, which ends where the model is to begin an answer. */
const opening = (d: Dialect, family: string, options: Record<string, unknown> = {}) => {
  const i = input(family, "one-call", options);
  return d.render({ ...i, context: { ...i.context, turns: i.context.turns.slice(0, 1) } }).prompt;
};
const render = (d: Dialect, family: string, name: string, options: Record<string, unknown> = {}, tools = true) => d.render(input(family, name, options, tools)).prompt;

describe("each family renders what its model's own template does", () => {
  const plain: [string, Dialect][] = [["hermes", hermesDialect], ["mistral", mistralDialect], ["glm46", glm46Dialect], ["glm", glmDialect]];
  for (const [family, d] of plain) {
    describe(family, () => {
      for (const s of SCENARIOS) test(s, () => assert.equal(render(d, family, s), fixture(family, s).prompt));
    });
  }
});

describe("the markers a family reads", () => {
  test("a family lists its special tokens, the separator in a call's body too", () => {
    assert.deepEqual(mistralDialect.markers, ["[TOOL_CALLS]", "[ARGS]"]);
    assert.ok(glmDialect.markers?.includes("</think>"));
  });
});

describe("the options of a family", () => {
  test("thinking off asks for an empty block where the format has one", () => {
    assert.ok(opening(hermesDialect, "hermes", { thinking: false }).endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n"));
    assert.ok(opening(glm46Dialect, "glm46", { thinking: false }).endsWith("<|assistant|>\n<think></think>"));
    assert.ok(opening(glmDialect, "glm", { thinking: false }).endsWith("<|assistant|></think>"));
    assert.ok(opening(glmDialect, "glm").endsWith("<|assistant|><think>"));
  });
  test("keep_reasoning off leaves the replayed thinking out", () => {
    for (const [family, d] of [["hermes", hermesDialect], ["glm", glmDialect], ["glm46", glm46Dialect]] as const) {
      assert.ok(render(d, family, "reasoning-between-calls").includes("MARK-BETA"), family);
      assert.ok(!render(d, family, "reasoning-between-calls", { keep_reasoning: false }).includes("MARK-BETA"), family);
    }
  });
  test("the tools of a model are found by its name", () => {
    assert.equal(dialectForModel("unsloth/Devstral-Small-2507"), "mistral");
    assert.equal(dialectForModel("GLM-4.6"), "glm46");
    assert.equal(dialectForModel("glm-4.7-flash"), "glm");
    assert.equal(dialectForModel("qwen3.5-9b"), "qwen-xml");
    for (const old of ["deepseek-moe-16b", "DeepSeek-R1-Distill-Qwen-7B".replace("Qwen", "Llama"), "chatglm3-6b", "Mistral-7B-Instruct-v0.3", "kimi-vl"]) assert.equal(dialectForModel(old), undefined, old);
  });
});

// ---- reading -------------------------------------------------------------------------------------------------------

const tools = [
  { name: "write", description: "d", input_schema: { type: "object", properties: { path: { type: "string" }, n: { type: "integer" }, flag: { type: "boolean" } } } },
  { name: "read", description: "d", input_schema: { type: "object", properties: { path: { type: "string" } } } },
];

/** What the parser says about `text` fed in pieces of `size`, with runs of text joined. */
function read(d: Dialect, prompt: string, text: string, size: number, options: Record<string, unknown> = {}): Emit[] {
  const p = d.parser(options, tools, prompt);
  const out: Emit[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  out.push(...p.end("stop"));
  const merged: Emit[] = [];
  for (const e of out) {
    const l = merged[merged.length - 1];
    if (l !== undefined && (e.kind === "text" || e.kind === "reasoning") && l.kind === e.kind) l.text += e.text;
    else merged.push({ ...e });
  }
  return merged;
}

const two: Emit[] = [{ kind: "call.start", name: "write" }, { kind: "call.end", args: { path: "hello.py", n: 3 } }, { kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "a.txt" } }];

const CASES: { family: string; d: Dialect; prompt: string; raw: string; want: Emit[] }[] = [
  {
    family: "hermes",
    d: hermesDialect,
    prompt: "…<|im_start|>assistant\n",
    raw: '<think>\nPlan.\n</think>\n\nWriting.\n\n<tool_call>\n{"name": "write", "arguments": {"path": "hello.py", "n": 3}}\n</tool_call>\n<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>',
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "mistral (a call has no end of its own)",
    d: mistralDialect,
    prompt: "…[/INST]",
    raw: 'Writing.[TOOL_CALLS]write[ARGS]{"path": "hello.py", "n": 3}[TOOL_CALLS]read[ARGS]{"path": "a.txt"}',
    want: [{ kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "glm46 (thinking starts in the text)",
    d: glm46Dialect,
    prompt: "…<|assistant|>",
    raw: "\n<think>Plan.</think>\nWriting.\n<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>hello.py</arg_value>\n<arg_key>n</arg_key>\n<arg_value>3</arg_value>\n</tool_call>\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>a.txt</arg_value>\n</tool_call>",
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "glm (4.7: no newlines; the prompt ends inside the thinking)",
    d: glmDialect,
    prompt: "…<|assistant|><think>",
    raw: "Plan.</think>Writing.<tool_call>write<arg_key>path</arg_key><arg_value>hello.py</arg_value><arg_key>n</arg_key><arg_value>3</arg_value></tool_call><tool_call>read<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>",
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
];

describe("each family's output is read, whatever the pieces", () => {
  for (const c of CASES) for (const size of [1, 3, 1000]) test(`${c.family}, in pieces of ${size}`, () => assert.deepEqual(read(c.d, c.prompt, c.raw, size), c.want));
});

describe("a family's calls that go wrong", () => {
  test("a call whose JSON cannot be read is kept as text, with its name", () => {
    assert.deepEqual(read(mistralDialect, "x", "[TOOL_CALLS]read[ARGS]{not json}", 4), [{ kind: "call.start", name: "read" }, { kind: "call.end", raw: "{not json}" }]);
  });
  test("a call cut off inside its arguments is kept as the text the model wrote", () => {
    const e = read(glm46Dialect, "x", "<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>hel", 7);
    assert.deepEqual(e, [{ kind: "call.start", name: "write" }, { kind: "call.end", raw: "write\n<arg_key>path</arg_key>\n<arg_value>hel" }]);
  });
  test("a call that is not in the format is plain text", () => assert.deepEqual(read(hermesDialect, "x", "<tool_call>\nnot a call\n</tool_call>", 6), [{ kind: "text", text: "<tool_call>\nnot a call\n</tool_call>" }]));
  test("the name of a call is known as soon as it has been written", () => {
    const p = glm46Dialect.parser({}, tools, "x");
    assert.deepEqual(p.push("<tool_call>wri"), []);
    assert.deepEqual(p.push("te\n<arg_key>pa"), [{ kind: "call.start", name: "write" }]);
  });
  test("GLM-4.6 also reads a first tag straight after the name", () => {
    const raw = "<tool_call>read<arg_key>path</arg_key><arg_value>notes.txt</arg_value></tool_call>";
    for (const size of [1, 4, 1000]) assert.deepEqual(read(glm46Dialect, "x", raw, size), [{ kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "notes.txt" } }]);
  });
  test("a JSON argument string is also accepted in the Hermes format, and `parameters` for `arguments`", () => {
    assert.deepEqual(read(hermesDialect, "x", '<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"a\\"}"}</tool_call><tool_call>{"name": "read", "parameters": {"path": "b"}}</tool_call>', 9), [
      { kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "a" } }, { kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "b" } },
    ]);
  });
});
