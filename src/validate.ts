import {
  IsArray,
  IsObject,
  IsUnion,
  Type,
  type Static,
  type StaticDecode,
  type TObject,
  type TProperties,
  type TSchema,
  type TUnsafe,
} from "typebox";
import { Compile, type Validator } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Guard } from "typebox/guard";
import { Pointer } from "typebox/schema";
import { Settings } from "typebox/system";
import { Clone, Default, DecodeUnsafe } from "typebox/value";

/**
 * Validation of data that arrives from outside (settings files, provider replies, stored records). The schemas are JSON Schema, built with
 * TypeBox, so they are also what a model is shown, what an editor reads and what other tools take; this file is the one place that runs
 * them.
 *
 * A field with a default is not required by the schema (`withDefault`), so the schema says what a person may write. The type that comes out
 * has it present: defaults are filled in before the check, so a rule between fields sees them too. Unknown fields are rejected only where
 * the schema says `additionalProperties: false` (see `strictObject`). A `Codec` in a schema is run after the value has checked (a string that
 * stands for an object, a hash folded to lower case); a rule is a check JSON Schema cannot say (see `rules`) and is not in the schema's JSON.
 *
 * `errorMessage` on a node is the sentence to show when that node's own keyword fails (a pattern, a range): an annotation for people
 * that the validator itself ignores.
 */

// The default of 8 errors can stop short of the error that names a failed choice, which is what lets the complaints of the other forms be set aside.
Settings.Set({ maxErrors: 64 });

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

/** A schema with the parse functions bound to it. */
export interface Parser<S extends TSchema, T = StaticDecode<S>> {
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

/** A copy of the schema with more keywords. The copy keeps the hidden properties TypeBox puts on a type (`~kind`, `~optional`, `~refine`), which a spread would lose. */
function annotate<S extends TSchema>(schema: S, extra: Record<string, unknown>, hidden: Record<string, unknown> = {}): S {
  const copy = Object.assign(Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema)), extra);
  for (const [key, value] of Object.entries(hidden))
    Object.defineProperty(copy, key, { value, enumerable: false, writable: true, configurable: true });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a copy of S with extra keywords is still an S
  return copy as S;
}

/**
 * A field that may be left out and then has this value. The schema marks it optional with the `default` keyword (so an editor does not demand
 * it); the type has it present, since `parse` fills it in. `value` is what is filled in: for an object, `{}` is enough when its own fields
 * have defaults. `T` is for a type TypeBox cannot infer from the schema.
 */
export function withDefault<S extends TSchema, T = StaticDecode<S>>(schema: S, value: unknown): TUnsafe<T> {
  return Type.Unsafe<T>(annotate(Type.Optional(schema), { default: value }));
}

/** An object whose fields all have defaults, so it may be left out whole. */
export const section = <P extends TProperties>(properties: P) => withDefault(strictObject(properties), {});

/**
 * Rules between fields, which JSON Schema cannot say. Each check returns the sentence to report when it is broken, or undefined. They
 * are reported where the schema is, not at a field inside it, so a sentence should say which field it is about. They run on the value as
 * written, defaults filled in (a `Codec` field is still in its written form), and are not part of the JSON Schema this exports.
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

/** A string that must match a pattern, with the sentence to show when it does not. */
export const pattern = (re: RegExp, message: string) => said(message, Type.String({ pattern: re.source }));

/**
 * A record (an object with any keys, all values the same shape). `Value.Default` only looks inside a record's values when their schema has a
 * `default`, so an object value is given an empty one (not written to the schema's JSON): it is never used (a value that is there is not
 * undefined), it only lets the defaults of the fields inside be filled. The key schema is `propertyNames`, so a key that does not match is an
 * error (JSON Schema's own way, which also avoids `additionalProperties: false`, on which `Value.Default` fails for a record).
 */
export function record<V extends TSchema>(key: TSchema, value: V, options: Parameters<typeof Type.Record>[2] = {}) {
  const inner = IsObject(value) && !("default" in value) ? annotate(value, {}, { default: {} }) : value;
  return Type.Record(Type.String(), inner, { propertyNames: key, ...options });
}

