import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemoryBlobStore, sha256Hex } from "../../src/index.ts";
import { hashDefinition, loadDefinitions } from "../../harness/definitions.ts";
import { foldSetup } from "../../harness/setup.ts";
import { checkSchema, coerceArgs, flatProblems, validateArgs } from "../../harness/tool-schema.ts";
import { DEFAULT_RESULT_LIMIT, ToolError, ToolRegistry, isStarted, shapeResult, type Tool } from "../../harness/tools.ts";

const read = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "relative path" }, offset: { type: "integer", minimum: 0 }, mode: { type: "string", enum: ["a", "b"] } } },
    },
    verbose: { type: "boolean" },
  },
};
const tool = (name: string, schema: unknown = read): Tool => ({ definition: { name, description: `${name} tool`, input_schema: schema as Record<string, unknown> }, async execute() { return { content: "ok" }; } });

describe("the portable schema subset", () => {
  test("accepts objects, arrays of objects, scalars and enums", () => {
    assert.deepEqual(checkSchema(read), []);
    assert.deepEqual(checkSchema({ type: "object", additionalProperties: false }), []);
  });

  test("rejects what providers disagree on, naming where", () => {
    const bad = (schema: unknown, re: RegExp) => assert.match(checkSchema(schema).join("\n"), re);
    bad({ type: "object" }, /additionalProperties: false/);
    bad({ type: "array", items: { type: "string" } }, /must be an object/);
    bad({ type: "object", additionalProperties: false, properties: { a: { oneOf: [{ type: "string" }] } } }, /a needs a single `type`/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: ["string", "null"] } } }, /a needs a single `type`/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: "string", pattern: "x" } } }, /`pattern` is not in the portable subset for string/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: "string", format: "uri" } } }, /`format`/);
    bad({ type: "object", additionalProperties: false, properties: { a: { $ref: "#/x" } } }, /a needs a single `type`/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: "array" } } }, /arrays need `items`/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: "object", properties: {} } } }, /a: objects must set additionalProperties: false/);
    bad({ type: "object", additionalProperties: false, required: ["zz"] }, /names zz, which is not a property/);
    bad({ type: "object", additionalProperties: false, properties: { a: { type: "string", enum: [] } } }, /enum must be a non-empty list/);
    bad("not a schema", /not an object/);
  });

  test("validates arguments with readable paths", () => {
    const ok = { files: [{ path: "a.txt", offset: 3, mode: "a" }], verbose: true };
    assert.deepEqual(validateArgs(read, ok), []);
    const v = (value: unknown) => validateArgs(read, value).join("\n");
    assert.match(v({}), /files is required/);
    assert.match(v({ files: [] }), /files needs at least 1 item/);
    assert.match(v({ files: [{ path: 3 }] }), /files\[0\]\.path must be text/);
    assert.match(v({ files: [{ path: "a", offset: 1.5 }] }), /files\[0\]\.offset must be a whole number/);
    assert.match(v({ files: [{ path: "a", offset: -1 }] }), /files\[0\]\.offset must be at least 0/);
    assert.match(v({ files: [{ path: "a", mode: "c" }] }), /files\[0\]\.mode must be one of "a", "b"/);
    assert.match(v({ files: [{ path: "a", extra: 1 }] }), /files\[0\]\.extra is not a known argument \(known: path, offset, mode\)/);
    assert.match(v({ files: [{ path: "a" }], verbose: "yes" }), /verbose must be true or false/);
    assert.match(v([]), /the arguments must be an object/);
    assert.match(v({ files: "a" }), /files must be a list/);
  });
});

