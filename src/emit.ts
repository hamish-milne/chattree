import { EmitError } from "./errors.ts";
import { assertWellFormed, blockChomp, formatNumber, isBare, quote } from "./scalar.ts";
import { BlobData, BlobRef, MAX_DEPTH, Tagged, type Entry, type Value } from "./value.ts";

const MAX_KEY_LENGTH = 4096;

function keyText(k: string): string {
  if (k.length > MAX_KEY_LENGTH) throw new EmitError(`map key longer than ${MAX_KEY_LENGTH} characters`);
  assertWellFormed(k, "map key");
  return isBare(k) ? k : quote(k);
}

type Shape =
  | { kind: "inline"; text: string }
  | { kind: "block"; chomp: "" | "-"; s: string }
  | { kind: "seq"; items: Value[] }
  | { kind: "map"; map: Map<string, Value> };

/** A shape plus the tag written before it, if any ("" when untagged). */
type Form = Shape & { tag: string };

function shapeOf(v: Value): Shape {
  if (v === null) return { kind: "inline", text: "null" };
  switch (typeof v) {
    case "boolean": return { kind: "inline", text: v ? "true" : "false" };
    case "number": return { kind: "inline", text: formatNumber(v) };
    case "string": {
      assertWellFormed(v);
      if (v === "") return { kind: "inline", text: '""' };
      if (isBare(v)) return { kind: "inline", text: v };
      const chomp = blockChomp(v);
      return chomp === null ? { kind: "inline", text: quote(v) } : { kind: "block", chomp, s: v };
    }
  }
  if (v instanceof BlobRef) {
    const mime = v.mime === undefined ? "" : `, mime: "${v.mime}"`;
    return { kind: "inline", text: `!blob {sha256: "${v.sha256}", bytes: ${v.bytes}${mime}}` };
  }
  if (v instanceof BlobData) throw new EmitError("BlobData must be externalized (stored and replaced by a BlobRef) before emitting");
  if (v instanceof Tagged) throw new EmitError("tags cannot be nested");
  if (Array.isArray(v)) return v.length === 0 ? { kind: "inline", text: "[]" } : { kind: "seq", items: v };
  if (v instanceof Map) return v.size === 0 ? { kind: "inline", text: "{}" } : { kind: "map", map: v };
  throw new EmitError(`cannot represent value of type ${typeof v}`);
}

function formOf(v: Value): Form {
  if (v instanceof Tagged) return { ...shapeOf(v.value), tag: v.tag };
  return { ...shapeOf(v), tag: "" };
}

/** " !name" after a head that has nothing else on its line, or "" if untagged. */
const tagSuffix = (f: Form): string => (f.tag === "" ? "" : ` !${f.tag}`);
/** "!name " in front of an inline value or block header, or "" if untagged. */
const tagPrefix = (f: Form): string => (f.tag === "" ? "" : `!${f.tag} `);

function pushBlock(out: string[], head: string, f: Form & { kind: "block" }, indent: number): void {
  out.push(`${head} ${tagPrefix(f)}|${f.chomp}`);
  const lines = f.s.split("\n");
  if (f.chomp === "") lines.pop(); // trailing newline is expressed by clip chomping, not an empty line
  const pad = " ".repeat(indent);
  // Empty lines become indent-only lines so that a truly empty line only ever appears as the entry terminator.
  for (const line of lines) out.push(pad + line);
}

/** `lead` replaces the indentation of the first key line (used for the "- " of a sequence item). */
function emitMap(out: string[], m: Map<string, Value>, col: number, lead: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new EmitError(`nesting deeper than ${MAX_DEPTH}`);
  const pad = " ".repeat(col);
  let first = true;
  for (const [k, v] of m) {
    const head = (first ? lead : pad) + keyText(k) + ":";
    first = false;
    const f = formOf(v);
    switch (f.kind) {
      case "inline": out.push(`${head} ${tagPrefix(f)}${f.text}`); break;
      case "block": pushBlock(out, head, f, col + 2); break;
      case "seq": out.push(head + tagSuffix(f)); emitSeq(out, f.items, col, depth + 1); break; // compact: items at the key's column
      case "map": out.push(head + tagSuffix(f)); emitMap(out, f.map, col + 2, " ".repeat(col + 2), depth + 1); break;
    }
  }
}

function emitSeq(out: string[], items: Value[], col: number, depth: number): void {
  if (depth > MAX_DEPTH) throw new EmitError(`nesting deeper than ${MAX_DEPTH}`);
  const pad = " ".repeat(col);
  for (const item of items) {
    const f = formOf(item);
    switch (f.kind) {
      case "inline": out.push(`${pad}- ${tagPrefix(f)}${f.text}`); break;
      case "block": pushBlock(out, `${pad}-`, f, col + 2); break;
      case "map":
        if (f.tag === "") emitMap(out, f.map, col + 2, `${pad}- `, depth + 1); // untagged: first key shares the dash line
        else {
          out.push(`${pad}-${tagSuffix(f)}`);
          emitMap(out, f.map, col + 2, " ".repeat(col + 2), depth + 1);
        }
        break;
      case "seq": out.push(`${pad}-${tagSuffix(f)}`); emitSeq(out, f.items, col + 2, depth + 1); break;
    }
  }
}

/**
 * Canonical text of one transcript entry: a block-sequence item at column 0, followed by a blank
 * line. A tagged entry puts its tag on the dash line and its fields on the lines below:
 *
 *     - !user
 *       id: ...
 *
 * The result always ends with "\n\n"; that blank line is the completion marker and cannot
 * occur anywhere else in a valid file.
 */
export function emitEntry(entry: Entry): string {
  let tag = "";
  let map: Map<string, Value>;
  if (entry instanceof Tagged) {
    if (!(entry.value instanceof Map)) throw new EmitError("a tagged entry must wrap a map");
    tag = entry.tag;
    map = entry.value;
  } else if (entry instanceof Map) {
    map = entry;
  } else {
    throw new EmitError("an entry must be a Map or a tagged Map");
  }
  const out: string[] = [];
  if (map.size === 0) out.push(tag === "" ? "- {}" : `- !${tag} {}`);
  else if (tag === "") emitMap(out, map, 2, "- ", 1);
  else {
    out.push(`- !${tag}`);
    emitMap(out, map, 2, "  ", 1);
  }
  return out.join("\n") + "\n\n";
}
