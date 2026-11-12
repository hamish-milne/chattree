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
const write = { name: "write", description: "Write.", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };
const render = (options: Record<string, unknown>, tools = ctx.tools) => probeDialect.render({ context: { ...ctx, tools }, options, effort: undefined, date: "d", provider: "p", model: "m" }).prompt;

describe("the harmony probe's dialect", () => {
  test("a built-in is described in the system block, not declared, and its calls are written bare on analysis", () => {
    const p = render({ builtins: { python: true } });
    assert.ok(p.includes("# Tools\n\n## python\n\nUse this tool to execute Python code"));
    assert.ok(!p.includes("namespace functions"));
    assert.ok(p.includes("<|start|>assistant<|channel|>analysis to=python code<|message|>print(1)<|call|><|start|>python to=assistant<|channel|>analysis<|message|>1<|end|>"));
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

describe("the probe's variations", () => {
  test("the line sending calls to the commentary channel can be left out", () => {
    assert.ok(render({ builtins: { python: true } }, [python, write]).includes("Calls to these tools must go to the commentary channel"));
    assert.ok(!render({ builtins: { python: true }, no_functions_line: true }, [python, write]).includes("Calls to these tools must go to the commentary channel"));
  });
  test("guidance goes in the developer block, for built-ins or for functions", () => {
    const b = render({ builtins: { python: true }, guidance: "builtin" });
    assert.ok(b.includes("# Instructions\n\nS\n\nBuilt-in tools: python. Call a built-in tool on the analysis channel"));
    const f = render({ guidance: "functions" });
    assert.ok(f.includes("Call every tool, including python, on the commentary channel with to=functions.NAME and JSON-encoded arguments"));
  });
});

describe("the strict arms", () => {
  const run = (raw: string, builtin = "python") => {
    const p = probeDialect.parser({ strict: true }, [python], "");
    return [...p.push(raw), ...p.end("stop")].filter((e) => e.kind === "call.end");
  };
  test("the guidance states the rules, with an example of each call", () => {
    const g = render({ builtins: { python: true, bash: true }, guidance: "strict" });
    assert.ok(g.includes("You MUST call a built-in tool on the analysis channel"));
    assert.ok(g.includes("Example call to python:\n  channel: analysis\n  recipient: python\n  message: print(6 * 7)"));
    assert.ok(g.includes("Example call to bash:\n  channel: analysis\n  recipient: bash\n  message: ls -l"));
  });
  test("a call that follows the convention goes through as its bare text", () => {
    assert.deepEqual(run("<|channel|>analysis to=python code<|message|>print(1)<|call|>"), [{ kind: "call.end", args: { code: "print(1)" } }]);
  });
  test("a call that breaks it becomes an error that says how to call it", () => {
    const [e] = run('<|channel|>commentary to=functions.python <|constrain|>json<|message|>{"code": "print(1)"}<|call|>');
    assert.equal(e?.kind, "call.end");
    const a = (e as { args: Record<string, string> }).args;
    assert.match(a["__violation"] as string, /you used the commentary channel; you addressed functions.python; the message was JSON/);
    assert.match(a["__violation"] as string, /Example: channel analysis, recipient python, message: print\(6 \* 7\)/);
    assert.equal(a["__raw"], '{"code": "print(1)"}');
  });
});

describe("reading the model's raw output", () => {
  test("finds the channel, recipient, constrain token, extra word and kind of body of each call", () => {
    const raw = "<|channel|>analysis<|message|>Thinking.<|end|><|start|>assistant<|channel|>analysis to=python code<|message|>print(1)<|call|><|start|>assistant<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{\"command\": \"ls\"}<|call|>";
    assert.deepEqual(callsIn(raw), [
      { channel: "analysis", recipient: "python", constrain: undefined, tail: "code", body: "bare", text: "print(1)" },
      { channel: "commentary", recipient: "functions.bash", constrain: "json", tail: "", body: "json object", text: '{"command": "ls"}' },
    ]);
  });
});
