/**
 * The portable subset of JSON Schema that tool definitions may use (docs/tools.md, 3.6).
 *
 * Providers differ on what they accept, and local servers compile schemas to grammars, so the canonical format is
 * the intersection: objects (always closed with `additionalProperties: false`), arrays, strings, numbers, integers,
 * booleans and enums, each with an optional `description`. No `oneOf`/`anyOf`/`allOf`, `$ref`, `format`,
 * `pattern`, or a list of types. The same module validates a call's arguments against such a schema.
 */

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

/** What is wrong with `value` as arguments for `schema`, as readable lines (empty: valid). Assumes `schema` passed `checkSchema`. */
export function validateArgs(schema: unknown, value: unknown): string[] {
  const problems: string[] = [];
  const walk = (s: Schema, v: unknown, path: string): void => {
    const where = path === "" ? "the arguments" : path;
    const type = s["type"] as string;
    const en = s["enum"];
    if (type === "object") {
      if (!isObject(v)) return void problems.push(`${where} must be an object`);
      const props = (isObject(s["properties"]) ? s["properties"] : {}) as Record<string, Schema>;
      for (const r of (s["required"] as string[] | undefined) ?? []) if (!(r in v)) problems.push(`${at(path, r)} is required`);
      for (const [k, sub] of Object.entries(v)) {
        const def = props[k];
        if (def === undefined) problems.push(`${at(path, k)} is not a known argument${Object.keys(props).length === 0 ? "" : ` (known: ${Object.keys(props).join(", ")})`}`);
        else walk(def, sub, at(path, k));
      }
    } else if (type === "array") {
      if (!Array.isArray(v)) return void problems.push(`${where} must be a list`);
      const min = s["minItems"] as number | undefined;
      const max = s["maxItems"] as number | undefined;
      if (min !== undefined && v.length < min) problems.push(`${where} needs at least ${min} item${min === 1 ? "" : "s"}`);
      if (max !== undefined && v.length > max) problems.push(`${where} takes at most ${max} item${max === 1 ? "" : "s"}`);
      v.forEach((item, i) => walk(s["items"] as Schema, item, `${path}[${i}]`));
    } else if (type === "string") {
      if (typeof v !== "string") return void problems.push(`${where} must be text`);
    } else if (type === "boolean") {
      if (typeof v !== "boolean") return void problems.push(`${where} must be true or false`);
    } else {
      if (typeof v !== "number" || !Number.isFinite(v)) return void problems.push(`${where} must be a number`);
      if (type === "integer" && !Number.isInteger(v)) return void problems.push(`${where} must be a whole number`);
      const lo = s["minimum"] as number | undefined;
      const hi = s["maximum"] as number | undefined;
      if (lo !== undefined && v < lo) problems.push(`${where} must be at least ${lo}`);
      if (hi !== undefined && v > hi) problems.push(`${where} must be at most ${hi}`);
    }
    if (Array.isArray(en) && !en.includes(v)) problems.push(`${where} must be one of ${en.map((x) => JSON.stringify(x)).join(", ")}`);
  };
  if (!isObject(schema)) return ["the schema is not an object"];
  walk(schema, value, "");
  return problems;
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
  if (!isObject(schema)) return value;
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
      out[k] = k in props ? coerceArgs(props[k], x) : x;
    }
    return out;
  }
  if (type === "array") {
    let v = value;
    if (typeof v === "string") {
      const parsed = parseAs(v, "array");
      if (parsed !== undefined) v = parsed;
      else if (isObject(schema["items"]) && (schema["items"]["type"] === "string" || schema["items"]["type"] === "object")) {
        const one = coerceArgs(schema["items"], v);
        return schema["items"]["type"] === "string" || isObject(one) ? [one] : v;
      } else return v;
    } else if (!Array.isArray(v)) {
      const items = schema["items"];
      // A single object or scalar where a list of them belongs.
      if (isObject(items) && ((items["type"] === "object" && isObject(v)) || (SCALAR.has(items["type"] as string) && (typeof v === "number" || typeof v === "boolean")))) return [coerceArgs(items, v)];
      return v;
    }
    return (v as unknown[]).map((x) => coerceArgs(schema["items"], x));
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
