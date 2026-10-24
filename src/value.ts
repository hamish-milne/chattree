import { EmitError } from "./errors.ts";

/** Maximum container nesting accepted by both emitter and parser. An entry's own map is depth 1. */
export const MAX_DEPTH = 64;

const HEX64 = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** A tag name as written after "!". Letters, digits and "_ . - /", starting with a letter. */
export const TAG_NAME = /^[A-Za-z][A-Za-z0-9_./-]*$/;
const MAX_TAG_LENGTH = 128;

/**
 * Reference to content stored outside the transcript, addressed by SHA-256.
 * `mime: "text/plain"` means the blob is UTF-8 text and resolves back to a string.
 */
export class BlobRef {
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string | undefined;

  constructor(sha256: string, bytes: number, mime?: string) {
    if (!HEX64.test(sha256)) throw new EmitError("BlobRef.sha256 must be 64 lowercase hex characters");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EmitError("BlobRef.bytes must be a non-negative integer");
    if (mime !== undefined && !MIME.test(mime)) throw new EmitError(`BlobRef.mime is not a supported media type: ${mime}`);
    this.sha256 = sha256;
    this.bytes = bytes;
    this.mime = mime;
  }
}

/** Raw binary content that must be externalized before it can be emitted. */
export class BlobData {
  readonly data: Uint8Array;
  readonly mime: string;
  constructor(data: Uint8Array, mime = "application/octet-stream") {
    this.data = data;
    this.mime = mime;
  }
}

/**
 * A value carrying a schema tag, written `!name` before the value. Tags select a schema at the
 * layer above; the codec only preserves them, so unknown tags survive a read/write cycle unchanged.
 *
 * A tag may wrap a map, a list or a string. Tagged bare scalars (numbers, booleans, null) are not
 * allowed: YAML parsers disagree on how to read them, and nothing needs them.
 * The name "blob" is reserved for blob references.
 */
export class Tagged {
  readonly tag: string;
  readonly value: Map<string, Value> | Value[] | string;

  constructor(tag: string, value: Value) {
    if (!TAG_NAME.test(tag) || tag.length > MAX_TAG_LENGTH) throw new EmitError(`invalid tag name ${JSON.stringify(tag)}`);
    if (tag === "blob") throw new EmitError('the tag "blob" is reserved for blob references');
    if (typeof value !== "string" && !Array.isArray(value) && !(value instanceof Map)) {
      throw new EmitError(`a tag can only wrap a map, a list or a string (tag ${tag})`);
    }
    this.tag = tag;
    this.value = value;
  }
}

/**
 * The value model. Maps (not plain objects) are used so key order is preserved exactly,
 * including integer-like keys that JS objects would reorder.
 */
export type Value = null | boolean | number | string | BlobRef | BlobData | Tagged | Value[] | Map<string, Value>;

/** One transcript entry: a map, optionally tagged. */
export type Entry = Map<string, Value> | (Tagged & { readonly value: Map<string, Value> });

/** Order-sensitive deep equality (Object.is for numbers, so -0 and NaN are distinguished/equal). */
export function valueEquals(a: Value, b: Value): boolean {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
  if (a instanceof BlobRef) {
    return b instanceof BlobRef && a.sha256 === b.sha256 && a.bytes === b.bytes && a.mime === b.mime;
  }
  if (a instanceof BlobData) {
    return b instanceof BlobData && a.mime === b.mime && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);
  }
  if (a instanceof Tagged) return b instanceof Tagged && a.tag === b.tag && valueEquals(a.value, b.value);
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => valueEquals(x, b[i] as Value));
  }
  if (!(b instanceof Map) || a.size !== b.size) return false;
  const bi = b.entries();
  for (const [k, v] of a) {
    const n = bi.next();
    if (n.done || n.value[0] !== k || !valueEquals(v, n.value[1])) return false;
  }
  return true;
}

/** Convert JSON-like data to the value model. Object key order follows JS (integer-like keys first). */
export function fromPlain(x: unknown): Value {
  if (x === null || typeof x === "boolean" || typeof x === "number" || typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(fromPlain);
  if (x instanceof Map || x instanceof BlobRef || x instanceof BlobData || x instanceof Tagged) return x as Value;
  if (typeof x === "object") {
    const m = new Map<string, Value>();
    for (const k of Object.keys(x)) m.set(k, fromPlain((x as Record<string, unknown>)[k]));
    return m;
  }
  throw new EmitError(`cannot represent ${typeof x} value`);
}

/** Convert to JSON-like data for inspection. Blob refs and tags become plain objects; do not use for writing. */
export function toPlain(v: Value): unknown {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof BlobRef) return { blob: v.sha256, bytes: v.bytes, ...(v.mime === undefined ? {} : { mime: v.mime }) };
  if (v instanceof BlobData) return { blob: "(unstored)", bytes: v.data.length, mime: v.mime };
  if (v instanceof Tagged) return { tag: v.tag, value: toPlain(v.value) };
  if (Array.isArray(v)) return v.map(toPlain);
  const o: Record<string, unknown> = {};
  for (const [k, x] of v) Object.defineProperty(o, k, { value: toPlain(x), enumerable: true, writable: true, configurable: true });
  return o;
}
