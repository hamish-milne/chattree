import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Emit } from "../../providers/dialect.ts";
import { gemma, gemmaParser, parseGemmaArgs } from "../../providers/dialects/gemma.ts";
import { qwenParser, qwenXml } from "../../providers/dialects/qwen-xml.ts";
import { contextOf, fixture } from "../support/templates.ts";

const SCENARIOS = ["one-call", "reasoning-between-calls", "after-final-answer", "nested-schema", "multiline-argument", "error-result", "two-calls-at-once"];
const render = (d: typeof gemma, family: string, name: string, options: Record<string, unknown> = {}) => d.render({ context: contextOf(fixture(family, name).request), options, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss" }).prompt;

describe("qwen-xml rendering matches the model's own template", () => {
  for (const s of SCENARIOS) test(s, () => assert.equal(render(qwenXml, "qwen", s), fixture("qwen", s).prompt));
  test("thinking off asks for an empty think block", () => assert.ok(render(qwenXml, "qwen", "one-call", { thinking: false }).endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n")));
  test("the instructions after the tool list can be replaced or left out", () => {
    const given = render(qwenXml, "qwen", "one-call", { instructions: "Call like so." });
    assert.ok(given.includes("</tools>\n\nCall like so."));
    assert.ok(!given.includes("<IMPORTANT>"));
    assert.ok(!render(qwenXml, "qwen", "one-call", { instructions: false }).includes("<IMPORTANT>"));
  });
  test("keep_reasoning off leaves the replayed thinking empty", () => assert.ok(!render(qwenXml, "qwen", "reasoning-between-calls", { keep_reasoning: false }).includes("MARK-ALPHA")));
});

describe("gemma rendering matches the model's own template", () => {
  for (const s of SCENARIOS.filter((x) => x !== "nested-schema")) test(s, () => assert.equal(render(gemma, "gemma", s), fixture("gemma", s).prompt));
  test("nested-schema differs only by the keyword the format has no word for (G3)", () => {
    const want = fixture("gemma", "nested-schema").prompt;
    assert.ok(want.includes("additionalProperties:false,"));
    assert.equal(render(gemma, "gemma", "nested-schema"), want.replace("additionalProperties:false,", ""));
  });
  test("items are described like properties at any depth, and unknown keywords are left out", () => {
    const tool = { name: "t", description: "d", input_schema: { type: "object", properties: { grid: { type: "array", items: { type: "array", items: { type: ["integer", "null"], enum: [1, 2], minimum: 0, pattern: "x" } } } } } };
    const p = gemma.render({ context: { system: "", instructions: undefined, turns: [], tools: [tool], cacheHints: [] }, options: {}, effort: undefined, date: "d", provider: "p", model: "m" }).prompt;
    assert.ok(p.includes('grid:{items:{items:{enum:[1,2],nullable:true,type:<|"|>INTEGER<|"|>},type:<|"|>ARRAY<|"|>},type:<|"|>ARRAY<|"|>}'), p);
  });
  test("thinking off closes an empty thought", () => assert.ok(render(gemma, "gemma", "after-final-answer", { thinking: false }).endsWith("<|turn>model\n<|channel>thought\n<channel|>")));
});

const tools = [
  { name: "write", input_schema: { properties: { path: { type: "string" }, content: { type: "string" }, n: { type: "integer" }, flag: { type: "boolean" }, items: { type: "array" } } } },
];

function pieces(p: { push(t: string): Emit[]; end(w: "stop" | "length"): Emit[] }, text: string, size: number): Emit[] {
  const out: Emit[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  out.push(...p.end("stop"));
  const m: Emit[] = [];
  for (const e of out) {
    const l = m[m.length - 1];
    if (l !== undefined && (e.kind === "text" || e.kind === "reasoning") && l.kind === e.kind) l.text += e.text;
    else m.push({ ...e });
  }
  return m;
}

describe("the qwen-xml parser", () => {
  const out = "I should write it.\n</think>\n\nWriting now.\n\n<tool_call>\n<function=write>\n<parameter=path>\nhello.py\n</parameter>\n<parameter=content>\nprint(1)\n\n</parameter>\n<parameter=n>\n3\n</parameter>\n<parameter=flag>\ntrue\n</parameter>\n<parameter=items>\n[1, 2]\n</parameter>\n</function>\n</tool_call>";
  const want: Emit[] = [
    { kind: "reasoning", text: "I should write it." },
    { kind: "text", text: "Writing now." },
    { kind: "call.start", name: "write" },
    { kind: "call.end", args: { path: "hello.py", content: "print(1)\n", n: 3, flag: true, items: [1, 2] } },
  ];
  for (const size of [1, 4, 1000]) test(`reasoning, text and a typed call, in pieces of ${size}`, () => assert.deepEqual(pieces(qwenParser({}, tools, "…<think>\n"), out, size), want));
  test("without thinking in the prompt, the output is text from the start", () => assert.deepEqual(pieces(qwenParser({}, tools, "…</think>\n\n"), "Hi there.", 3), [{ kind: "text", text: "Hi there." }]));
  test("two calls", () => {
    const e = pieces(qwenParser({}, tools, "x"), "<tool_call>\n<function=a>\n</function>\n</tool_call>\n<tool_call>\n<function=b>\n</function>\n</tool_call>", 5);
    assert.deepEqual(e.map((x) => (x.kind === "call.start" ? x.name : x.kind)), ["a", "call.end", "b", "call.end"]);
  });
  test("a JSON call is accepted", () => assert.deepEqual(pieces(qwenParser({}, tools, "x"), '<tool_call>\n{"name": "a", "arguments": {"k": 1}}\n</tool_call>', 6), [{ kind: "call.start", name: "a" }, { kind: "call.end", args: { k: 1 } }]));
  test("a call cut off is closed as raw text", () => {
    const e = pieces(qwenParser({}, tools, "x"), "<tool_call>\n<function=write>\n<parameter=path>\nhel", 7);
    assert.equal(e[0]!.kind, "call.start");
    assert.equal(e[1]!.kind, "call.end");
    assert.ok("raw" in e[1]! && (e[1] as { raw: string }).raw.includes("hel"));
  });
});

describe("the gemma parser", () => {
  test("arguments in the format's notation", () => {
    assert.deepEqual(parseGemmaArgs('content:<|"|>a, b}\nc<|"|>,items:[1,2.5,<|"|>x<|"|>],n:3,ok:true,opt:{k:<|"|>v<|"|>},z:null'), { content: "a, b}\nc", items: [1, 2.5, "x"], n: 3, ok: true, opt: { k: "v" }, z: null });
    assert.equal(parseGemmaArgs("content:<|\"|>unterminated"), undefined);
  });
  const full = '<|channel>thought\nNeed to write.\n<channel|>Writing.<|tool_call>call:write{content:<|"|>hi\n<|"|>,path:<|"|>a.txt<|"|>}<tool_call|>';
  const want: Emit[] = [{ kind: "reasoning", text: "Need to write." }, { kind: "text", text: "Writing." }, { kind: "call.start", name: "write" }, { kind: "call.end", args: { content: "hi\n", path: "a.txt" } }];
  for (const size of [1, 3, 1000]) test(`thought, text and a call, in pieces of ${size}`, () => assert.deepEqual(pieces(gemmaParser({}, tools, "<|turn>model\n"), full, size), want));
  test("a prompt that ends inside the thought starts reading it as thought", () => assert.deepEqual(pieces(gemmaParser({}, tools, "x<|channel>thought\n"), "Hmm.\n<channel|>Done.<turn|>", 2), [{ kind: "reasoning", text: "Hmm." }, { kind: "text", text: "Done." }]));
  test("text ends at the end of the turn", () => assert.deepEqual(pieces(gemmaParser({}, tools, "x"), "Done.<turn|>ignored", 2), [{ kind: "text", text: "Done." }]));
});
