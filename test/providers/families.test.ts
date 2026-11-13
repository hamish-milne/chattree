import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Dialect, Emit } from "../../providers/dialect.ts";
import type { AttachmentPart, ModelContext } from "../../harness/context-builder.ts";
import { deepseekR1Dialect, glmDialect, glm46Dialect, hermesDialect, kimiVlDialect, mistralDialect } from "../../providers/dialects/families.ts";
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
    assert.equal(dialectForModel("unsloth/Kimi-VL-A3B-Thinking-2506-GGUF"), "kimi-vl");
    assert.equal(dialectForModel("DeepSeek-R1-Distill-Qwen-14B"), "deepseek-r1");
    assert.equal(dialectForModel("deepseek-ai/DeepSeek-R1-0528"), "deepseek-r1");
    for (const old of ["deepseek-moe-16b", "deepseek-v3.1", "chatglm3-6b", "Mistral-7B-Instruct-v0.3", "kimi-k2", "my-qwen-tune", "llama-3.1-8b-qwen-merge"]) assert.equal(dialectForModel(old), undefined, old);
  });
});

// The expected prompts were rendered by each model's own template (jinja2, as tools/jinja-fixture.py does) over these messages.
const chat = (turns: ModelContext["turns"], system = "S", tools: ModelContext["tools"] = []): ModelContext => ({ system, instructions: undefined, turns, tools, cacheHints: [] });
const said = (text: string): ModelContext["turns"][number] => ({ role: "user", parts: [{ type: "text", text }] });
const answered = (text: string, reasoning?: string): ModelContext["turns"][number] => ({ role: "assistant", provider: "local-models", model: "gpt-oss", blocks: [...(reasoning === undefined ? [] : [{ type: "reasoning" as const, provider: "local-models", visible: reasoning }]), { type: "text", text }] });
const prompt = (d: Dialect, context: ModelContext, options: Record<string, unknown> = {}): string => d.render({ context, options, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss" }).prompt;
const conversation = [said("hi"), answered("hello"), said("again")];

describe("kimi-vl and deepseek-r1 render what their templates do", () => {
  test("kimi-vl: the same for the Thinking and the Instruct model, with a default system turn", () => {
    assert.equal(prompt(kimiVlDialect, chat(conversation)), "<|im_system|>system<|im_middle|>S<|im_end|><|im_user|>user<|im_middle|>hi<|im_end|><|im_assistant|>assistant<|im_middle|>hello<|im_end|><|im_user|>user<|im_middle|>again<|im_end|><|im_assistant|>assistant<|im_middle|>");
    assert.ok(prompt(kimiVlDialect, chat([said("hi")], "")).startsWith("<|im_system|>system<|im_middle|>You are a helpful assistant<|im_end|><|im_user|>"));
  });
  test("kimi-vl has no tool calls, and says so to an agent that has tools", () => {
    assert.throws(() => prompt(kimiVlDialect, chat([said("hi")], "S", [{ name: "read", description: "d", input_schema: { type: "object" } }])), /has no tool calls/);
  });
  test("deepseek-r1: the system text straight away, the answer after the blank line, the prompt ends inside the thinking", () => {
    assert.equal(prompt(deepseekR1Dialect, chat(conversation)), "S<｜User｜>hi<｜Assistant｜>\n\nhello<｜end▁of▁sentence｜><｜User｜>again<｜Assistant｜><think>\n");
    assert.equal(prompt(deepseekR1Dialect, chat([said("hi")]), { thinking: false }), "S<｜User｜>hi<｜Assistant｜><think>\n\n</think>\n\n");
  });
  test("deepseek-r1 does not replay reasoning, and writes the tool list that its template never does", () => {
    assert.ok(!prompt(deepseekR1Dialect, chat([said("hi"), answered("hello", "MARK-BETA"), said("again")])).includes("MARK-BETA"));
    const p = prompt(deepseekR1Dialect, chat([said("hi")], "S", [{ name: "read", description: "d", input_schema: { type: "object", properties: { path: { type: "string" } } } }]));
    assert.ok(p.startsWith("S\n\n# Tools\n\n"));
    assert.ok(p.includes('<tools>\n{"type": "function", "function": {"name": "read"'));
    assert.ok(p.includes("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜><function-name>"));
  });
  test("deepseek-r1: a call and its results are in the template's format, the model continuing straight after them", () => {
    const turns: ModelContext["turns"] = [
      said("hi"),
      { role: "assistant", provider: "local-models", model: "gpt-oss", blocks: [{ type: "tool_call", call_id: "c1", name: "read", args: { path: "a" } }] },
      { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "X", truncated: false }, { call_id: "c1", is_error: false, content: "Y", truncated: false }] },
      answered("done"),
    ];
    // The template leaves the end of the calls and of the sentence out after a single call; this writes them, as V3 does.
    assert.equal(
      prompt(deepseekR1Dialect, chat(turns, "")),
      '<｜User｜>hi<｜Assistant｜><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read\n```json\n{"path": "a"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>X<｜tool▁output▁end｜>\n<｜tool▁output▁begin｜>Y<｜tool▁output▁end｜><｜tool▁outputs▁end｜>done<｜end▁of▁sentence｜><｜Assistant｜><think>\n',
    );
  });
});

