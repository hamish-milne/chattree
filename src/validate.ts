import { Type, type Static, type StaticDecode, type TObject, type TProperties, type TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Clone, Default, DecodeUnsafe } from "typebox/value";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Validation of data that arrives from outside (settings files, provider replies, stored records). The schemas are JSON Schema, built with
 * TypeBox, so they are also what a model is shown and what other tools can read; this file is the one place that runs them.
 *
 * A schema describes the value *after* defaults are filled in: a field with a `default` is required in the schema (and in the type that
 * comes out), and `parse` fills it first. Unknown fields are rejected only where the schema says `additionalProperties: false` (see
 * `strictObject`). A `Codec` in a schema is run after the value has checked (a string that stands for an object, a hash folded to lower
 * case); a `Refine` is a check JSON Schema cannot say (a rule between fields) and is not part of the exported schema.
 *
 * `errorMessage` on a node is the sentence to show when that node's own keyword fails (a pattern, a range): an annotation for people
 * that the validator itself ignores.
 */

export interface Issue {
  /** Keys and array indices from the root to the value. Empty for the root. */
  path: (string | number)[];
  message: string;
}

export class ValidationError extends Error {
  override name = "ValidationError";
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => (i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}`)).join("\n"));
    this.issues = issues;
  }
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Parser<S extends TSchema, T = StaticDecode<S>> extends StandardSchemaV1<unknown, T> {
  /** The JSON Schema this parses with. */
  readonly schema: S;
  /** The value with defaults filled in and codecs run; throws a `ValidationError` naming every problem. */
  parse(raw: unknown): T;
  safeParse(raw: unknown): ParseResult<T>;
}

/** An object that rejects fields it does not name. */
export function strictObject<P extends TProperties>(properties: P, options: Parameters<typeof Type.Object>[1] = {}): TObject<P> {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

/**
 * Rules between fields, which JSON Schema cannot say. Each check returns the sentence to report when it is broken, or undefined. They
 * are reported where the schema is, not at a field inside it, so a sentence should say which field it is about. They run on the value as
 * written (a `Codec` field is still in its written form) and are not part of the JSON Schema this exports.
 */
export function rules<S extends TSchema>(schema: S, checks: ((value: Static<S>) => string | undefined)[]): S {
  return checks.reduce<S>(
    (acc, check) =>
      Type.Refine(
        acc,
        (v) => check(v) === undefined,
        (v) => check(v) ?? "",
      ),
    schema,
  );
}

/** Attach the sentence that explains this node's constraint when it fails (a pattern or range that is not obvious from the keyword). */
export const said = <S extends TSchema>(message: string, schema: S): S => annotate(schema, { errorMessage: message });

/** A copy of the schema with more keywords. The copy keeps the hidden properties TypeBox puts on a type (`~kind`, `~optional`, `~refine`), which a spread would lose. */
function annotate<S extends TSchema>(schema: S, extra: Record<string, unknown>): S {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a copy of S with extra keywords is still an S
  return Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema)), extra) as S;
}

/**
 * A record (an object with any keys, all values the same shape). `Value.Default` only looks inside a record's values when their schema has a
 * `default`, so an object value is given an empty one: it is never used (a value that is there is not undefined), it only lets the defaults
 * of the fields inside be filled. The key schema is `propertyNames`, so a key that does not match is an error (JSON Schema's own way, which also avoids
 * `additionalProperties: false`, on which `Value.Default` fails for a record).
 */
export function record<V extends TSchema>(key: TSchema, value: V, options: Parameters<typeof Type.Record>[2] = {}) {
  const inner = isRecord(value) && value["type"] === "object" && !("default" in value) ? annotate(value, { default: {} }) : value;
  return Type.Record(Type.String(), inner, { propertyNames: key, ...options });
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const decodePointer = (p: string): string[] =>
  (p === "" ? [] : p.slice(1).split("/")).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

/** The node of the schema a `schemaPath` (`#/properties/a/anyOf/0`) names. */
function nodeAt(schema: unknown, schemaPath: string): Record<string, unknown> | undefined {
  let node: unknown = schema;
  for (const key of decodePointer(schemaPath.replace(/^#/, ""))) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return isRecord(node) ? node : undefined;
}

/** Path segments of an `instancePath`, with array positions as numbers (read off the value, since a pointer does not say). */
function pathOf(instancePath: string, root: unknown): (string | number)[] {
  const out: (string | number)[] = [];
  let at: unknown = root;
  for (const key of decodePointer(instancePath)) {
    out.push(Array.isArray(at) ? Number(key) : key);
    at = isRecord(at) ? at[key] : undefined;
  }
  return out;
}

const within = (e: TLocalizedValidationError, union: TLocalizedValidationError): boolean =>
  e !== union && e.schemaPath.startsWith(`${union.schemaPath}/`);

/** A choice between forms that failed reports every form's complaint; show the one that got furthest, or say what was wanted. */
function collapseUnions(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
  const drop = new Set<TLocalizedValidationError>();
  const reword = new Map<TLocalizedValidationError, string>();
  for (const union of errors) {
    if (union.keyword !== "anyOf" && union.keyword !== "oneOf") continue;
    const inner = errors.filter((e) => within(e, union));
    const deeper = inner.filter((e) => e.instancePath !== union.instancePath);
    if (deeper.length > 0) {
      drop.add(union);
      for (const e of inner) if (e.instancePath === union.instancePath) drop.add(e);
    } else {
      for (const e of inner) drop.add(e);
      reword.set(union, `must be ${[...new Set(inner.map((e) => e.message.replace(/^must be /, "")))].join(" or ")}`);
    }
  }
  return errors
    .filter((e) => !drop.has(e))
    .map((e) => {
      const message = reword.get(e);
      return message === undefined ? e : { ...e, message };
    });
}

/** The validator's errors as issues a person can act on: a path and a sentence each, one per missing or unknown key. */
function issuesOf(errors: TLocalizedValidationError[], schema: unknown, value: unknown): Issue[] {
  const out: Issue[] = [];
  for (const e of collapseUnions(errors.filter((x) => x.keyword !== "boolean" && x.keyword !== "propertyNames"))) {
    const path = pathOf(e.instancePath, value);
    const params: Record<string, unknown> = isRecord(e.params) ? e.params : {};
    if (e.keyword === "required" && Array.isArray(params["requiredProperties"])) {
      for (const k of params["requiredProperties"]) out.push({ path: [...path, String(k)], message: "is required" });
    } else if (e.keyword === "additionalProperties" && Array.isArray(params["additionalProperties"])) {
      for (const k of params["additionalProperties"])
        out.push({ path: [...path, String(k)], message: "unknown field (not in the schema)" });
    } else {
      const custom = e.keyword.startsWith("~") ? undefined : nodeAt(schema, e.schemaPath)?.["errorMessage"];
      const named = e.schemaPath.endsWith("/propertyNames");
      out.push({ path, message: typeof custom === "string" ? (named ? `the name must be ${custom}` : custom) : e.message });
    }
  }
  return out;
}

const compiled = new WeakMap<TSchema, Validator>();
const validatorFor = (schema: TSchema): Validator => {
  let v = compiled.get(schema);
  if (v === undefined) compiled.set(schema, (v = Compile(schema)));
  return v;
};

export function safeParse<S extends TSchema>(schema: S, raw: unknown): ParseResult<StaticDecode<S>> {
  const filled = Default({}, schema, Clone(raw));
  const validator = validatorFor(schema);
  if (!validator.Check(filled)) {
    const issues = issuesOf(validator.Errors(filled), schema, filled);
    return { ok: false, issues: issues.length > 0 ? issues : [{ path: [], message: "does not match the schema" }] };
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the value checked against the schema, so it has the type the schema describes
  return { ok: true, value: DecodeUnsafe({}, schema, filled) as StaticDecode<S> };
}

export function parser<S extends TSchema>(schema: S): Parser<S> {
  return {
    schema,
    safeParse: (raw) => safeParse(schema, raw),
    parse(raw) {
      const r = safeParse(schema, raw);
      if (!r.ok) throw new ValidationError(r.issues);
      return r.value;
    },
    "~standard": {
      version: 1,
      vendor: "chattree",
      validate(raw) {
        const r = safeParse(schema, raw);
        return r.ok ? { value: r.value } : { issues: r.issues };
      },
    },
  };
}

/** Whether this schema's checks run as generated code (false where the environment does not allow it, or `useAcceleration` is off). */
export const accelerated = (schema: TSchema): boolean => validatorFor(schema).IsAccelerated();
