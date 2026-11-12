/**
 * A tool's input schema as a small typed tree, which the dialects read instead of poking at JSON Schema: Harmony writes it as TypeScript,
 * Gemma as braces, and the argument parsers of Qwen and Gemma coerce text by it. A tool keeps its schema as JSON Schema (it may come from
 * an MCP server, which no schema library takes whole); `parseSchema` reads that into this tree once, following local `$ref`s, and anything
 * it does not understand becomes an `any` node rather than an error, since a dialect only describes the schema to the model.
 */

type Json = Record<string, unknown>;
const isMap = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface SchemaNode {
  /** The type names as written (`"string"`, `"null"`, …); empty when the schema names none. */
  types: string[];
  /** Whether `type` was written as a list. */
  typeList: boolean;
  /** `nullable: true` was written (the OpenAPI way to allow null). */
  nullableKeyword: boolean;
  description?: string;
  enum?: unknown[];
  /** `const`, wrapped so that `null` can be told from absent. */
  const?: { value: unknown };
  /** The alternatives of `anyOf` or `oneOf`. */
  union?: SchemaNode[];
  items?: SchemaNode;
  /** Declared properties, in the order written. */
  properties?: [string, SchemaNode][];
  required: string[];
  /** The schema as written (references followed), for the few places a format passes unknown keywords on. */
  raw: Json;
}

const MAX_DEPTH = 12;

/** The tree for a schema; `root` is the schema that `$ref`s are resolved against (by default the schema itself). */
export function parseSchema(schema: unknown, root: unknown = schema, depth = 0): SchemaNode {
  let s: Json = isMap(schema) ? schema : {};
  const ref = s["$ref"];
  if (typeof ref === "string" && depth < MAX_DEPTH) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    const target = m === null || !isMap(root) ? undefined : (root[m[1] as string] as Json | undefined)?.[m[2] as string];
    if (isMap(target)) s = { ...target, ...(typeof s["description"] === "string" ? { description: s["description"] } : {}) };
  }
  const type = s["type"];
  const props = s["properties"];
  const alt = s["anyOf"] ?? s["oneOf"];
  const node: SchemaNode = {
    types: Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [],
    typeList: Array.isArray(type),
    nullableKeyword: s["nullable"] === true,
    required: Array.isArray(s["required"]) ? s["required"].map(String) : [],
    raw: s,
  };
  if (typeof s["description"] === "string") node.description = s["description"];
  if (Array.isArray(s["enum"])) node.enum = s["enum"];
  if ("const" in s) node.const = { value: s["const"] };
  if (Array.isArray(alt)) node.union = alt.map((a) => parseSchema(a, root, depth + 1));
  if (isMap(s["items"])) node.items = parseSchema(s["items"], root, depth + 1);
  if (isMap(props)) node.properties = Object.entries(props).map(([k, v]) => [k, parseSchema(v, root, depth + 1)]);
  return node;
}

/** The type names without `null`. */
export const concreteTypes = (n: SchemaNode): string[] => n.types.filter((t) => t !== "null");

/** Whether the schema allows null. */
export const isNullable = (n: SchemaNode): boolean => n.nullableKeyword || n.types.includes("null");

/** The tree of a tool's input schema. */
export const toolSchema = (tool: { input_schema: Json }): SchemaNode => parseSchema(tool.input_schema);

/** The node of one argument of a tool, if the tool and the argument are known. */
export function argNode(tools: readonly { name: string; input_schema: Json }[], tool: string, arg: string): SchemaNode | undefined {
  const t = tools.find((x) => x.name === tool);
  return t === undefined ? undefined : toolSchema(t).properties?.find(([k]) => k === arg)?.[1];
}
