import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Dialect, Emit } from "../../providers/dialect.ts";
import { deepseekDialect, glmDialect, hermesDialect, kimiDialect, minimaxDialect, mistralDialect } from "../../providers/dialects/families.ts";
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
  const plain: [string, Dialect][] = [["hermes", hermesDialect], ["mistral", mistralDialect], ["glm", glmDialect], ["minimax", minimaxDialect]];
  for (const [family, d] of plain) {
    describe(family, () => {
      for (const s of SCENARIOS) test(s, () => assert.equal(render(d, family, s), fixture(family, s).prompt));
    });
  }

  describe("kimi (its call ids are numbered as Moonshot's API does)", () => {
    for (const s of SCENARIOS) {
      test(s, () => {
        const f = fixture("kimi", s);
        let want = f.prompt;
        let n = 0;
        for (const m of f.request.messages) {
          for (const c of m.tool_calls ?? []) {
            const id = `functions.${c.function.name}:${n++}`;
            want = want.replace(`<|tool_call_begin|>${c.id}<|`, `<|tool_call_begin|>${id}<|`).replace(`## Return of ${c.id}\n`, `## Return of ${id}\n`);
          }
        }
        assert.equal(render(kimiDialect, "kimi", s), want);
      });
    }
  });

  describe("deepseek (its template does not render the tools, so the rest is compared)", () => {
    for (const s of SCENARIOS) test(s, () => assert.equal(render(deepseekDialect, "deepseek", s, {}, false), fixture("deepseek", s).prompt));
    test("the tools are described as the model card says, after the system text", () => {
      const p = render(deepseekDialect, "deepseek", "one-call");
      assert.match(p, /^You are a terse coding agent[^]*?\n\n## Tools\nYou have access to the following tools:\n\n### read\nDescription: Read a file\./);
      assert.ok(p.includes("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>"));
      assert.ok(p.indexOf("## Tools") < p.indexOf("<｜User｜>"));
    });
  });
});

