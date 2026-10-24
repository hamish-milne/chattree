import { BlobError, EmitError } from "./errors.ts";
import { decodeStrict } from "./frame.ts";
import { assertWellFormed } from "./scalar.ts";
import { BlobData, BlobRef, MAX_DEPTH, Tagged, type Entry, type Value } from "./value.ts";

/** Content-addressed storage for large or binary values. Implementations decide where bytes live. */
export interface BlobStore {
  /** Store bytes and return their lowercase hex SHA-256. Must be idempotent. */
  put(data: Uint8Array): Promise<string>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** In-memory store for tests and tools. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(data: Uint8Array): Promise<string> {
    const h = await sha256Hex(data);
    if (!this.blobs.has(h)) this.blobs.set(h, data.slice());
    return h;
  }
  async get(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256);
  }
}

export interface ExternalizeOptions {
  /** Strings whose UTF-8 encoding exceeds this many bytes are stored as blobs. Default 4096. */
  threshold?: number;
}

const encoder = new TextEncoder();
export const TEXT_MIME = "text/plain";

/**
 * Return a copy of the value with every oversized string and every BlobData replaced by a BlobRef.
 * The input is not modified. Map keys are never externalized, and neither is a string that is
 * directly wrapped by a tag (a tag cannot wrap a blob reference).
 */
export async function externalizeValue(value: Value, store: BlobStore, opts?: ExternalizeOptions): Promise<Value> {
  const threshold = opts?.threshold ?? 4096;
  async function walk(v: Value, depth: number): Promise<Value> {
    if (depth > MAX_DEPTH) throw new EmitError(`nesting deeper than ${MAX_DEPTH}`);
    if (typeof v === "string") {
      // UTF-8 length is at least s.length and at most 3 * s.length, so most strings need no encoding.
      if (v.length * 3 <= threshold) return v;
      assertWellFormed(v);
      const bytes = encoder.encode(v);
      if (bytes.length <= threshold) return v;
      return new BlobRef(await store.put(bytes), bytes.length, TEXT_MIME);
    }
    if (v instanceof BlobData) return new BlobRef(await store.put(v.data), v.data.length, v.mime);
    if (v instanceof Tagged) {
      return typeof v.value === "string" ? v : new Tagged(v.tag, await walk(v.value, depth));
    }
    if (Array.isArray(v)) {
      const out: Value[] = [];
      for (const x of v) out.push(await walk(x, depth + 1));
      return out;
    }
    if (v instanceof Map) {
      const out = new Map<string, Value>();
      for (const [k, x] of v) out.set(k, await walk(x, depth + 1));
      return out;
    }
    return v;
  }
  return walk(value, 0);
}

/** externalizeValue for a whole entry (the result is still an entry of the same kind). */
export async function externalize(entry: Entry, store: BlobStore, opts?: ExternalizeOptions): Promise<Entry> {
  return (await externalizeValue(entry, store, opts)) as Entry;
}

export interface ResolveOptions {
  /** Recompute each blob's SHA-256 and compare (default true). */
  verify?: boolean;
}

/**
 * Replace every BlobRef with its content: a string for text/plain, otherwise a Uint8Array.
 * Throws BlobError if a blob is missing or does not match its recorded size or hash.
 */
export async function resolve(v: Value, store: BlobStore, opts?: ResolveOptions): Promise<unknown> {
  const verify = opts?.verify !== false;
  async function walk(x: Value): Promise<unknown> {
    if (x instanceof BlobRef) {
      const data = await store.get(x.sha256);
      if (data === undefined) throw new BlobError(`blob ${x.sha256} not found`);
      if (data.length !== x.bytes) throw new BlobError(`blob ${x.sha256} has ${data.length} bytes, expected ${x.bytes}`);
      if (verify && (await sha256Hex(data)) !== x.sha256) throw new BlobError(`blob ${x.sha256} failed hash verification`);
      return x.mime === TEXT_MIME ? decodeStrict(data) : data;
    }
    if (x instanceof Tagged) return typeof x.value === "string" ? x : new Tagged(x.tag, (await walk(x.value)) as Value);
    if (Array.isArray(x)) return Promise.all(x.map(walk));
    if (x instanceof Map) {
      const out = new Map<string, unknown>();
      for (const [k, y] of x) out.set(k, await walk(y));
      return out;
    }
    return x;
  }
  return walk(v);
}
