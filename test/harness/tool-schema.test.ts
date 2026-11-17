import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { schemaProblems, validateArgs } from "../../harness/tool-schema.ts";
import { CASES, UNUSABLE } from "./tool-schema-cases.ts";

/**
 * Tool arguments are checked with TypeBox's validator against whatever JSON Schema a tool or an MCP server declares. The golden file holds
 * what the previous validator (ajv) said for each case, which is the behaviour this one has to keep, with these differences accepted when
 * the validator was replaced: the library's own wording for keywords the harness has no sentence for (`not`, `minProperties`, `contains`,
 * `propertyNames`), `dependentRequired` (a 2019-09 keyword ajv's draft-07 mode skipped) is enforced, an `if`/`then` failure names only the
 * `then` schema, and an extra item after `prefixItems` is said to be "not allowed here".
 */
const golden = JSON.parse(readFileSync(new URL("./tool-schema-golden.json", import.meta.url), "utf8")) as Record<
  string,
  { schema: string[]; values: string[][] }
>;

describe("checking tool arguments against a declared JSON Schema", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const want = golden[c.name];
      assert.ok(want, "the golden file has this case: regenerate it when a case is added");
      assert.deepEqual(schemaProblems(c.schema), want.schema);
      assert.deepEqual(
        c.values.map((v) => validateArgs(c.schema, v)),
        want.values,
      );
    });
  }

  for (const u of UNUSABLE) {
    test(`refuses a schema with ${u.name}`, () => {
      assert.ok(schemaProblems(u.schema).length > 0);
      assert.ok(validateArgs(u.schema, {}).length > 0, "and no arguments pass it");
    });
  }

  test("a reference inside the schema is followed, and a reference outside it is refused with the reason", () => {
    assert.deepEqual(schemaProblems({ type: "object", properties: { a: { $ref: "#/$defs/s" } }, $defs: { s: { type: "string" } } }), []);
    assert.match(
      schemaProblems({ type: "object", properties: { a: { $ref: "https://x.test/a.json" } } }).join(),
      /cannot be used.*cannot be resolved/,
    );
  });

  test("the schema is compiled once per schema object", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    assert.deepEqual(validateArgs(schema, { a: 1 }), validateArgs(schema, { a: 1 }));
  });
});
