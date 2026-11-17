/**
 * Schemas of the kinds that tools and MCP servers declare, each with values that satisfy it and values that do not. The expected readable lines
 * for them are recorded in `tool-schema.test.ts`, as the previous validator (ajv) gave them.
 */

export interface Case {
  name: string;
  schema: unknown;
  values: unknown[];
}

const obj = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
  ...extra,
});

export const CASES: Case[] = [
  {
    name: "closed object with required",
    schema: obj({ a: { type: "string" }, b: { type: "integer" } }, ["a"]),
    values: [
      { a: "x" },
      { a: "x", b: 2 },
      {},
      { b: 2 },
      { a: 1 },
      { a: "x", c: 1 },
      { a: "x", b: 1.5 },
      { a: "x", b: "2" },
      [],
      "x",
      null,
      5,
    ],
  },
  {
    name: "open object",
    schema: { type: "object", properties: { a: { type: "string" } } },
    values: [{ a: "x" }, { a: "x", z: 1 }, { a: 1 }, {}],
  },
  { name: "no type but properties", schema: { properties: { a: { type: "string" } } }, values: [{ a: "x" }, { a: 1 }] },
  {
    name: "several missing and unknown",
    schema: obj({ a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }, ["a", "b", "c"]),
    values: [{}, { a: "x", z: 1, y: 2 }, { a: 1, b: 2, c: 3 }],
  },
  { name: "no properties", schema: obj({}), values: [{}, { a: 1 }] },
  { name: "enum", schema: obj({ mode: { enum: ["a", "b"] } }), values: [{ mode: "a" }, { mode: "c" }, { mode: 1 }, {}] },
  { name: "typed enum", schema: obj({ mode: { type: "string", enum: ["a", "b"] } }), values: [{ mode: "c" }, { mode: 1 }] },
  { name: "const", schema: obj({ v: { const: 1 } }), values: [{ v: 1 }, { v: 2 }, { v: "1" }] },
  {
    name: "number range",
    schema: obj({ n: { type: "number", minimum: 1, maximum: 5 } }),
    values: [{ n: 1 }, { n: 5 }, { n: 0 }, { n: 6 }, { n: "3" }, { n: null }],
  },
  {
    name: "integer range",
    schema: obj({ n: { type: "integer", minimum: 0, maximum: 10 } }),
    values: [{ n: 3 }, { n: 3.0 }, { n: 3.5 }, { n: -1 }, { n: 11 }, { n: "x" }, { n: true }],
  },
  {
    name: "exclusive range",
    schema: obj({ n: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 } }),
    values: [{ n: 0.5 }, { n: 0 }, { n: 1 }],
  },
  { name: "multipleOf", schema: obj({ n: { type: "number", multipleOf: 0.5 } }), values: [{ n: 1.5 }, { n: 0.3 }] },
  {
    name: "string length",
    schema: obj({ s: { type: "string", minLength: 2, maxLength: 4 } }),
    values: [{ s: "ab" }, { s: "a" }, { s: "abcde" }, { s: 5 }],
  },
  { name: "string pattern", schema: obj({ s: { type: "string", pattern: "^[a-z]+$" } }), values: [{ s: "abc" }, { s: "ABC" }, { s: "" }] },
  {
    name: "string formats",
    schema: obj({
      d: { type: "string", format: "date-time" },
      e: { type: "string", format: "email" },
      u: { type: "string", format: "uri" },
      i: { type: "string", format: "uuid" },
    }),
    values: [
      { d: "2026-01-02T03:04:05Z" },
      { d: "yesterday" },
      { e: "a@b.test" },
      { e: "nope" },
      { u: "https://x.test/a" },
      { u: "not a uri" },
      { i: "123e4567-e89b-12d3-a456-426614174000" },
      { i: "nope" },
    ],
  },
  {
    name: "date and time formats",
    schema: obj({ d: { type: "string", format: "date" }, t: { type: "string", format: "time" } }),
    values: [{ d: "2026-01-02" }, { d: "2026-13-45" }, { t: "03:04:05Z" }, { t: "late" }],
  },
  {
    name: "array of strings",
    schema: obj({ xs: { type: "array", items: { type: "string" } } }),
    values: [{ xs: [] }, { xs: ["a"] }, { xs: [1] }, { xs: ["a", 2, "c", 4] }, { xs: "a" }, { xs: { 0: "a" } }],
  },
  {
    name: "array bounds",
    schema: obj({ xs: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 2 } }),
    values: [{ xs: [1] }, { xs: [] }, { xs: [1, 2, 3] }],
  },
  {
    name: "unique items",
    schema: obj({ xs: { type: "array", items: { type: "integer" }, uniqueItems: true } }),
    values: [{ xs: [1, 2] }, { xs: [1, 1] }],
  },
  {
    name: "array of objects",
    schema: obj({ files: { type: "array", minItems: 1, items: obj({ path: { type: "string" }, mode: { enum: ["a", "b"] } }, ["path"]) } }, [
      "files",
    ]),
    values: [
      { files: [{ path: "a" }] },
      { files: [{}] },
      { files: [{ path: 1 }, { mode: "c" }, { path: "a", x: 1 }] },
      { files: [] },
      { files: ["a"] },
    ],
  },
  {
    name: "nested objects",
    schema: obj({ a: obj({ b: obj({ c: { type: "integer" } }, ["c"]) }, ["b"]) }, ["a"]),
    values: [{ a: { b: { c: 1 } } }, { a: {} }, { a: { b: {} } }, { a: { b: { c: "x" } } }, { a: { b: { c: 1, d: 2 } } }],
  },
  {
    name: "nullable by anyOf",
    schema: obj({ a: { anyOf: [{ type: "string" }, { type: "null" }] } }),
    values: [{ a: "x" }, { a: null }, { a: 5 }, {}],
  },
  { name: "type list", schema: obj({ a: { type: ["string", "null"] } }), values: [{ a: "x" }, { a: null }, { a: 5 }] },
  { name: "type list of three", schema: obj({ a: { type: ["string", "number", "null"] } }), values: [{ a: true }, { a: 1 }] },
  {
    name: "oneOf of scalars",
    schema: obj({ a: { oneOf: [{ type: "string" }, { type: "number" }] } }),
    values: [{ a: "x" }, { a: 1 }, { a: true }],
  },
  { name: "oneOf both match", schema: obj({ a: { oneOf: [{ type: "number" }, { type: "integer" }] } }), values: [{ a: 1 }, { a: 1.5 }] },
  {
    name: "anyOf with patterns",
    schema: obj({ a: { anyOf: [{ type: "string", pattern: "^a" }, { type: "integer" }] } }),
    values: [{ a: "ab" }, { a: 3 }, { a: "zz" }, { a: 1.5 }],
  },
  {
    name: "choice of objects",
    schema: obj({
      a: {
        oneOf: [
          obj({ kind: { const: "x" }, v: { type: "string" } }, ["kind", "v"]),
          obj({ kind: { const: "y" }, n: { type: "integer" } }, ["kind", "n"]),
        ],
      },
    }),
    values: [{ a: { kind: "x", v: "s" } }, { a: { kind: "y", n: 1 } }, { a: { kind: "x" } }, { a: { kind: "z" } }, { a: "x" }],
  },
  {
    name: "allOf",
    schema: { type: "object", allOf: [{ required: ["a"] }, { properties: { a: { type: "string" } } }] },
    values: [{ a: "x" }, {}, { a: 1 }],
  },
  { name: "not", schema: obj({ a: { not: { type: "string" } } }), values: [{ a: 1 }, { a: "x" }] },
  {
    name: "if then else",
    schema: { type: "object", properties: { k: { type: "string" } }, if: { properties: { k: { const: "x" } } }, then: { required: ["v"] } },
    values: [{ k: "y" }, { k: "x" }, { k: "x", v: 1 }],
  },
  {
    name: "$defs reference",
    schema: {
      type: "object",
      properties: { a: { $ref: "#/$defs/s" }, b: { type: "array", items: { $ref: "#/$defs/s" } } },
      $defs: { s: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    values: [{ a: "x", b: ["y"] }, { a: "" }, { a: 1 }, { b: [1] }],
  },
  {
    name: "definitions reference",
    schema: { type: "object", properties: { a: { $ref: "#/definitions/s" } }, definitions: { s: { type: "integer" } } },
    values: [{ a: 1 }, { a: "x" }],
  },
  {
    name: "recursive reference",
    schema: {
      type: "object",
      properties: { tree: { $ref: "#/$defs/node" } },
      $defs: {
        node: {
          type: "object",
          properties: { v: { type: "integer" }, kids: { type: "array", items: { $ref: "#/$defs/node" } } },
          required: ["v"],
          additionalProperties: false,
        },
      },
    },
    values: [{ tree: { v: 1, kids: [{ v: 2 }] } }, { tree: { v: 1, kids: [{ v: "x" }] } }, { tree: {} }],
  },
  {
    name: "draft-07 schema keyword",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    },
    values: [{ a: "x" }, { a: 1 }, { b: 1 }],
  },
  {
    name: "2020-12 schema keyword",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { a: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false } },
    },
    values: [{ a: ["x", 1] }, { a: ["x", "y"] }, { a: ["x", 1, 2] }],
  },
  {
    name: "2019-09 schema keyword",
    schema: { $schema: "https://json-schema.org/draft/2019-09/schema", type: "object", properties: { a: { type: "integer", minimum: 1 } } },
    values: [{ a: 1 }, { a: 0 }],
  },
  {
    name: "$id present",
    schema: { $id: "https://x.test/tool", type: "object", properties: { a: { type: "string" } } },
    values: [{ a: "x" }, { a: 1 }],
  },
  {
    name: "annotations only",
    schema: {
      type: "object",
      title: "T",
      description: "D",
      properties: { a: { type: "string", title: "A", description: "d", default: "q", examples: ["e"] } },
    },
    values: [{ a: "x" }, { a: 1 }],
  },
  {
    name: "unknown keywords",
    schema: { type: "object", "x-vendor": 1, properties: { a: { type: "string", "x-foo": { y: 1 } } } },
    values: [{ a: "x" }, { a: 1 }],
  },
  { name: "propertyNames", schema: { type: "object", propertyNames: { pattern: "^[a-z]+$" } }, values: [{ ab: 1 }, { AB: 1 }] },
  {
    name: "additionalProperties schema",
    schema: { type: "object", additionalProperties: { type: "integer" } },
    values: [{ a: 1 }, { a: "x" }],
  },
  {
    name: "patternProperties",
    schema: { type: "object", patternProperties: { "^x_": { type: "integer" } }, additionalProperties: false },
    values: [{ x_a: 1 }, { x_a: "s" }, { y: 1 }],
  },
  {
    name: "dependentRequired",
    schema: { type: "object", properties: { a: {}, b: {} }, dependentRequired: { a: ["b"] } },
    values: [{ a: 1, b: 2 }, { a: 1 }, {}],
  },
  { name: "minProperties", schema: { type: "object", minProperties: 1, maxProperties: 2 }, values: [{}, { a: 1 }, { a: 1, b: 2, c: 3 }] },
  { name: "contains", schema: obj({ xs: { type: "array", contains: { const: 1 } } }), values: [{ xs: [1, 2] }, { xs: [2] }] },
  {
    name: "boolean and null values",
    schema: obj({ b: { type: "boolean" }, n: { type: "null" } }),
    values: [{ b: true, n: null }, { b: "true" }, { n: 0 }],
  },
  { name: "empty schema members", schema: obj({ anything: {}, tf: true }), values: [{ anything: 1 }, { anything: null, tf: "x" }] },
  {
    name: "huge number of errors",
    schema: obj(
      Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, { type: "string" }])),
      Array.from({ length: 12 }, (_, i) => `p${i}`),
    ),
    values: [{}, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, i]))],
  },
];

/** Schemas the registry must refuse, with what it should say. */
export const UNUSABLE: { name: string; schema: unknown }[] = [
  { name: "remote reference", schema: { type: "object", properties: { a: { $ref: "https://elsewhere.test/a.json" } } } },
  { name: "missing local reference", schema: { type: "object", properties: { a: { $ref: "#/$defs/nowhere" } } } },
  { name: "unknown type name", schema: { type: "object", properties: { a: { type: "strng" } } } },
  { name: "pattern that is not a regular expression", schema: { type: "object", properties: { a: { type: "string", pattern: "(" } } } },
  { name: "required that is not a list", schema: { type: "object", required: "a" } },
  { name: "properties that is not an object", schema: { type: "object", properties: 5 } },
  { name: "not an object schema", schema: { type: "string" } },
  { name: "a string", schema: "x" },
  { name: "an array", schema: [] },
  { name: "null", schema: null },
];
