import { externalizeValue, type BlobStore, type ExternalizeOptions } from "./blobs.ts";
import { BlobRef, BlobData, Tagged, type Value } from "./value.ts";

/**
 * A pre-serialization step: takes the value about to be written and returns the value to write.
 * Transforms run in order, after validation and before the entry is emitted.
 */
export type Transform = (value: Value) => Value | Promise<Value>;

/** Apply `fn` to every string value, including strings directly wrapped by a tag. Keys and tags are untouched. */
export function mapValueStrings(v: Value, fn: (s: string) => string): Value {
  if (typeof v === "string") return fn(v);
  if (v === null || typeof v !== "object" || v instanceof BlobRef || v instanceof BlobData) return v;
  if (v instanceof Tagged) return new Tagged(v.tag, mapValueStrings(v.value, fn));
  if (Array.isArray(v)) return v.map((x) => mapValueStrings(x, fn));
  const out = new Map<string, Value>();
  for (const [k, x] of v) out.set(k, mapValueStrings(x, fn));
  return out;
}

/** A transform that rewrites every string value. */
export function mapStrings(fn: (s: string) => string): Transform {
  return (v) => mapValueStrings(v, fn);
}

/**
 * Replace lone surrogates with U+FFFD so the text can be encoded as UTF-8. Prefer applying this where
 * data enters the harness, so what is stored is what the model saw; this is the safety net.
 */
export function wellFormed(): Transform {
  return mapStrings((s) => s.toWellFormed());
}

/**
 * Replace anything matching the patterns, in every string value. Put this before `externalizeLarge` so
 * secrets are removed before large values are stored as blobs.
 */
export function redact(patterns: readonly RegExp[], replacement = "[REDACTED]"): Transform {
  const globals = patterns.map((re) => (re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g")));
  return mapStrings((s) => globals.reduce((acc, re) => acc.replace(re, replacement), s));
}

/** Store oversized strings and binary values as blobs and replace them with references. */
export function externalizeLarge(store: BlobStore, opts?: ExternalizeOptions): Transform {
  return (v) => externalizeValue(v, store, opts);
}
