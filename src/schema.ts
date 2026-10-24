import { EmitError, SchemaError, type Issue } from "./errors.ts";
import type { StandardIssue, StandardSchemaV1 } from "./standard-schema.ts";
import type { Transform } from "./transforms.ts";
import { BlobData, BlobRef, MAX_DEPTH, Tagged, type Entry, type Value } from "./value.ts";

/** Key that carries a tag in the plain-object form: `{ $tag: "user", id: ... }`. */
export const TAG_KEY = "$tag";
/** Key that carries the content of a tagged list or string: `{ $tag: "md", $value: "..." }`. */
export const VALUE_KEY = "$value";

const issue = (path: string, message: string): Issue => ({ path, message });
const joinPath = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * Value model to plain objects, for validators. A tagged map becomes `{ $tag, ...fields }`, a tagged list
 * or string becomes `{ $tag, $value }`, and a blob reference becomes `{ $tag: "blob", sha256, bytes, mime? }`.
 * Discriminated unions on `$tag` then work like any other discriminator.
 */
export function valueToObject(v: Value, path = "", depth = 0): unknown {
  if (depth > MAX_DEPTH + 2) throw new SchemaError([issue(path, "nesting too deep")]);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof BlobRef) {
    const o: Record<string, unknown> = { [TAG_KEY]: "blob", sha256: v.sha256, bytes: v.bytes };
    if (v.mime !== undefined) o["mime"] = v.mime;
    return o;
  }
  if (v instanceof BlobData) throw new SchemaError([issue(path, "unstored binary data")]);
  if (Array.isArray(v)) return v.map((x, i) => valueToObject(x, joinPath(path, i), depth + 1));
  if (v instanceof Tagged) {
    const o: Record<string, unknown> = {};
    setOwn(o, TAG_KEY, v.tag);
    if (v.value instanceof Map) {
      for (const [k, x] of mapFields(v.value, path)) setOwn(o, k, valueToObject(x, joinPath(path, k), depth + 1));
    } else {
      setOwn(o, VALUE_KEY, valueToObject(v.value, path, depth + 1));
    }
    return o;
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of mapFields(v, path)) setOwn(o, k, valueToObject(x, joinPath(path, k), depth + 1));
  return o;
}

function mapFields(m: Map<string, Value>, path: string): Map<string, Value> {
  if (m.has(TAG_KEY) || m.has(VALUE_KEY)) {
    throw new SchemaError([issue(path, `maps may not use the reserved keys ${TAG_KEY} and ${VALUE_KEY}`)]);
  }
  return m;
}

/** Plain objects to the value model; the inverse of valueToObject. `undefined` fields are skipped. */
export function objectToValue(x: unknown, path = "", depth = 0): Value {
  if (depth > MAX_DEPTH + 2) throw new SchemaError([issue(path, "nesting too deep")]);
  if (x === null || typeof x === "boolean" || typeof x === "number" || typeof x === "string") return x;
  if (x instanceof Uint8Array) return new BlobData(x);
  if (x instanceof BlobRef || x instanceof BlobData || x instanceof Tagged) return x;
  if (Array.isArray(x)) return x.map((e, i) => {
    if (e === undefined) throw new SchemaError([issue(joinPath(path, i), "undefined is not representable")]);
    return objectToValue(e, joinPath(path, i), depth + 1);
  });
  if (!isPlainObject(x)) throw new SchemaError([issue(path, `cannot represent ${typeof x} value`)]);

  const fields = new Map<string, Value>();
  const tag = Object.hasOwn(x, TAG_KEY) ? x[TAG_KEY] : undefined;
  const hasTag = Object.hasOwn(x, TAG_KEY);
  for (const k of Object.keys(x)) {
    if (k === TAG_KEY) continue;
    const e = x[k];
    if (e === undefined) continue;
    if (k !== VALUE_KEY || !hasTag) fields.set(k, objectToValue(e, joinPath(path, k), depth + 1));
  }
  if (!hasTag) {
    if (Object.hasOwn(x, VALUE_KEY)) throw new SchemaError([issue(path, `${VALUE_KEY} is only valid together with ${TAG_KEY}`)]);
    return fields;
  }
  if (typeof tag !== "string") throw new SchemaError([issue(joinPath(path, TAG_KEY), "tag must be a string")]);
  try {
    if (tag === "blob") {
      const { sha256, bytes, mime } = x as { sha256?: unknown; bytes?: unknown; mime?: unknown };
      if (typeof sha256 !== "string" || typeof bytes !== "number" || (mime !== undefined && typeof mime !== "string")) {
        throw new SchemaError([issue(path, "a blob reference needs sha256 (string), bytes (number) and optionally mime (string)")]);
      }
      return new BlobRef(sha256, bytes, mime);
    }
    if (Object.hasOwn(x, VALUE_KEY)) {
      if (fields.size > 0 || x[VALUE_KEY] === undefined) throw new SchemaError([issue(path, `${VALUE_KEY} cannot be combined with other fields`)]);
      return new Tagged(tag, objectToValue(x[VALUE_KEY], joinPath(path, VALUE_KEY), depth + 1));
    }
    return new Tagged(tag, fields);
  } catch (e) {
    if (e instanceof EmitError) throw new SchemaError([issue(path, e.message)]);
    throw e;
  }
}

/**
 * Paths of fields present in `input` that are missing from `output`: what a validator that strips
 * unknown keys would silently discard. Used to make writes strict.
 */