describe("the registry", () => {
  test("rejects bad names, duplicates, empty descriptions and schemas outside the subset", () => {
    const r = new ToolRegistry();
    assert.throws(() => r.add(tool("1bad")), ToolError);
    assert.throws(() => r.add(tool("has space")), ToolError);
    assert.throws(() => r.add({ ...tool("x"), definition: { name: "x", description: " ", input_schema: read } }), /needs a description/);
    assert.throws(() => r.add(tool("x", { type: "object" })), /additionalProperties/);
    r.add(tool("x"));
    assert.throws(() => r.add(tool("x")), /registered twice/);
  });

  test("definitions come out sorted by name whatever the registration order", () => {
    const a = new ToolRegistry([tool("write"), tool("read"), tool("edit")]);
    const b = new ToolRegistry([tool("edit"), tool("read"), tool("write")]);
    assert.deepEqual(a.names(), ["edit", "read", "write"]);
    assert.deepEqual(a.definitions(), b.definitions());
  });

  test("pins every definition into the blob store, and loads them back as the same list", async () => {
    const blobs = new MemoryBlobStore();
    const r = new ToolRegistry([tool("write"), tool("read")]);
    const pins = await r.pin(blobs);
    assert.deepEqual(Object.keys(pins).sort(), ["read", "write"]);
    assert.equal(pins["read"]?.hash, await hashDefinition("tool", r.get("read")?.definition));
    assert.equal(pins["read"]?.store, "blob");
    const setup = foldSetup([{ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: { provider: "p", id: "m" }, tools: { set: pins } }]);
    assert.deepEqual((await loadDefinitions(setup, { blobs })).tools, r.definitions());
  });

  test("check turns a model's bad call into the message to send back", () => {
    const r = new ToolRegistry([tool("read")]);
    const good = r.check({ name: "read", args: { files: [{ path: "a" }] } });
    assert.ok("tool" in good && good.tool.definition.name === "read");
    const err = (c: Parameters<ToolRegistry["check"]>[0]) => ("error" in r.check(c) ? (r.check(c) as { error: string }).error : "");
    assert.match(err({ name: "nope", args: {} }), /no tool called nope; the tools are: read/);
    assert.match(err({ name: "read", args: {}, args_raw: "{files: [" }), /not valid JSON: \{files: \[/);
    assert.match(err({ name: "read", args: {}, args_raw: "x".repeat(500) }), /x{200}\.\.\./);
    assert.match(err({ name: "read", args: { files: 3 } }), /^read: files must be a list/);
  });

  test("a started job is told apart from an output", () => {
    assert.equal(isStarted({ content: "x" }), false);
    assert.equal(isStarted({ started: { summary: "job", done: Promise.resolve({ content: "" }), stop() {} } }), true);
  });
});

describe("result shaping", () => {
  test("output within the limit is untouched, and an error flag is carried", async () => {
    assert.deepEqual(await shapeResult({ content: "hello" }), { content: "hello", is_error: false, truncated: false });
    assert.deepEqual(await shapeResult({ content: "bad", is_error: true }), { content: "bad", is_error: true, truncated: false });
    const exact = "a".repeat(DEFAULT_RESULT_LIMIT);
    assert.equal((await shapeResult({ content: exact })).truncated, false);
  });

  test("long output keeps its head and tail with a marker, and the full bytes go where `keep` says", async () => {
    const blobs = new MemoryBlobStore();
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = await shapeResult({ content: lines }, { limit: 1000, keep: async (b) => `blob:${await blobs.put(b)}` });
    assert.equal(r.truncated, true);
    assert.match(r.content, /^line 0\nline 1\n/);
    assert.match(r.content, /line 4999$/);
    const m = /\.\.\. (\d+) of (\d+) bytes omitted; the full output is blob:([0-9a-f]{64}) \.\.\./.exec(r.content);
    assert.ok(m);
    assert.equal(Number(m[2]), new TextEncoder().encode(lines).length);
    assert.equal(new TextDecoder().decode(await blobs.get(m[3] as string)), lines);
    assert.equal(m[3], await sha256Hex(new TextEncoder().encode(lines)));
    assert.ok(new TextEncoder().encode(r.content).length < 1200);
  });

  test("without `keep` the marker only says how much is gone; nothing is stored", async () => {
    const r = await shapeResult({ content: "x".repeat(5000) }, { limit: 1000 });
    assert.match(r.content, /\.\.\. \d+ of 5000 bytes omitted \.\.\./);
    assert.doesNotMatch(r.content, /full output/);
  });

  test("never cuts inside a multi-byte character", async () => {
    for (const unit of ["é", "日本", "😀"]) {
      for (let limit = 100; limit < 112; limit++) {
        const r = await shapeResult({ content: unit.repeat(400) }, { limit });
        assert.equal(r.truncated, true);
        assert.doesNotMatch(r.content, /�/, `${unit} at limit ${limit}`);
      }
    }
  });
});

describe("flat schemas", () => {
  const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties });
  test("scalars and lists of scalars are flat; objects and lists of objects or lists are not, each named", () => {
    assert.deepEqual(flatProblems(obj({ a: { type: "string" }, b: { type: "integer" }, c: { type: "boolean", enum: [true] }, d: { type: "array", items: { type: "string" } } })), []);
    assert.deepEqual(flatProblems(obj({ files: { type: "array", items: obj({ path: { type: "string" } }) }, cfg: obj({}), m: { type: "array", items: { type: "array", items: { type: "string" } } } })), ["files is a list of objects", "cfg is an object", "m is a list of arrays"]);
    assert.deepEqual(flatProblems(obj({})), []);
  });
});