describe("pictures are written into the prompt as the server's marker", () => {
  const png = (name: string): AttachmentPart => ({ type: "attachment", kind: "image", name, mime: "image/png", sha256: "0".repeat(64), bytes: Uint8Array.from([1, 2, 3]) });
  const withPicture = (parts: ModelContext["turns"][number] extends infer T ? (T extends { parts: infer P } ? P : never) : never): ModelContext => chat([{ role: "user", parts }], "");
  const render = (d: Dialect, context: ModelContext, marker: string | undefined) => d.render({ context, options: {}, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss", marker });

  test("each format writes the marker where the picture is, and says which pictures the markers are for", () => {
    const context = withPicture([png("a.png"), { type: "text", text: "what is this?" }]);
    const kimi = render(kimiVlDialect, context, "<__m__>");
    assert.equal(kimi.prompt, "<|im_system|>system<|im_middle|>You are a helpful assistant<|im_end|><|im_user|>user<|im_middle|><__m__>\nwhat is this?<|im_end|><|im_assistant|>assistant<|im_middle|>");
    assert.deepEqual(kimi.media?.map((m) => m.name), ["a.png"]);
    for (const d of [hermesDialect, mistralDialect, glmDialect, glm46Dialect, deepseekR1Dialect]) assert.ok(render(d, context, "<__m__>").prompt.includes("<__m__>\nwhat is this?"), d.id);
  });
  test("sound is written as the same marker, in order with pictures, and is carried in media", () => {
    const wav: AttachmentPart = { ...png("a.wav"), kind: "audio", mime: "audio/wav" };
    const r = render(hermesDialect, withPicture([png("p.png"), wav, { type: "text", text: "what did you hear?" }]), "<__m__>");
    assert.ok(r.prompt.includes("<__m__>\n<__m__>\nwhat did you hear?"));
    assert.deepEqual(r.media?.map((m) => [m.name, m.kind]), [["p.png", "image"], ["a.wav", "audio"]]);
    assert.throws(() => render(hermesDialect, withPicture([wav]), undefined), /sound, and the server has not said how to mark it/);
  });
  test("several pictures keep their order, and a turn without one has no media", () => {
    const r = render(hermesDialect, withPicture([{ type: "text", text: "compare" }, png("1.png"), png("2.png")]), "<__m__>");
    assert.ok(r.prompt.includes("compare\n<__m__>\n<__m__>"));
    assert.deepEqual(r.media?.map((m) => m.name), ["1.png", "2.png"]);
    assert.equal(render(hermesDialect, chat([said("hi")]), "<__m__>").media, undefined);
  });
  test("a picture with no marker to write, or a PDF, cannot be sent", () => {
    assert.throws(() => render(hermesDialect, withPicture([png("a.png")]), undefined), /how to mark it/);
    const pdf: AttachmentPart = { ...png("a.pdf"), kind: "pdf", mime: "application/pdf" };
    assert.throws(() => render(hermesDialect, withPicture([pdf]), "<__m__>"), /a\.pdf cannot be sent/);
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
  {
    family: "deepseek-r1 (DeepSeek's calls: a fenced JSON block)",
    d: deepseekR1Dialect,
    prompt: "…<｜Assistant｜><think>\n",
    raw: 'Plan.\n</think>\n\nWriting.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write\n```json\n{"path": "hello.py", "n": 3}\n```<｜tool▁call▁end｜>\n<｜tool▁call▁begin｜>function<｜tool▁sep｜>read\n```json\n{"path": "a.txt"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "Writing." }, ...two],
  },
  {
    family: "kimi-vl (Thinking: its own thinking tags, in the text)",
    d: kimiVlDialect,
    prompt: "…<|im_assistant|>assistant<|im_middle|>",
    raw: "◁think▷Plan.◁/think▷The picture shows a cat.",
    want: [{ kind: "reasoning", text: "Plan." }, { kind: "text", text: "The picture shows a cat." }],
  },
  {
    family: "kimi-vl (Instruct: plain text)",
    d: kimiVlDialect,
    prompt: "…<|im_assistant|>assistant<|im_middle|>",
    raw: "The picture shows a <cat>.",
    want: [{ kind: "text", text: "The picture shows a <cat>." }],
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