export function findDropped(input: unknown, output: unknown, path = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(input) && Array.isArray(output)) {
    const n = Math.min(input.length, output.length);
    for (let i = 0; i < n; i++) out.push(...findDropped(input[i], output[i], joinPath(path, i)));
  } else if (isPlainObject(input) && isPlainObject(output)) {
    for (const key of Object.keys(input)) {
      const value = input[key];
      if (value === undefined) continue;
      if (!Object.hasOwn(output, key)) out.push(joinPath(path, key));
      else out.push(...findDropped(value, output[key], joinPath(path, key)));
    }
  }
  return out;
}

function formatIssuePath(path: StandardIssue["path"]): string {
  let out = "";
  for (const seg of path ?? []) {
    const key = typeof seg === "object" ? seg.key : seg;
    out = typeof key === "number" ? `${out}[${key}]` : joinPath(out, String(key));
  }
  return out;
}

async function runSchema<T>(schema: StandardSchemaV1<unknown, T>, input: unknown): Promise<{ value: T } | { issues: Issue[] }> {
  const r = await schema["~standard"].validate(input);
  if (r.issues !== undefined) return { issues: r.issues.map((i) => issue(formatIssuePath(i.path), i.message)) };
  return { value: r.value };
}

/** An entry type: the tag it is written under and the schema that validates it (in plain-object form). */
export interface EntryType<T = unknown> {
  readonly tag: string;
  readonly schema: StandardSchemaV1<unknown, T>;
}

export function defineEntry<T>(tag: string, schema: StandardSchemaV1<unknown, T>): EntryType<T> {
  return { tag, schema };
}

export interface PipelineOptions<T> {
  types: readonly EntryType<T>[];
  /** Pre-serialization steps, run in order after validation. */
  transforms?: readonly Transform[];
  /** Decode the transformed value and require it to validate, so nothing undecodable is ever written. Default true. */
  verify?: boolean;
  /** Reject input fields the schema would silently drop. Default true. */
  strict?: boolean;
}

export type DecodeResult<T> =
  | { ok: true; tag: string; value: T }
  | { ok: false; reason: "untagged" | "unknown-tag" | "invalid"; tag: string | undefined; issues: Issue[]; raw: Entry };

/**
 * Entries in and out. Writing: validate (strictly), convert to the value model, run the transforms, check the
 * result still decodes. Reading: look the tag up, validate leniently (unknown fields are ignored so a newer
 * minor version stays readable), and never throw: an entry that cannot be decoded is returned with its issues
 * and its raw value, which can be written back unchanged.
 */
export class Pipeline<T = unknown> {
  readonly #types = new Map<string, EntryType<T>>();
  readonly #transforms: readonly Transform[];
  readonly #verify: boolean;
  readonly #strict: boolean;

  constructor(opts: PipelineOptions<T>) {
    for (const t of opts.types) {
      if (this.#types.has(t.tag)) throw new Error(`duplicate entry type ${t.tag}`);
      this.#types.set(t.tag, t);
    }
    this.#transforms = opts.transforms ?? [];
    this.#verify = opts.verify !== false;
    this.#strict = opts.strict !== false;
  }

  get tags(): string[] {
    return [...this.#types.keys()];
  }

  /** Validate and transform `input` (an object with a `$tag`) into an entry ready for emitEntry. Throws SchemaError. */
  async encode(input: unknown): Promise<Entry> {
    const tag = isPlainObject(input) ? input[TAG_KEY] : undefined;
    if (typeof tag !== "string") throw new SchemaError([issue(TAG_KEY, "an entry needs a string $tag")]);
    const type = this.#types.get(tag);
    if (type === undefined) throw new SchemaError([issue(TAG_KEY, `unknown entry type ${JSON.stringify(tag)}`)]);

    const r = await runSchema(type.schema, input);
    if ("issues" in r) throw new SchemaError(r.issues, `invalid ${tag} entry`);
    if (!isPlainObject(r.value) || r.value[TAG_KEY] !== tag) {
      throw new SchemaError([issue(TAG_KEY, `the schema for ${tag} must keep the $tag field`)]);
    }
    if (this.#strict) {
      const dropped = findDropped(input, r.value);
      if (dropped.length > 0) throw new SchemaError(dropped.map((p) => issue(p, "unknown field (not in the schema)")), `invalid ${tag} entry`);
    }

    let v = objectToValue(r.value);
    for (const t of this.#transforms) v = await t(v);
    if (!(v instanceof Tagged) || !(v.value instanceof Map)) throw new SchemaError([issue("", "a transform changed the entry into something other than a tagged map")]);
    if (this.#verify) {
      const back = await this.decode(v as Entry);
      if (!back.ok) throw new SchemaError(back.issues, `${tag} entry no longer valid after transforms`);
    }
    return v as Entry;
  }

  /** Validate an entry read from a file. Never throws. */
  async decode(entry: Entry): Promise<DecodeResult<T>> {
    const fail = (reason: "untagged" | "unknown-tag" | "invalid", tag: string | undefined, issues: Issue[]): DecodeResult<T> => ({ ok: false, reason, tag, issues, raw: entry });
    if (entry instanceof Map) return fail("untagged", undefined, [issue("", "entry has no tag")]);
    const type = this.#types.get(entry.tag);
    if (type === undefined) return fail("unknown-tag", entry.tag, [issue("", `unknown entry type ${JSON.stringify(entry.tag)}`)]);
    let plain: unknown;
    try {
      plain = valueToObject(entry);
    } catch (e) {
      if (e instanceof SchemaError) return fail("invalid", entry.tag, e.issues);
      throw e;
    }
    const r = await runSchema(type.schema, plain);
    if ("issues" in r) return fail("invalid", entry.tag, r.issues);
    return { ok: true, tag: entry.tag, value: r.value };
  }
}
