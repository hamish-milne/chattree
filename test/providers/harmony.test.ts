import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelContext } from "../../harness/context-builder.ts";
import type { Emit } from "../../providers/dialect.ts";
import { harmonyParser, renderHarmony } from "../../providers/dialects/harmony.ts";
import { parseCommand } from "../../harness/starter/command.ts";
import { builtinSpecs, commandFor } from "../../providers/dialects/harmony-builtin.ts";

import { contextOf, fixture as fixtureOf } from "../support/templates.ts";
const fixture = (name: string) => fixtureOf("gpt-oss", name);
const render = (name: string, options: Record<string, unknown> = {}) => renderHarmony({ context: contextOf(fixture(name).request), options: { date: "today", ...options }, effort: undefined, date: "2026-11-11", provider: "local-models", model: "gpt-oss" }).prompt;

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

describe("the wording of the system block", () => {
  const ctx: ModelContext = { system: "", instructions: undefined, turns: [], tools: [], cacheHints: [] };
  const sys = (options: Record<string, unknown>) => /<\|start\|>system<\|message\|>([\s\S]*?)<\|end\|>/.exec(renderHarmony({ context: ctx, options, effort: undefined, date: "2026-11-11", provider: "p", model: "m" }).prompt)?.[1];
  test("by default it has no date, so the start of the prompt does not change from day to day", () => {
    assert.equal(sys({}), "You are ChatGPT, a large language model trained by OpenAI.\nKnowledge cutoff: 2024-06\n\nReasoning: medium\n\n# Valid channels: analysis, commentary, final. Channel must be included for every message.");
  });
  test("the date, identity and cutoff can be given, changed or left out", () => {
    assert.ok(sys({ date: "today" })?.includes("\nCurrent date: 2026-11-11\n"));
    assert.ok(sys({ date: "Friday" })?.includes("\nCurrent date: Friday\n"));
    assert.equal(sys({ identity: false, knowledge_cutoff: false }), "Reasoning: medium\n\n# Valid channels: analysis, commentary, final. Channel must be included for every message.");
    assert.ok(sys({ identity: "You are a model.", knowledge_cutoff: "2025-01" })?.startsWith("You are a model.\nKnowledge cutoff: 2025-01\n"));
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

describe("a bare body for a tool with one required string argument", () => {
  const python = { name: "python", input_schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, note: { type: "string" } } } };
  const write = { name: "write", input_schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } };
  const run = (text: string, tools: Parameters<typeof harmonyParser>[0], size: number): Emit[] => {
    const p = harmonyParser(tools);
    const out: Emit[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
    out.push(...p.end("stop"));
    return out;
  };
  const end = (e: Emit[]) => e.find((x) => x.kind === "call.end");
  const call = (name: string, body: string) => `<|channel|>analysis to=functions.${name} <|constrain|>json<|message|>${body}<|call|>`;
  for (const size of [1, 7, 1000]) {
    test(`is taken as that argument (pieces of ${size})`, () => assert.deepEqual(end(run(call("python", "print(1 * 2)\n"), [python], size)), { kind: "call.end", args: { code: "print(1 * 2)\n" } }));
  }
  test("a body that is a JSON object is left as it is", () => assert.deepEqual(end(run(call("python", '{"code": "x"}'), [python], 5)), { kind: "call.end", raw: '{"code": "x"}' }));
  test("a body that is a bare number is still a bare body", () => assert.deepEqual(end(run(call("python", "42"), [python], 5)), { kind: "call.end", args: { code: "42" } }));
  test("a tool with more required arguments, or an unknown one, is left alone", () => {
    assert.deepEqual(end(run(call("write", "hello"), [write], 5)), { kind: "call.end", raw: "hello" });
    assert.deepEqual(end(run(call("other", "hello"), [python], 5)), { kind: "call.end", raw: "hello" });
  });
});

describe("built-in tools", () => {
  const python = { name: "python", description: "Run code.", input_schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } };
  const bash = { name: "bash", description: "Run a command.", input_schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } };
  const write = { name: "write", description: "Write.", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };
  const options = { builtin_tools: { python: true, bash: true } };
  const ctx = (tools: ModelContext["tools"]): ModelContext => ({
    system: "S",
    instructions: undefined,
    tools,
    cacheHints: [],
    turns: [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "1", name: "python", args: { code: "print(1)" } }, { type: "tool_call", call_id: "2", name: "write", args: { path: "a" } }] },
      { role: "tool_results", results: [{ call_id: "1", content: "1", is_error: false, truncated: false }, { call_id: "2", content: "ok", is_error: false, truncated: false }] },
    ],
  });
  const rendered = (tools: ModelContext["tools"]) => renderHarmony({ context: ctx(tools), options, effort: undefined, date: "d", provider: "p", model: "m" }).prompt;

  test("are described in the system block and left out of functions", () => {
    const p = rendered([python, bash, write]);
    assert.ok(p.includes("Reasoning: medium\n\n# Tools\n\n## python\n\nUse this tool to execute Python code"));
    assert.ok(p.includes("## bash\n\nUse this tool to run shell commands"));
    const fns = p.slice(p.indexOf("namespace functions"));
    assert.ok(fns.includes("type write ="));
    assert.ok(!fns.includes("type python =") && !fns.includes("type bash ="));
  });
  test("the developer block states the rules with an example of each built-in, and names the functions convention only when there are functions", () => {
    const p = rendered([python, bash, write]);
    assert.ok(p.includes("IMPORTANT. You MUST follow these rules exactly for the built-in tools python and bash."));
    assert.ok(p.includes("Example call to bash:\n  channel: analysis\n  recipient: bash\n  message: ls -l"));
    assert.ok(p.includes("Every other tool is a function"));
    assert.ok(!rendered([python]).includes("Every other tool is a function"));
    assert.ok(!rendered([python]).includes("namespace functions"));
    assert.ok(!rendered([python]).includes("Calls to these tools must go to the commentary channel"));
  });
  test("earlier calls are written as analysis to=NAME with the bare text, and their results come from the tool", () => {
    const p = rendered([python, write]);
    assert.ok(p.includes("<|start|>assistant<|channel|>analysis to=python code<|message|>print(1)<|call|><|start|>python to=assistant<|channel|>analysis<|message|>1<|end|>"));
    assert.ok(p.includes("<|start|>assistant<|channel|>commentary to=functions.write <|constrain|>json<|message|>"));
  });
  test("a tool that is not offered is not described", () => {
    assert.ok(!rendered([write]).includes("## python"));
    assert.ok(!rendered([write]).includes("IMPORTANT. You MUST"));
  });

  const specs = builtinSpecs({ python: true, bash: true });
  const calls = (text: string, size = 5): Emit[] => {
    const p = harmonyParser([python, bash], specs);
    const out: Emit[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
    out.push(...p.end("stop"));
    return out.filter((e) => e.kind === "call.start" || e.kind === "call.end");
  };
  const header = (channel: string, recipient: string, constrain = "") => `<|channel|>${channel} to=${recipient}${constrain}<|message|>`;
  test("a call in the convention is the bare text as the argument", () => {
    assert.deepEqual(calls(`${header("analysis", "python")}print(1)<|call|>`), [{ kind: "call.start", name: "python" }, { kind: "call.end", args: { code: "print(1)" } }]);
  });
  test("the channel, a functions. prefix and a constrain word make no difference", () => {
    for (const h of [header("commentary", "functions.bash"), header("analysis", "functions.bash", " code"), header("commentary", "bash", " <|constrain|>json")]) {
      assert.deepEqual(calls(`${h}ls -l<|call|>`), [{ kind: "call.start", name: "bash" }, { kind: "call.end", args: { command: "ls -l" } }], h);
    }
  });
  test("JSON with one key holding a string is that string, whatever the key; a list of strings is joined with spaces", () => {
    assert.deepEqual(calls(`${header("commentary", "functions.bash")}{"cmd": "ls -l"}<|call|>`)[1], { kind: "call.end", args: { command: "ls -l" } });
    assert.deepEqual(calls(`${header("commentary", "functions.bash")}{"cmd": ["bash", "-lc", "wc -l notes.txt"]}<|call|>`)[1], { kind: "call.end", args: { command: "bash -lc wc -l notes.txt" } });
  });
  test("any other structure is not guessed at: the call is kept as written with an error that says how to call the tool", () => {
    for (const body of ['{"cmd": "a", "cwd": "b"}', '{"cmd": {"a": 1}}', '{"cmd": [1, 2]}', '{"cmd": []}', "{}"]) {
      const end = calls(`${header("commentary", "functions.bash")}${body}<|call|>`)[1] as Extract<Emit, { kind: "call.end" }>;
      assert.equal(end.raw, body, body);
      assert.match(end.error ?? "", /bash was NOT run: its message was JSON that cannot be read as one shell command.*message: ls -l/, body);
    }
  });
  test("a built-in the settings name with its own argument and wording", () => {
    const own = builtinSpecs({ sh: { arg: "script", what: "shell script", example: "echo hi", prose: "## sh\n\nRuns scripts." } });
    assert.deepEqual(own.get("sh"), { arg: "script", prose: "## sh\n\nRuns scripts.", what: "shell script", example: "echo hi" });
    assert.equal(builtinSpecs({ bash: false }).size, 0);
  });

  describe("built-ins made of run", () => {
    const run = { name: "run", description: "Run a command.", input_schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } } };
    const perl = { run: "perl -e $message", description: "Run Perl code. It has no state between calls.", what: "Perl code", example: "print 6 * 7" };
    const made = { builtin_tools: { perl } };
    const specs = builtinSpecs(made.builtin_tools);
    const rendered = (tools: ModelContext["tools"], turns: ModelContext["turns"] = []) => renderHarmony({ context: { system: "S", instructions: undefined, tools, cacheHints: [], turns }, options: made, effort: undefined, date: "d", provider: "p", model: "m" }).prompt;

    test("the command is the template with the message as one quoted word that run reads back exactly", () => {
      for (const message of ["print 1", "print 'it\\'s'", "line one\nline two", 'say "hi" $HOME `x` $(y) \\ | > ;']) {
        const command = commandFor("perl -e $message", message);
        const parsed = parseCommand(command, () => "");
        assert.deepEqual(parsed.stages.map((st) => st.map((w) => w.text)), [["perl", "-e", message]], message);
      }
      assert.equal(commandFor("a ${message} b $message", "x"), "a 'x' b 'x'");
      assert.equal(commandFor("p $message$", "$&"), "p '$&'$");
    });
    test("a template without $message is refused when the options are read", () => assert.throws(() => builtinSpecs({ perl: { run: "perl -e" } }), /must contain \$message/));
    test("is described in the system block when run is offered, and not otherwise", () => {
      assert.ok(rendered([run]).includes("## perl\n\nRun Perl code. It has no state between calls."));
      assert.ok(rendered([run]).includes("Example call to perl:\n  channel: analysis\n  recipient: perl\n  message: print 6 * 7"));
      assert.ok(rendered([run]).includes("type run ="), "run stays a function");
      assert.ok(!rendered([write]).includes("## perl"));
    });
    test("a call is a call of run with the quoted message, and keeps the built-in's name and message for the next prompt", () => {
      const p = harmonyParser([run], specs);
      const out = [...p.push("<|channel|>analysis to=perl code<|message|>print 'a'<|call|>"), ...p.end("stop")];
      assert.deepEqual(out.filter((e) => e.kind === "call.start" || e.kind === "call.end"), [
        { kind: "call.start", name: "run" },
        { kind: "call.end", args: { command: `perl -e 'print '"'"'a'"'"''` }, ext: { builtin: { name: "perl", message: "print 'a'" } } },
      ]);
    });
    test("an ambiguous call is refused, and keeps the built-in's name for the next prompt", () => {
      const p = harmonyParser([run], specs);
      const out = [...p.push('<|channel|>analysis to=perl code<|message|>{"a": 1, "b": 2}<|call|>'), ...p.end("stop")];
      const end = out.find((e) => e.kind === "call.end") as Extract<Emit, { kind: "call.end" }>;
      assert.equal(end.raw, '{"a": 1, "b": 2}');
      assert.match(end.error ?? "", /perl was NOT run/);
      assert.deepEqual(end.ext, { builtin: { name: "perl" } });
    });
    test("an earlier call is written back as a call to the built-in, with its result from it", () => {
      const turns: ModelContext["turns"] = [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "1", name: "run", args: { command: "perl -e 'print 42'" }, ext: { builtin: { name: "perl", message: "print 42" } } }, { type: "tool_call", call_id: "2", name: "run", args: { command: "ls" } }] },
        { role: "tool_results", results: [{ call_id: "1", content: "42", is_error: false, truncated: false }, { call_id: "2", content: "a.txt", is_error: false, truncated: false }] },
      ];
      const p = rendered([run], turns);
      assert.ok(p.includes("<|start|>assistant<|channel|>analysis to=perl code<|message|>print 42<|call|><|start|>perl to=assistant<|channel|>analysis<|message|>42<|end|>"));
      assert.ok(p.includes('<|start|>assistant<|channel|>commentary to=functions.run <|constrain|>json<|message|>{"command": "ls"}<|call|>'), "an ordinary call of run is still a function call");
    });
    test("a result with a picture or sound is refused: the format is text only", () => {
      const turns: ModelContext["turns"] = [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "1", name: "run", args: { command: "ls" } }] },
        { role: "tool_results", results: [{ call_id: "1", content: "x", is_error: false, truncated: false, media: [{ type: "attachment", kind: "image", name: "a.png", mime: "image/png", sha256: "0".repeat(64), bytes: Uint8Array.from([1]) }] }] },
      ];
      assert.throws(() => rendered([run], turns), /text only/);
    });
    test("a refused call is written back as the model sent it", () => {
      const turns: ModelContext["turns"] = [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "1", name: "run", args: {}, args_raw: '{"a": 1, "b": 2}', ext: { builtin: { name: "perl" }, call_error: "x" } }] },
        { role: "tool_results", results: [{ call_id: "1", content: "perl was NOT run", is_error: true, truncated: false }] },
      ];
      assert.ok(rendered([run], turns).includes('analysis to=perl code<|message|>{"a": 1, "b": 2}<|call|><|start|>perl to=assistant'));
    });
  });
});
