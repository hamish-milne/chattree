import { sha256Hex } from "./blobs.ts";
import { emitEntry } from "./emit.ts";
import { BlobData, BlobRef, Tagged, type Value } from "./value.ts";

/** Copy of the value with every map's keys in code-unit order, recursively. Lists keep their order. */
export function sortKeysDeep(v: Value): Value {
  if (v === null || typeof v !== "object" || v instanceof BlobRef || v instanceof BlobData) return v;
  if (v instanceof Tagged) return new Tagged(v.tag, sortKeysDeep(v.value));
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  const out = new Map<string, Value>();
  for (const k of [...v.keys()].sort()) out.set(k, sortKeysDeep(v.get(k) as Value));
  return out;
}

/** The canonical text a value is hashed as: key-sorted, in the same format as an entry. */
export function canonicalText(v: Value): string {
  return emitEntry(new Map<string, Value>([["value", sortKeysDeep(v)]]));
}

/**
 * SHA-256 (hex) of a value's canonical text. Independent of map key order and of anything that is not
 * part of the data (comments, spacing and quoting in a source file). List order does matter, so sort
 * lists whose order is not meaningful (tools, skills) before hashing.
 */
export async function hashValue(v: Value): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalText(v)));
}