/** The node of the schema a `schemaPath` (`#/properties/a/anyOf/0`) names. */
function nodeAt(schema: TSchema, schemaPath: string): Record<string, unknown> | undefined {
  const node = Pointer.Get(schema, schemaPath.replace(/^#/, ""));
  return Guard.IsObject(node) ? node : undefined;
}

/** Path segments of an `instancePath`, with array positions as numbers (read off the value, since a pointer does not say). */
function pathOf(instancePath: string, root: unknown): (string | number)[] {
  const out: (string | number)[] = [];
  let at: unknown = root;
  for (const key of Pointer.Fragments(instancePath)) {
    out.push(Array.isArray(at) ? Number(key) : key);
    at = Guard.IsObject(at) ? at[key] : undefined;
  }
  return out;
}

/** Keywords that judge a value as a whole (its kind, or which scalar it is) rather than something inside an object. */
const WHOLE_VALUE = new Set([
  "type",
  "enum",
  "const",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

const within = (e: TLocalizedValidationError, union: TLocalizedValidationError): boolean =>
  e !== union && e.schemaPath.startsWith(`${union.schemaPath}/`);

/**
 * A choice between forms that failed reports every form's complaint. A form the value was the right kind for (none of its complaints is about the value as a whole) is the one meant, so show that form's complaints, the form with the fewest if several fit (for a tagged choice, the
 * form of its tag); if none fits, say what was wanted.
 */
function collapseUnions(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
  const drop = new Set<TLocalizedValidationError>();
  const reword = new Map<TLocalizedValidationError, string>();
  for (const union of errors) {
    if (union.keyword !== "anyOf" && union.keyword !== "oneOf") continue;
    const inner = errors.filter((e) => within(e, union));
    const branches = new Map<string, TLocalizedValidationError[]>();
    for (const e of inner) {
      const branch = e.schemaPath
        .slice(union.schemaPath.length + 1)
        .split("/")
        .slice(0, 2)
        .join("/");
      branches.set(branch, [...(branches.get(branch) ?? []), e]);
    }
    const fits = [...branches.values()].filter(
      (es) => !es.some((e) => WHOLE_VALUE.has(e.keyword) && e.instancePath === union.instancePath),
    );
    drop.add(union);
    for (const e of inner) drop.add(e);
    const best = fits.sort((x, y) => x.length - y.length)[0];
    if (best !== undefined) {
      for (const e of best) drop.delete(e);
    } else {
      drop.delete(union);
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
function issuesOf(errors: TLocalizedValidationError[], schema: TSchema, value: unknown): Issue[] {
  const out: Issue[] = [];
  for (const e of collapseUnions(errors.filter((x) => x.keyword !== "boolean" && x.keyword !== "propertyNames"))) {
    const path = pathOf(e.instancePath, value);
    const params: Record<string, unknown> = Guard.IsObject(e.params) ? e.params : {};
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
  };
}

/** Whether this schema's checks run as generated code (false where the environment does not allow it, or `useAcceleration` is off). */
export const accelerated = (schema: TSchema): boolean => validatorFor(schema).IsAccelerated();

/**
 * The value with the keys of every object in the order the schema lists them (keys the schema does not name follow). Written entries then read
 * the same whatever order the code that built them used. For a choice, the first form the value checks against gives the order.
 */
export function orderBySchema(schema: TSchema, value: unknown): unknown {
  if (IsUnion(schema)) {
    const form = schema.anyOf.find((s) => validatorFor(s).Check(value));
    return form === undefined ? value : orderBySchema(form, value);
  }
  if (IsArray(schema) && Array.isArray(value)) return value.map((v) => orderBySchema(schema.items, v));
  if (IsObject(schema) && Guard.IsObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(schema.properties))
      if (Object.hasOwn(value, key)) out[key] = orderBySchema(schema.properties[key] ?? {}, value[key]);
    for (const key of Object.keys(value)) if (!Object.hasOwn(out, key)) out[key] = value[key];
    return out;
  }
  return value;
}
