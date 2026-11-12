import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import { callsIn, probeDialect } from "../../tools/harmony-raw-probe.ts";

const python = { name: "python", description: "Run code.", input_schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } };
const ctx: ModelContext = {
  system: "S",
  instructions: undefined,
  tools: [python],
  cacheHints: [],
  turns: [
    { role: "user", parts: [{ type: "text", text: "go" }] },
    { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "1", name: "python", args: { code: "print(1)" } }] },
    { role: "tool_results", results: [{ call_id: "1", content: "1", is_error: false, truncated: false }] },
  ],
};
const render = (options: Record<string, unknown>) => probeDialect.render({ context: ctx, options, effort: undefined, date: "d", provider: "p", model: "m" }).prompt;

describe("the harmony probe's dialect", () => {
  test("a built-in is described in the system block, not declared, and its calls are written bare on analysis", () => {
    const p = render({ builtins: { python: true } });
    assert.ok(p.includes("# Tools\n\n## python\n\nUse this tool to execute Python code"));
    assert.ok(!p.includes("namespace functions"));
    assert.ok(p.includes("<|start|>assistant<|channel|>analysis to=python<|message|>print(1)<|call|><|start|>python to=assistant<|channel|>analysis<|message|>1<|end|>"));
  });
  test("a function with a string argument is declared as one, and its calls are bare", () => {
    const p = render({ strings: ["python"] });
    assert.ok(p.includes("type python = (_: string) => any;"));
    assert.ok(p.includes("to=functions.python <|constrain|>json<|message|>print(1)<|call|>"));
  });
  test("by default it is the usual declaration with a JSON body", () => {
    const p = render({});
    assert.ok(p.includes("type python = (_: {"));
    assert.ok(p.includes('<|message|>{"code": "print(1)"}<|call|>'));
  });
});

describe("reading the model's raw output", () => {
  test("finds the channel, recipient, constrain token, extra word and kind of body of each call", () => {
    const raw = "<|channel|>analysis<|message|>Thinking.<|end|><|start|>assistant<|channel|>analysis to=python code<|message|>print(1)<|call|><|start|>assistant<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{\"command\": \"ls\"}<|call|>";
    assert.deepEqual(callsIn(raw), [
      { channel: "analysis", recipient: "python", constrain: undefined, tail: "code", body: "bare" },
      { channel: "commentary", recipient: "functions.bash", constrain: "json", tail: "", body: "json object" },
    ]);
  });
});
