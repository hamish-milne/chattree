import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { runLoop, syncTools, ToolsNotSupported } from "../../harness/loop.ts";
import { projectDefinitions, projectSchema } from "../../harness/schema-project.ts";
import { leafTools } from "../../harness/starter/index.ts";
import { skillTool } from "../../harness/skill-tool.ts";
import { envSource } from "../../harness/secrets.ts";
import { coerceArgs, schemaProblems, validateArgs } from "../../harness/tool-schema.ts";
import { ToolRegistry, type Tool } from "../../harness/tools.ts";
import { AdapterRegistry, defineAdapter, type ToolSchemaLevel } from "../../providers/registry.ts";
import type { Completed, StreamRequest } from "../../providers/types.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();

describe("validating arguments against the schema as written", () => {
  const v = (schema: unknown, value: unknown) => validateArgs(schema, value).join("\n");
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

  test("pattern, format, length and const are enforced, in plain words", () => {
    const s = obj({ id: { type: "string", pattern: "^[a-z]+$" }, url: { type: "string", format: "uri" }, mail: { type: "string", format: "email" }, code: { type: "string", minLength: 3, maxLength: 4 }, kind: { const: "x" } });
    assert.equal(v(s, { id: "abc", url: "https://a.test/x", mail: "a@b.test", code: "abc", kind: "x" }), "");
    assert.match(v(s, { id: "ABC" }), /id must match the pattern \^\[a-z\]\+\$/);
    assert.match(v(s, { url: "not a url" }), /url must be a valid uri/);
    assert.match(v(s, { mail: "nope" }), /mail must be a valid email/);
    assert.match(v(s, { code: "ab" }), /code needs at least 3 characters/);
    assert.match(v(s, { code: "abcde" }), /code takes at most 4 characters/);
    assert.match(v(s, { kind: "y" }), /kind must be "x"/);
  });

  test("a choice between shapes is one line, not a line per branch; references and nullable types are followed", () => {
    const s = { ...obj({ a: { anyOf: [{ type: "string" }, { type: "integer" }] }, m: { $ref: "#/$defs/mode" }, n: { type: ["string", "null"] } }), $defs: { mode: { type: "string", enum: ["fast", "slow"] } } };
    assert.equal(v(s, { a: 3, m: "fast", n: null }), "");
    assert.equal(v(s, { a: "x", m: "slow", n: "y" }), "");
    assert.equal(v(s, { a: true }), "a does not match any of the shapes it may have");
    assert.match(v(s, { m: "medium" }), /m must be one of "fast", "slow"/);
  });

  test("an integer given text is not a number; a number given 1.5 is not whole; paths read as before", () => {
    const s = obj({ n: { type: "integer", minimum: 1 }, list: { type: "array", items: obj({ p: { type: "string" } }, ["p"]), minItems: 1 } }, ["list"]);
    assert.match(v(s, { list: [{ p: "a" }], n: "soon" }), /n must be a number/);
    assert.match(v(s, { list: [{ p: "a" }], n: 1.5 }), /n must be a whole number/);
    assert.match(v(s, { list: [{}] }), /list\[0\]\.p is required/);
    assert.match(v(s, {}), /list is required \(the arguments are: n, list\)/);
  });

  test("draft 2020-12 and draft-07 schemas both work, and a reference outside the schema is a reason to refuse the tool", () => {
    const d7 = { $schema: "http://json-schema.org/draft-07/schema#", ...obj({ t: { type: "array", items: [{ type: "string" }, { type: "integer" }] } }) };
    assert.deepEqual(schemaProblems(d7), []);
    assert.equal(v(d7, { t: ["a", 1] }), "");
    const d2020 = { $schema: "https://json-schema.org/draft/2020-12/schema", ...obj({ t: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] } }) };
    assert.deepEqual(schemaProblems(d2020), []);
    assert.match(v(d2020, { t: [1, 1] }), /t\[0\] must be text/);
    assert.match(schemaProblems(obj({ x: { $ref: "https://elsewhere.test/x.json" } })).join(), /cannot be used/);
    assert.match(schemaProblems({ type: "string" }).join(), /must describe an object/);
  });

  test("repairs follow references and nullable types", () => {
    const s = { ...obj({ list: { $ref: "#/$defs/names" }, n: { type: ["integer", "null"] } }), $defs: { names: { type: "array", items: { type: "string" } } } };
    assert.deepEqual(coerceArgs(s, { list: "a", n: "5" }), { list: ["a"], n: 5 });
    assert.deepEqual(coerceArgs(s, { list: ["a"], n: null }), { list: ["a"] });
  });
});

