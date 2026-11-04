import type { Conversation } from "./conversation.ts";
import type { ToolDefinition } from "./definitions.ts";
import { servedModelId, type ModelSetup } from "./setup.ts";
import { checkSchema, schemaProblems } from "./tool-schema.ts";

/**
 * What a model is shown of a tool's schema. A tool definition keeps its schema as written (any JSON Schema); what goes into a request depends on
 * what the model's endpoint takes (`ModelInfo.tool_schema`): `full` passes it on, `portable` narrows it to the subset every provider and local
 * grammar compiler takes (docs/tools.md, 3.6). Narrowing moves the constraints the subset cannot say (`pattern`, `format`, lengths) into the
 * description, where the model still reads them, and the validator enforces the real thing when the call arrives. What cannot be narrowed (a
 * free-form object, a choice between different types) is left out when the argument is optional; when it is required the tool cannot be shown.
 */

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

const SCALARS = new Set(["string", "number", "integer", "boolean"]);
/** Keywords kept per type, as in the portable subset (`harness/tool-schema.ts`). */
const KEEP: Record<string, readonly string[]> = {
  object: ["description"],
  array: ["description", "minItems", "maxItems"],
  string: ["description", "enum", "default"],
  number: ["description", "enum", "default", "minimum", "maximum"],
  integer: ["description", "enum", "default", "minimum", "maximum"],
  boolean: ["description", "default"],
};
/** Keywords whose meaning is lost but worth telling the model. */
const HINTS = ["format", "pattern", "minLength", "maxLength", "multipleOf", "exclusiveMinimum", "exclusiveMaximum", "uniqueItems"];
const MAX_DEPTH = 8;

export type Converted = { ok: true; schema: Schema; notes: string[] } | { ok: false; problems: string[] };

class Unsupported extends Error {}

