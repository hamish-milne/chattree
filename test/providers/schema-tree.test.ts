import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { argNode, concreteTypes, isNullable, parseSchema } from "../../providers/dialects/schema-tree.ts";

describe("the schema tree", () => {
  test("reads types, descriptions, enums, properties and requirements", () => {
    const n = parseSchema({ type: "object", description: "D", required: ["a"], properties: { a: { type: "string", enum: ["x", "y"] }, b: { type: ["integer", "null"] }, c: { type: "array", items: { type: "string" } } } });
    assert.deepEqual(n.types, ["object"]);
    assert.equal(n.description, "D");
    assert.deepEqual(n.required, ["a"]);
    assert.deepEqual(n.properties?.map(([k]) => k), ["a", "b", "c"]);
    const [, a] = n.properties?.[0] ?? [];
    assert.deepEqual(a?.enum, ["x", "y"]);
    const [, b] = n.properties?.[1] ?? [];
    assert.deepEqual(concreteTypes(b!), ["integer"]);
    assert.ok(isNullable(b!));
    assert.deepEqual(n.properties?.[2]?.[1].items?.types, ["string"]);
  });
  test("follows local references, and takes what it does not understand as any", () => {
    const n = parseSchema({ properties: { p: { $ref: "#/$defs/P", description: "mine" }, q: "nonsense" }, $defs: { P: { type: "number" } } });
    const [, p] = n.properties?.[0] ?? [];
    assert.deepEqual(p?.types, ["number"]);
    assert.equal(p?.description, "mine");
    assert.deepEqual(n.properties?.[1]?.[1].types, []);
  });
  test("finds the node of a tool's argument", () => {
    const tools = [{ name: "t", input_schema: { properties: { n: { type: "integer" } } } }];
    assert.deepEqual(argNode(tools, "t", "n")?.types, ["integer"]);
    assert.equal(argNode(tools, "t", "zz"), undefined);
    assert.equal(argNode(tools, "other", "n"), undefined);
  });
});
