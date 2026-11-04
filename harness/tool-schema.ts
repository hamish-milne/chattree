/**
 * The portable subset of JSON Schema that tool definitions may use (docs/tools.md, 3.6).
 *
 * Providers differ on what they accept, and local servers compile schemas to grammars, so the canonical format is
 * the intersection: objects (always closed with `additionalProperties: false`), arrays, strings, numbers, integers,
 * booleans and enums, each with an optional `description`. No `oneOf`/`anyOf`/`allOf`, `$ref`, `format`,
 * `pattern`, or a list of types. The same module validates a call's arguments against such a schema.
 */

import { Ajv, type ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (a: Ajv | Ajv2020) => void;

type Schema = Record<string, unknown>;

const SCALAR = new Set(["string", "number", "integer", "boolean"]);
const COMMON = ["type", "description"];
const KEYWORDS: Record<string, readonly string[]> = {
  object: [...COMMON, "properties", "required", "additionalProperties"],
  array: [...COMMON, "items", "minItems", "maxItems"],
  string: [...COMMON, "enum", "default"],
  number: [...COMMON, "enum", "default", "minimum", "maximum"],
  integer: [...COMMON, "enum", "default", "minimum", "maximum"],
  boolean: [...COMMON, "default"],
};

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const at = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** What is wrong with a schema, as readable lines (empty: it is in the subset). The root must be an object. */
export function checkSchema(schema: unknown): string[] {
  const problems: string[] = [];
  const walk = (s: unknown, path: string, root: boolean): void => {
    const where = path === "" ? "the schema" : path;
    if (!isObject(s)) {
      problems.push(`${where} is not an object`);
      return;
    }
    const type = s["type"];
    if (typeof type !== "string" || (type !== "object" && type !== "array" && !SCALAR.has(type))) {
      problems.push(`${where} needs a single \`type\` of object, array, string, number, integer or boolean`);
      return;
    }
    if (root && type !== "object") problems.push(`${where} must be an object`);
    const allowed = KEYWORDS[type] ?? [];
    for (const k of Object.keys(s)) if (!allowed.includes(k)) problems.push(`${where}: \`${k}\` is not in the portable subset for ${type}`);
    if (s["description"] !== undefined && typeof s["description"] !== "string") problems.push(`${where}: description must be text`);
    if (type === "object") {
      if (s["additionalProperties"] !== false) problems.push(`${where}: objects must set additionalProperties: false`);
      const props = s["properties"];
      if (props !== undefined && !isObject(props)) problems.push(`${where}: properties must be an object`);
      for (const [name, sub] of Object.entries(isObject(props) ? props : {})) walk(sub, at(path, name), false);
      const required = s["required"];
      if (required !== undefined) {
        if (!Array.isArray(required) || required.some((r) => typeof r !== "string")) problems.push(`${where}: required must be a list of names`);
        else for (const r of required as string[]) if (!isObject(props) || !(r in props)) problems.push(`${where}: required names ${r}, which is not a property`);
      }
    } else if (type === "array") {
      if (s["items"] === undefined) problems.push(`${where}: arrays need \`items\``);
      else walk(s["items"], `${path}[]`, false);
      for (const k of ["minItems", "maxItems"]) if (s[k] !== undefined && !(Number.isInteger(s[k]) && (s[k] as number) >= 0)) problems.push(`${where}: ${k} must be a whole number`);
    } else {
      const en = s["enum"];
      if (en !== undefined && (!Array.isArray(en) || en.length === 0)) problems.push(`${where}: enum must be a non-empty list`);
      for (const k of ["minimum", "maximum"]) if (s[k] !== undefined && typeof s[k] !== "number") problems.push(`${where}: ${k} must be a number`);
    }
  };
  walk(schema, "", true);
  return problems;
}

// ---- full JSON Schema: validation ---------------------------------------------------------------------------------

type Check = ((v: unknown) => boolean) & { errors?: ErrorObject[] | null };
const compiled = new WeakMap<object, Check | string>();
let draft07: Ajv | undefined;
let draft2020: Ajv2020 | undefined;

function engine(schema: Schema): Ajv | Ajv2020 {
  const uri = typeof schema["$schema"] === "string" ? schema["$schema"] : "";
  const options = { allErrors: true, verbose: true, strict: false, logger: false, validateSchema: false } as const;
  if (/2019-09|2020-12/.test(uri)) {
    if (draft2020 === undefined) addFormats(draft2020 = new Ajv2020(options));
    return draft2020;
  }
  if (draft07 === undefined) addFormats(draft07 = new Ajv(options));
  return draft07;
}

/** The validator for a schema (kept per schema object), or why it cannot be one: not JSON Schema, or a reference to something outside it. */
function checker(schema: Schema): Check | string {
  const known = compiled.get(schema);
  if (known !== undefined) return known;
  let made: Check | string;
  try {
    // `$schema` picks the engine and `$id` would make a second compile of the same schema a clash, so neither goes in.
    const { $schema: _s, $id: _i, ...rest } = schema;
    made = engine(schema).compile(rest) as Check;
  } catch (e) {
    made = `the schema cannot be used: ${e instanceof Error ? e.message : String(e)}`;
  }
  compiled.set(schema, made);
  return made;
}

/**
 * What is wrong with a tool's schema for this harness, as readable lines (empty: usable). Any JSON Schema is: it must be an object schema
 * and one the validator can compile (no reference to another document). What a given model can be shown of it is a separate question
 * (`projectSchema`).
 */
export function schemaProblems(schema: unknown): string[] {
  if (!isObject(schema)) return ["the schema is not an object"];
  const t = schema["type"];
  if (t !== "object" && !(t === undefined && isObject(schema["properties"]))) return ["the schema must describe an object (type: object)"];
  const c = checker(schema);
  return typeof c === "string" ? [c] : [];
}

const pointer = (instancePath: string): string =>
  instancePath
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((out, p) => (/^\d+$/.test(p) ? `${out}[${p}]` : out === "" ? p : `${out}.${p}`), "");

function sentence(e: ErrorObject): string {
  const path = pointer(e.instancePath);
  const where = path === "" ? "the arguments" : path;
  const p = e.params as Record<string, unknown>;
  const list = (xs: unknown): string => (Array.isArray(xs) ? xs.map((x) => JSON.stringify(x)).join(", ") : String(xs));
  switch (e.keyword) {
    case "required": {
      const props = isObject(e.parentSchema) && isObject(e.parentSchema["properties"]) ? Object.keys(e.parentSchema["properties"]) : [];
      const name = String(p["missingProperty"]);
      return `${at(path, name)} is required${props.length === 0 ? "" : ` (${path === "" ? "the arguments are" : `${path} takes`}: ${props.join(", ")})`}`;
    }
    case "additionalProperties": {
      const props = isObject(e.parentSchema) && isObject(e.parentSchema["properties"]) ? Object.keys(e.parentSchema["properties"]) : [];
      return `${at(path, String(p["additionalProperty"]))} is not a known argument${props.length === 0 ? "" : ` (known: ${props.join(", ")})`}`;
    }
    case "type": {
      const t = p["type"];
      const kinds = Array.isArray(t) ? t : [t];
      if (kinds.length > 1) return `${where} must be ${kinds.join(" or ")}`;
      if (kinds[0] === "integer" && typeof e.data !== "number") return `${where} must be a number`;
      return { object: `${where} must be an object`, array: `${where} must be a list`, string: `${where} must be text`, boolean: `${where} must be true or false`, number: `${where} must be a number`, integer: `${where} must be a whole number`, null: `${where} must be null` }[String(kinds[0])] ?? `${where} has the wrong type`;
    }
    case "enum":
      return `${where} must be one of ${list(p["allowedValues"])}`;
    case "const":
      return `${where} must be ${JSON.stringify(p["allowedValue"])}`;
    case "minimum":
      return `${where} must be at least ${String(p["limit"])}`;
    case "maximum":
      return `${where} must be at most ${String(p["limit"])}`;
    case "exclusiveMinimum":
      return `${where} must be more than ${String(p["limit"])}`;
    case "exclusiveMaximum":
      return `${where} must be less than ${String(p["limit"])}`;
    case "minItems":
      return `${where} needs at least ${String(p["limit"])} item${p["limit"] === 1 ? "" : "s"}`;
    case "maxItems":
      return `${where} takes at most ${String(p["limit"])} item${p["limit"] === 1 ? "" : "s"}`;
    case "minLength":
      return `${where} needs at least ${String(p["limit"])} character${p["limit"] === 1 ? "" : "s"}`;
    case "maxLength":
      return `${where} takes at most ${String(p["limit"])} character${p["limit"] === 1 ? "" : "s"}`;
    case "pattern":
      return `${where} must match the pattern ${String(p["pattern"])}`;
    case "format":
      return `${where} must be a valid ${String(p["format"])}`;
    case "uniqueItems":
      return `${where} must not repeat an item`;
    case "anyOf":
    case "oneOf":
      return `${where} does not match any of the shapes it may have`;
    default:
      return `${where} ${e.message ?? "is not valid"}`;
  }
}

/**
 * What is wrong with `value` as arguments for `schema` (any JSON Schema that `schemaProblems` accepts), as readable lines (empty: valid).
 * Checked by a real validator against the schema as written, so `pattern`, `format`, `anyOf` and the rest are enforced even where the
 * model was shown less (`projectSchema`).
 */
export function validateArgs(schema: unknown, value: unknown): string[] {
  if (!isObject(schema)) return ["the schema is not an object"];
  const c = checker(schema);
  if (typeof c === "string") return [c];
  if (c(value)) return [];
  const errors = c.errors ?? [];
  // A choice reports every branch's trouble too; the one line about the choice says it better.
  const choices = errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").map((e) => e.schemaPath);
  const lines = errors.filter((e) => !choices.some((sp) => e.schemaPath.startsWith(`${sp}/`))).map(sentence);
  return [...new Set(lines)];
}

/**
 * Why a schema is not flat (empty: it is). A flat schema is an object whose properties are strings, numbers, integers or
 * booleans, or lists of those: nothing nested, because some servers show a model only the top-level types (docs/tools.md, 3.7).
 */
export function flatProblems(schema: unknown): string[] {
  const out: string[] = [];
  const props = isObject(schema) && isObject(schema["properties"]) ? (schema["properties"] as Record<string, unknown>) : {};
  for (const [k, p] of Object.entries(props)) {
    if (!isObject(p)) continue;
    const type = p["type"];
    if (type === "object") out.push(`${k} is an object`);
    else if (type === "array") {
      const items = p["items"];
      if (!isObject(items) || !SCALAR.has(items["type"] as string)) out.push(`${k} is a list of ${isObject(items) && typeof items["type"] === "string" ? `${items["type"]}s` : "things that are not plain values"}`);
    }
  }
  return out;
}

const NUMBER_RE = /^\s*-?\d+(\.\d+)?\s*$/;

/**
 * Repair the slips small models make that have only one possible meaning, guided by the schema, before the arguments are
 * validated (docs/tools.md, 3.6): a lone item where a list belongs (`files: {path: "a"}`, `argv: "ls"`), a bare string
 * where an object with one required text property belongs (`files: ["a.txt"]`), a list or object sent as a JSON string,
 * numbers and booleans sent as text, text sent as a number or boolean, and an optional argument sent as null or "". Anything that could mean
 * more than one thing is left alone for `validateArgs` to report. Returns a new value; the input is not changed.
 */
export function coerceArgs(schema: unknown, value: unknown): unknown {
  return coerce(schema, value, isObject(schema) ? { ...(isObject(schema["definitions"]) ? schema["definitions"] : {}), ...(isObject(schema["$defs"]) ? schema["$defs"] : {}) } : {});
}

/**
 * The plain shape of a schema for repairing arguments: a local `$ref` followed, a type list with `null` as that one type, and a choice
 * between one shape and null as the shape. Whatever is left (a real choice) is not repaired, only validated.
 */
function view(raw: unknown, defs: Schema, depth = 0): Schema | undefined {
  if (!isObject(raw) || depth > 8) return undefined;
  let s: Schema = raw;
  const ref = s["$ref"];
  if (typeof ref === "string") {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    return m === null ? undefined : view(defs[m[1] as string], defs, depth + 1);
  }
  const choice = ["anyOf", "oneOf"].find((k) => Array.isArray(s[k]));
  if (choice !== undefined) {
    const live = (s[choice] as unknown[]).filter((b) => !(isObject(b) && b["type"] === "null"));
    if (live.length !== 1) return undefined;
    return view(live[0], defs, depth + 1);
  }
  if (Array.isArray(s["type"])) {
    const rest = s["type"].filter((t) => t !== "null");
    if (rest.length !== 1) return undefined;
    s = { ...s, type: rest[0] };
  }
  return s;
}

function coerce(raw: unknown, value: unknown, defs: Schema): unknown {
  const schema = view(raw, defs);
  if (schema === undefined) return value;
  const type = schema["type"];
  if (type === "object") {
    let v = value;
    const props = isObject(schema["properties"]) ? (schema["properties"] as Record<string, unknown>) : {};
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    if (typeof v === "string") {
      const parsed = parseAs(v, "object");
      // A bare string where an object with one required text property belongs (`files: ["a.txt"]` for `[{path: "a.txt"}]`).
      const only = required.length === 1 ? (required[0] as string) : undefined;
      if (parsed !== undefined) v = parsed;
      else if (only !== undefined && isObject(props[only]) && (props[only] as Schema)["type"] === "string") return { [only]: v };
    }
    if (!isObject(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // An optional argument sent as null or empty text means "not given".
      if (k in props && !required.includes(k) && (x === null || x === "")) continue;
      out[k] = k in props ? coerce(props[k], x, defs) : x;
    }
    return out;
  }
  if (type === "array") {
    let v = value;
    if (typeof v === "string") {
      const parsed = parseAs(v, "array");
      if (parsed !== undefined) v = parsed;
      else if (isObject(schema["items"]) && (schema["items"]["type"] === "string" || schema["items"]["type"] === "object")) {
        const one = coerce(schema["items"], v, defs);
        return schema["items"]["type"] === "string" || isObject(one) ? [one] : v;
      } else return v;
    } else if (!Array.isArray(v)) {
      const items = schema["items"];
      // A single object or scalar where a list of them belongs.
      if (isObject(items) && ((items["type"] === "object" && isObject(v)) || (SCALAR.has(items["type"] as string) && (typeof v === "number" || typeof v === "boolean")))) return [coerce(items, v, defs)];
      return v;
    }
    return (v as unknown[]).map((x) => coerce(schema["items"], x, defs));
  }
  if ((type === "integer" || type === "number") && typeof value === "string" && NUMBER_RE.test(value)) return Number(value);
  if (type === "boolean" && typeof value === "string" && /^\s*(true|false)\s*$/i.test(value)) return value.trim().toLowerCase() === "true";
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  return value;
}

function parseAs(text: string, kind: "object" | "array"): unknown {
  const t = text.trim();
  if (!(kind === "object" ? t.startsWith("{") : t.startsWith("["))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return kind === "array" ? (Array.isArray(v) ? v : undefined) : isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