describe("repairing slips the models in the live runs made", () => {
  const read = { type: "object", additionalProperties: false, required: ["files"], properties: { files: { type: "array", items: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } } } } } };
  const run = { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" }, stdin: { type: "string" }, timeout_seconds: { type: "integer" } } };
  test("a list of bare strings where objects with one required text property belong", () => {
    assert.deepEqual(coerceArgs(read, { files: ["a.txt", "b.txt"] }), { files: [{ path: "a.txt" }, { path: "b.txt" }] });
    assert.deepEqual(coerceArgs(read, { files: "a.txt" }), { files: [{ path: "a.txt" }] });
    assert.deepEqual(coerceArgs(read, { files: [{ path: "a.txt" }] }), { files: [{ path: "a.txt" }] });
  });
  test("optional arguments sent as null or empty text are not given; required ones are left for validation", () => {
    assert.deepEqual(coerceArgs(run, { command: "ls", stdin: "", timeout_seconds: null }), { command: "ls" });
    assert.deepEqual(coerceArgs(run, { command: "", stdin: "x" }), { command: "", stdin: "x" });
    assert.deepEqual(coerceArgs(run, { command: "ls", timeout_seconds: 120 }), { command: "ls", timeout_seconds: 120 });
  });
  test("a tool's own normalize runs first", () => {
    const reg = new ToolRegistry([{ definition: { name: "t", description: "d", input_schema: run }, normalize: (a) => ({ command: (a as { cmd: string }).cmd }), execute: async () => ({ content: "" }) }]);
    assert.deepEqual((reg.check({ name: "t", args: { cmd: "ls" } }) as { args: unknown }).args, { command: "ls" });
  });
});

describe("repairing unambiguous slips in arguments", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      files: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, limit: { type: "integer" } } } },
      argv: { type: "array", items: { type: "string" } },
      timeout: { type: "integer" },
      append: { type: "boolean" },
      note: { type: "string" },
    },
  };
  const fix = (v: unknown) => coerceArgs(schema, v);
  test("a lone item becomes a list, JSON text becomes the value, text numbers and booleans are converted", () => {
    assert.deepEqual(fix({ files: { path: "a" } }), { files: [{ path: "a" }] });
    assert.deepEqual(fix({ files: '[{"path":"a"}]' }), { files: [{ path: "a" }] });
    assert.deepEqual(fix({ argv: "ls" }), { argv: ["ls"] });
    assert.deepEqual(fix({ argv: '["ls","-la"]' }), { argv: ["ls", "-la"] });
    assert.deepEqual(fix({ files: [{ path: "a", limit: "5" }], timeout: " 30 ", append: "True", note: 7 }), { files: [{ path: "a", limit: 5 }], timeout: 30, append: true, note: "7" });
    assert.deepEqual(fix('{"argv":["x"]}'), { argv: ["x"] });
  });
  test("anything that could mean more than one thing is left for validation to report", () => {
    assert.deepEqual(fix({ timeout: "soon", append: "yes", files: "a.txt", argv: {} }), { timeout: "soon", append: "yes", files: "a.txt", argv: {} });
    assert.deepEqual(fix({ extra: "1" }), { extra: "1" });
    const input = { files: { path: "a" } };
    fix(input);
    assert.deepEqual(input, { files: { path: "a" } }, "the input is not changed");
  });
  test("the registry validates the repaired call and hands the tool the repaired arguments", () => {
    const reg = new ToolRegistry([{ definition: { name: "t", description: "d", input_schema: schema }, execute: async () => ({ content: "" }) }]);
    const r = reg.check({ name: "t", args: { files: { path: "a" }, timeout: "9" } });
    assert.ok(!("error" in r));
    assert.deepEqual((r as { args: unknown }).args, { files: [{ path: "a" }], timeout: 9 });
    assert.match((reg.check({ name: "t", args: { timeout: "soon" } }) as { error: string }).error, /timeout must be a number/);
  });
});