export function toPortableSchema(input: unknown): Converted {
  const notes: string[] = [];
  try {
    const root = isObject(input) ? input : { type: "object" };
    const defs = { ...(isObject(root["$defs"]) ? root["$defs"] : {}), ...(isObject(root["definitions"]) ? root["definitions"] : {}) };
    const resolve = (s: Schema, depth: number): Schema => {
      const ref = s["$ref"];
      if (typeof ref !== "string") return s;
      const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
      const target = m === null ? undefined : defs[m[1] as string];
      if (!isObject(target) || depth > MAX_DEPTH) throw new Unsupported(`it refers to ${ref}, which cannot be followed`);
      return { ...resolve(target, depth + 1), ...(typeof s["description"] === "string" ? { description: s["description"] } : {}) };
    };
    const typeOf = (s: Schema, path: string): string => {
      let t = s["type"];
      if (Array.isArray(t)) {
        const rest = t.filter((x) => x !== "null");
        if (rest.length !== 1) throw new Unsupported(`${path} allows several types`);
        t = rest[0];
      }
      if (t === undefined && isObject(s["properties"])) t = "object";
      if (t === undefined && s["const"] !== undefined) t = typeof s["const"] === "number" ? "number" : typeof s["const"] === "boolean" ? "boolean" : "string";
      if (typeof t !== "string" || (t !== "object" && t !== "array" && !SCALARS.has(t))) throw new Unsupported(`${path} has no single usable type`);
      return t;
    };
    const walk = (raw: unknown, path: string, depth: number, isRoot: boolean): Schema => {
      if (!isObject(raw) || depth > MAX_DEPTH) throw new Unsupported(`${path} is too deeply nested or not a schema`);
      let s = resolve(raw, 0);
      const choice = ["anyOf", "oneOf"].find((k) => Array.isArray(s[k]));
      if (choice !== undefined) {
        // A choice that is really one type with null allowed is that type; anything else cannot be said in the subset.
        const live = (s[choice] as unknown[]).filter((b) => !(isObject(b) && b["type"] === "null"));
        if (live.length !== 1) throw new Unsupported(`${path} is a choice between different shapes`);
        s = { ...(live[0] as Schema), ...(typeof s["description"] === "string" ? { description: s["description"] } : {}) };
        s = resolve(s, 0);
      }
      if (Array.isArray(s["allOf"])) throw new Unsupported(`${path} combines schemas with allOf`);
      const type = typeOf(s, path);
      const out: Schema = { type };
      for (const k of KEEP[type] ?? []) if (s[k] !== undefined) out[k] = s[k];
      if (s["const"] !== undefined && type !== "object" && type !== "array") out["enum"] = [s["const"]];
      const hints = HINTS.filter((k) => s[k] !== undefined).map((k) => `${k}: ${JSON.stringify(s[k])}`);
      if (hints.length > 0) {
        out["description"] = `${typeof out["description"] === "string" ? `${out["description"]} ` : ""}(${hints.join(", ")})`;
        notes.push(`${path === "" ? "the arguments" : path}: ${hints.join(", ")} moved into the description`);
      }
      if (type === "object") {
        const props = isObject(s["properties"]) ? s["properties"] : {};
        if (!isRoot && Object.keys(props).length === 0) throw new Unsupported(`${path} is a free-form object`);
        const required = new Set(Array.isArray(s["required"]) ? (s["required"] as unknown[]).filter((r): r is string => typeof r === "string") : []);
        const kept: Record<string, Schema> = {};
        const keptRequired: string[] = [];
        for (const [name, sub] of Object.entries(props)) {
          const at = path === "" ? name : `${path}.${name}`;
          try {
            kept[name] = walk(sub, at, depth + 1, false);
            if (required.has(name)) keptRequired.push(name);
          } catch (e) {
            if (!(e instanceof Unsupported)) throw e;
            if (required.has(name)) throw e;
            notes.push(`${at} left out: ${e.message}`);
          }
        }
        out["properties"] = kept;
        if (keptRequired.length > 0) out["required"] = keptRequired;
        out["additionalProperties"] = false;
      } else if (type === "array") {
        const items = s["items"];
        if (!isObject(items)) throw new Unsupported(`${path} is an array without a single item schema`);
        out["items"] = walk(items, `${path}[]`, depth + 1, false);
      } else if (Array.isArray(out["enum"]) && out["enum"].length === 0) delete out["enum"];
      return out;
    };
    const schema = walk(root, "", 0, true);
    const problems = checkSchema(schema);
    return problems.length > 0 ? { ok: false, problems } : { ok: true, schema, notes };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, problems: [e.message] };
    throw e;
  }
}

export type SchemaLevel = "full" | "portable";

/** The schema as the model's endpoint should be given it, or why this endpoint cannot be given the tool. */
export function projectSchema(input: unknown, level: SchemaLevel): Converted {
  if (level === "portable") return toPortableSchema(input);
  const problems = schemaProblems(input);
  if (problems.length > 0) return { ok: false, problems };
  // `$schema` and `$id` name the document, not the arguments; some endpoints refuse them.
  const { $schema: _s, $id: _i, ...rest } = input as Schema;
  return { ok: true, schema: rest, notes: [] };
}

/** What the agent's model takes of a tool's schema: the model's own info, else what its adapter says, else the portable subset. */
export function toolSchemaLevel(convo: Pick<Conversation, "modelInfo" | "providers">, model: ModelSetup | undefined): SchemaLevel {
  if (model === undefined) return "portable";
  return convo.modelInfo(model.provider, servedModelId(model))?.tool_schema ?? convo.providers.get(model.provider)?.toolSchema ?? "portable";
}

/** The definitions as a request carries them for a model that takes `level`, and the tools that cannot be shown to it (with why). */
export function projectDefinitions(defs: readonly ToolDefinition[], level: SchemaLevel): { tools: ToolDefinition[]; refused: { name: string; why: string[] }[] } {
  const tools: ToolDefinition[] = [];
  const refused: { name: string; why: string[] }[] = [];
  for (const d of defs) {
    const p = projectSchema(d.input_schema, level);
    if (p.ok) tools.push(p.schema === d.input_schema ? d : { ...d, input_schema: p.schema });
    else refused.push({ name: d.name, why: p.problems });
  }
  return { tools, refused };
}