describe("the options of a family", () => {
  test("thinking off asks for an empty block where the format has one", () => {
    assert.ok(opening(hermesDialect, "hermes", { thinking: false }).endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n"));
    assert.ok(opening(glmDialect, "glm", { thinking: false }).endsWith("<|assistant|>\n<think></think>"));
    assert.ok(opening(deepseekDialect, "deepseek", { thinking: true }).endsWith("<｜Assistant｜><think>"));
    assert.ok(opening(deepseekDialect, "deepseek").endsWith("<｜Assistant｜></think>"));
  });
  test("a model that always thinks is asked to start inside it", () => assert.ok(opening(minimaxDialect, "minimax").endsWith("]~b]ai\n<think>\n")));
  test("DeepSeek carries on after tool output with no turn marker of its own", () => assert.ok(render(deepseekDialect, "deepseek", "one-call").endsWith("<｜tool▁output▁end｜>")));
  test("keep_reasoning off leaves the replayed thinking out", () => {
    for (const [family, d] of [["hermes", hermesDialect], ["minimax", minimaxDialect], ["glm", glmDialect]] as const) {
      assert.ok(render(d, family, "reasoning-between-calls").includes("MARK-BETA"), family);
      assert.ok(!render(d, family, "reasoning-between-calls", { keep_reasoning: false }).includes("MARK-BETA"), family);
    }
  });
  test("a model without a place for reasoning never has it replayed", () => {
    assert.ok(!render(deepseekDialect, "deepseek", "reasoning-between-calls", { keep_reasoning: true }).includes("MARK-BETA"));
    assert.ok(!render(kimiDialect, "kimi", "reasoning-between-calls").includes("MARK-BETA"));
  });
  test("the tools of a model are found by its name", () => {
    assert.equal(dialectForModel("Kimi-K2-Instruct-Q4"), "kimi");
    assert.equal(dialectForModel("unsloth/Devstral-Small-2507"), "mistral");
    assert.equal(dialectForModel("DeepSeek-V3.1"), "deepseek");
    assert.equal(dialectForModel("GLM-4.6"), "glm");
    assert.equal(dialectForModel("MiniMax-M2"), "minimax");
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
    family: "kimi (a section of calls, named by id)",
    d: kimiDialect,
    prompt: "…<|im_assistant|>assistant<|im_middle|>",
    raw: 'Writing.<|tool_calls_section_begin|><|tool_call_begin|>functions.write:0<|tool_call_argument_begin|>{"path": "hello.py", "n": 3}<|tool_call_end|><|tool_call_begin|>functions.read:1<|tool_call_argument_begin|>{"path": "a.txt"}<|tool_call_end|><|tool_calls_section_end|>',
    want: [{ kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "deepseek",
    d: deepseekDialect,
    prompt: "…<｜Assistant｜></think>",
    raw: 'Writing.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>write<｜tool▁sep｜>{"path": "hello.py", "n": 3}<｜tool▁call▁end｜><｜tool▁call▁begin｜>read<｜tool▁sep｜>{"path": "a.txt"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    want: [{ kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "glm (thinking starts in the text)",
    d: glmDialect,
    prompt: "…<|assistant|>",
    raw: "\n<think>Plan.</think>\nWriting.\n<tool_call>write\n<arg_key>path</arg_key>\n<arg_value>hello.py</arg_value>\n<arg_key>n</arg_key>\n<arg_value>3</arg_value>\n</tool_call>\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>a.txt</arg_value>\n</tool_call>",
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "minimax (invokes in a section; the prompt ends inside the thinking)",
    d: minimaxDialect,
    prompt: "…]~b]ai\n<think>\n",
    raw: 'Plan.\n</think>\n\nWriting.\n\n<minimax:tool_call>\n<invoke name="write">\n<parameter name="path">hello.py</parameter>\n<parameter name="n">3</parameter>\n</invoke>\n<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</minimax:tool_call>',
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
];

describe("each family's output is read, whatever the pieces", () => {
  for (const c of CASES) for (const size of [1, 3, 1000]) test(`${c.family}, in pieces of ${size}`, () => assert.deepEqual(read(c.d, c.prompt, c.raw, size), c.want));
});

describe("a family's calls that go wrong", () => {
  test("a call whose JSON cannot be read is kept as text, with its name", () => {
    assert.deepEqual(read(mistralDialect, "x", "[TOOL_CALLS]read[ARGS]{not json}", 4), [{ kind: "call.start", name: "read" }, { kind: "call.end", raw: "{not json}" }]);
    assert.deepEqual(read(kimiDialect, "x", "<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{oops<|tool_call_end|>", 5), [{ kind: "call.start", name: "read" }, { kind: "call.end", raw: "{oops" }]);
  });
  test("a call cut off inside its arguments is kept as the text the model wrote", () => {
    const e = read(minimaxDialect, "x", '<invoke name="write">\n<parameter name="path">hel', 7);
    assert.deepEqual(e, [{ kind: "call.start", name: "write" }, { kind: "call.end", raw: 'write">\n<parameter name="path">hel' }]);
  });
  test("a call that is not in the format is plain text", () => assert.deepEqual(read(hermesDialect, "x", "<tool_call>\nnot a call\n</tool_call>", 6), [{ kind: "text", text: "<tool_call>\nnot a call\n</tool_call>" }]));
  test("the name of a call is known as soon as it has been written", () => {
    const p = glmDialect.parser({}, tools, "x");
    assert.deepEqual(p.push("<tool_call>wri"), []);
    assert.deepEqual(p.push("te\n<arg_key>pa"), [{ kind: "call.start", name: "write" }]);
  });
  test("GLM may write its first tag straight after the name, as GLM-4.7 does", () => {
    const raw = "<tool_call>read<arg_key>path</arg_key><arg_value>notes.txt</arg_value></tool_call>";
    for (const size of [1, 4, 1000]) assert.deepEqual(read(glmDialect, "x", raw, size), [{ kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "notes.txt" } }]);
  });
  test("a JSON argument string is also accepted in the Hermes format, and `parameters` for `arguments`", () => {
    assert.deepEqual(read(hermesDialect, "x", '<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"a\\"}"}</tool_call><tool_call>{"name": "read", "parameters": {"path": "b"}}</tool_call>', 9), [
      { kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "a" } }, { kind: "call.start", name: "read" }, { kind: "call.end", args: { path: "b" } },
    ]);
  });
});