describe("what a model is shown of a schema", () => {
  const rich = { type: "object", properties: { url: { type: "string", format: "uri", description: "where" }, either: { anyOf: [{ type: "string" }, { type: "integer" }] } }, required: ["url"] };

  test("full passes it on as written, minus the document's own name; portable narrows it", () => {
    const full = projectSchema({ $schema: "http://json-schema.org/draft-07/schema#", $id: "x", ...rich }, "full");
    assert.ok(full.ok);
    assert.deepEqual(full.ok && full.schema, rich);
    const portable = projectSchema(rich, "portable");
    assert.ok(portable.ok);
    assert.deepEqual(portable.ok && (portable.schema["properties"] as Record<string, unknown>)["url"], { type: "string", description: 'where (format: "uri")' });
    assert.ok(!projectSchema({ type: "object", properties: { o: { type: "object" } }, required: ["o"] }, "portable").ok);
    assert.ok(projectSchema({ type: "object", properties: { o: { type: "object" } }, required: ["o"] }, "full").ok);
  });

  test("the harness's own tools are the same either way", () => {
    const defs = [...leafTools(), skillTool()].map((t) => t.definition);
    for (const d of defs) {
      assert.deepEqual(projectSchema(d.input_schema, "portable").ok && (projectSchema(d.input_schema, "portable") as { schema: unknown }).schema, d.input_schema, d.name);
    }
    const out = projectDefinitions(defs, "portable");
    assert.deepEqual(out.refused, []);
    assert.deepEqual(out.tools, defs);
  });
});

describe("a request carries each model's own view", () => {
  let level: ToolSchemaLevel | undefined;
  let info: ToolSchemaLevel | undefined;
  let seen: StreamRequest["context"]["tools"] = [];
  const reply: Completed = { blocks: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, observed: { model: "m1" }, ext: {} };
  const adapters = new AdapterRegistry().register(
    defineAdapter({
      $tag: "fake",
      config: z.strictObject({ $tag: z.literal("fake") }),
      settings: z.strictObject({}),
      jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
      secrets: () => [],
      models: () => (info === undefined ? {} : { m1: { tool_schema: info } }),
      create: () => ({
        $tag: "fake",
        ...(level === undefined ? {} : { toolSchema: level }),
        async *stream(req) {
          seen = req.context.tools;
          return reply;
        },
      }),
    }),
  );
  const rich: Tool = {
    definition: { name: "rich", description: "a tool with a pattern and a choice", input_schema: { type: "object", properties: { id: { type: "string", pattern: "^[a-z]+$" }, either: { anyOf: [{ type: "string" }, { type: "integer" }] } }, required: ["id"] } },
    execute: () => Promise.resolve({ content: "ran" }),
  };
  async function run(registry: ToolRegistry) {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), { providers: { registry: adapters, secrets: envSource({}) }, config: "providers:\n  f:\n    $tag: fake\n" });
    await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
    await syncTools(convo, registry);
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
    const gen = runLoop(convo, { system: "s", cost: false, registry });
    for (;;) if ((await gen.next()).done) break;
    return convo;
  }

  test("an adapter that takes full schemas is given the tool as written; the default is the portable subset; the model's own info wins", async () => {
    const registry = new ToolRegistry([rich]);
    level = "full";
    info = undefined;
    await run(registry);
    assert.deepEqual(seen[0]?.input_schema, rich.definition.input_schema);

    level = undefined;
    await run(registry);
    const props = (seen[0]?.input_schema as { properties: Record<string, { description?: string }> }).properties;
    assert.match(props["id"]?.description ?? "", /pattern: "\^\[a-z\]\+\$"/);
    assert.equal(props["either"], undefined, "an optional choice the subset cannot say is left out");

    level = "full";
    info = "portable";
    await run(registry);
    assert.notDeepEqual(seen[0]?.input_schema, rich.definition.input_schema);
    info = undefined;
  });

  test("a portable-only model is refused a tool it cannot be shown, with the reason; a full one takes it", async () => {
    const hard: Tool = { definition: { name: "hard", description: "needs a free-form object", input_schema: { type: "object", properties: { o: { type: "object" } }, required: ["o"] } }, execute: () => Promise.resolve({ content: "x" }) };
    const registry = new ToolRegistry([hard]);
    level = undefined;
    await assert.rejects(run(registry), (e: unknown) => e instanceof ToolsNotSupported && /portable subset[\s\S]*hard \(o is a free-form object/.test(e.message));
    level = "full";
    await run(registry);
  });

  test("a call is checked against the schema as written even where the model was shown less", async () => {
    const registry = new ToolRegistry([rich]);
    assert.match((registry.check({ name: "rich", args: { id: "ABC" } }) as { error: string }).error, /id must match the pattern/);
    assert.ok(!("error" in registry.check({ name: "rich", args: { id: "abc", either: 3 } })));
  });
});
