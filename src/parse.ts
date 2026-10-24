import { emitEntry } from "./emit.ts";
import { EmitError, ParseError } from "./errors.ts";
import { BARE_RE, hasBlockBadChars, isReservedWord, NUMBER_RE, scanQuoted } from "./scalar.ts";
import { BlobRef, MAX_DEPTH, Tagged, type Entry, type Value } from "./value.ts";

export interface ParseOptions {
  /**
   * Re-emit the parsed value and require byte-identical text (default true). This is what makes the
   * parser accept exactly what the emitter produces and nothing else. Turn it off only on a hot path
   * where the file is already trusted.
   */
  canonical?: boolean;
}

class Cursor {
  lines: string[];
  pos = 0;
  constructor(lines: string[]) {
    this.lines = lines;
  }
  /** 1-based number of the line most recently consumed, for error messages. */
  get here(): number {
    return Math.max(1, this.pos);
  }
}

const BLOB_RE = /^!blob \{sha256: "([0-9a-f]{64})", bytes: (0|[1-9][0-9]*)(?:, mime: "([^"\\]+)")?\}$/;
const BARE_KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*):/;
const TAG_TOKEN_RE = /^!([A-Za-z][A-Za-z0-9_./-]*)/;

function tryParseKey(text: string, line: number): { key: string; end: number } | null {
  if (text.charCodeAt(0) === 0x22) {
    const q = scanQuoted(text, 0, line);
    return text.charCodeAt(q.end) === 0x3a ? { key: q.value, end: q.end + 1 } : null;
  }
  const m = BARE_KEY_RE.exec(text);
  return m ? { key: m[1] as string, end: m[0].length } : null;
}

function checkDepth(depth: number, line: number): void {
  if (depth > MAX_DEPTH) throw new ParseError(`nesting deeper than ${MAX_DEPTH}`, line);
}

/** True for "!name..." text that is a tag, as opposed to the "!blob {...}" reference form. */
function startsWithTag(text: string): boolean {
  return text.charCodeAt(0) === 0x21 && !text.startsWith("!blob ");
}

/** Split "!name" or "!name rest" into the tag and the text after the single separating space. */
function splitTag(text: string, ln: number): { tag: string; rest: string | undefined } {
  const m = TAG_TOKEN_RE.exec(text);
  if (!m) throw new ParseError("malformed tag", ln);
  const after = text.slice(m[0].length);
  if (after === "") return { tag: m[1] as string, rest: undefined };
  if (after.charCodeAt(0) !== 0x20) throw new ParseError("expected a space after the tag", ln);
  return { tag: m[1] as string, rest: after.slice(1) };
}

function makeTagged(tag: string, value: Value, ln: number): Tagged {
  try {
    return new Tagged(tag, value);
  } catch (e) {
    if (e instanceof EmitError) throw new ParseError(e.message, ln);
    throw e;
  }
}

function parseMap(cur: Cursor, col: number, firstText: string | undefined, depth: number): Map<string, Value> {
  checkDepth(depth, cur.here);
  const m = new Map<string, Value>();
  const indent = " ".repeat(col);
  let pending = firstText; // the first entry's line was already consumed by the caller
  for (;;) {
    let text: string;
    if (pending !== undefined) {
      text = pending;
      pending = undefined;
    } else {
      const line = cur.lines[cur.pos];
      if (line === undefined || !line.startsWith(indent)) break;
      const c = line.charCodeAt(col);
      if (c === 0x20 || c === 0x2d) break; // deeper indentation or a sequence marker: not ours
      text = line.slice(col);
      cur.pos++;
    }
    const ln = cur.here;
    const kv = tryParseKey(text, ln);
    if (kv === null) throw new ParseError("expected a map key", ln);
    const after = text.slice(kv.end);
    let value: Value;
    if (after === "") value = parseNested(cur, col, depth, ln);
    else if (after.charCodeAt(0) === 0x20) value = parseValue(after.slice(1), cur, col, depth, ln);
    else throw new ParseError("expected a space after ':'", ln);
    if (m.has(kv.key)) throw new ParseError(`duplicate key ${JSON.stringify(kv.key)}`, ln);
    m.set(kv.key, value);
  }
  return m;
}

/** The text after "key: ": an optional tag, then an inline value, a block scalar, or (a lone tag) a nested block. */
function parseValue(text: string, cur: Cursor, col: number, depth: number, ln: number): Value {
  if (startsWithTag(text)) {
    const { tag, rest } = splitTag(text, ln);
    return makeTagged(tag, rest === undefined ? parseNested(cur, col, depth, ln) : parseInline(rest, cur, col + 2, ln), ln);
  }
  return parseInline(text, cur, col + 2, ln);
}

/** A key with nothing after the colon: a compact sequence at the key's column, or a map one level deeper. */
function parseNested(cur: Cursor, col: number, depth: number, ln: number): Value {
  const line = cur.lines[cur.pos];
  if (line === undefined) throw new ParseError("expected a nested block", ln);
  if (line.startsWith(" ".repeat(col) + "-") && line.charCodeAt(col + 1) !== 0x2d) {
    return parseSeq(cur, col, depth + 1);
  }
  const deeper = " ".repeat(col + 2);
  if (line.startsWith(deeper) && line.charCodeAt(col + 2) !== 0x20) {
    cur.pos++;
    return parseMap(cur, col + 2, line.slice(col + 2), depth + 1);
  }
  throw new ParseError("expected a nested block", cur.pos + 1);
}

/** The block under a tagged list item ("- !tag"): a sequence or a map, two columns past the dash. */
function parseItemBlock(cur: Cursor, col: number, depth: number, ln: number): Value {
  const line = cur.lines[cur.pos];
  const deeper = " ".repeat(col + 2);
  if (line === undefined || !line.startsWith(deeper)) throw new ParseError("expected a block under the tag", ln);
  if (line === deeper + "-" || line.startsWith(deeper + "- ")) return parseSeq(cur, col + 2, depth + 1);
  if (line.charCodeAt(col + 2) === 0x20) throw new ParseError("unexpected indentation", cur.pos + 1);
  cur.pos++;
  return parseMap(cur, col + 2, line.slice(col + 2), depth + 1);
}

function parseSeq(cur: Cursor, col: number, depth: number): Value[] {
  checkDepth(depth, cur.here);
  const arr: Value[] = [];
  const marker = " ".repeat(col) + "-";
  for (;;) {
    const line = cur.lines[cur.pos];
    if (line === undefined || !line.startsWith(marker)) break;
    cur.pos++;
    const ln = cur.here;
    if (line.length === col + 1) {
      // "-" alone: a nested sequence one level deeper
      const next = cur.lines[cur.pos];
      if (next === undefined || !next.startsWith(" ".repeat(col + 2) + "-")) throw new ParseError("expected a nested sequence", ln);
      arr.push(parseSeq(cur, col + 2, depth + 1));
    } else if (line.charCodeAt(col + 1) === 0x20) {
      const rest = line.slice(col + 2);
      if (startsWithTag(rest)) {
        const { tag, rest: after } = splitTag(rest, ln);
        arr.push(makeTagged(tag, after === undefined ? parseItemBlock(cur, col, depth, ln) : parseInline(after, cur, col + 2, ln), ln));
      } else if (tryParseKey(rest, ln) !== null) {
        arr.push(parseMap(cur, col + 2, rest, depth + 1));
      } else {
        arr.push(parseInline(rest, cur, col + 2, ln));
      }
    } else {
      throw new ParseError("expected a space after '-'", ln);
    }
  }
  if (arr.length === 0) throw new ParseError("empty block sequence", cur.here);
  return arr;
}

function parseInline(text: string, cur: Cursor, contentIndent: number, ln: number): Value {
  const c = text.charCodeAt(0);
  if (c === 0x22) {
    const q = scanQuoted(text, 0, ln);
    if (q.end !== text.length) throw new ParseError("unexpected characters after quoted string", ln);
    return q.value;
  }
  if (c === 0x7c) return parseBlock(text, cur, contentIndent, ln);
  switch (text) {
    case "[]": return [];
    case "{}": return new Map();
    case "null": return null;
    case "true": return true;
    case "false": return false;
  }
  if (c === 0x21) {
    const m = BLOB_RE.exec(text);
    if (!m) throw new ParseError(text.startsWith("!blob ") ? "malformed !blob reference" : "unexpected tag", ln);
    const bytes = Number(m[2]);
    if (!Number.isSafeInteger(bytes)) throw new ParseError("blob size out of range", ln);
    try {
      return new BlobRef(m[1] as string, bytes, m[3]);
    } catch (e) {
      throw new ParseError((e as Error).message, ln);
    }
  }
  if (NUMBER_RE.test(text)) {
    const n = Number(text);
    if (String(n) !== text) throw new ParseError(`non-canonical number ${text}`, ln);
    return n;
  }
  if (BARE_RE.test(text) && !isReservedWord(text)) return text;
  throw new ParseError("unrecognised value", ln);
}

function parseBlock(header: string, cur: Cursor, contentIndent: number, ln: number): string {
  if (header !== "|" && header !== "|-") throw new ParseError("unsupported block scalar header", ln);
  const prefix = " ".repeat(contentIndent);
  const parts: string[] = [];
  for (;;) {
    const line = cur.lines[cur.pos];
    if (line === undefined || !line.startsWith(prefix)) break;
    parts.push(line.slice(contentIndent));
    cur.pos++;
  }
  if (parts.length === 0) throw new ParseError("empty block scalar", ln);
  const s = parts.join("\n") + (header === "|" ? "\n" : "");
  if (hasBlockBadChars(s)) throw new ParseError("block scalar contains characters that must be quoted", ln);
  return s;
}

/** The body of a tagged entry: fields on the lines below the dash line, two columns in. */
function parseEntryBody(cur: Cursor, lines: string[]): Map<string, Value> {
  const l1 = lines[1];
  if (l1 === undefined || !l1.startsWith("  ") || l1.charCodeAt(2) === 0x20) throw new ParseError("expected the entry's fields below its tag", 2);
  cur.pos = 2;
  return parseMap(cur, 2, l1.slice(2), 1);
}

/**
 * Parse the exact text of one entry (as produced by emitEntry, including the trailing blank line).
 * Throws ParseError for anything else; never any other error type.
 */
export function parseEntry(text: string, opts?: ParseOptions): Entry {
  if (!text.endsWith("\n\n")) throw new ParseError("entry must end with a blank line (incomplete write?)");
  if (text.includes("\r")) throw new ParseError("carriage returns are not allowed");
  const lines = text.slice(0, -2).split("\n");
  const first = lines[0];
  if (first === undefined || !first.startsWith("- ")) throw new ParseError("entry must start with '- '", 1);
  const cur = new Cursor(lines);
  cur.pos = 1;
  const rest = first.slice(2);
  let entry: Entry;
  if (startsWithTag(rest)) {
    const { tag, rest: after } = splitTag(rest, 1);
    let body: Map<string, Value>;
    if (after === undefined) body = parseEntryBody(cur, lines);
    else if (after === "{}") body = new Map();
    else throw new ParseError("a tagged entry must be a map", 1);
    entry = makeTagged(tag, body, 1) as Entry;
  } else if (rest === "{}") {
    entry = new Map();
  } else {
    entry = parseMap(cur, 2, rest, 1);
  }
  if (cur.pos !== lines.length) throw new ParseError("unexpected content or indentation", cur.pos + 1);

  if (opts?.canonical !== false) {
    let again: string;
    try {
      again = emitEntry(entry);
    } catch (e) {
      if (e instanceof EmitError) throw new ParseError(`not representable canonically: ${e.message}`);
      throw e;
    }
    if (again !== text) {
      let i = 0;
      while (i < again.length && again.charCodeAt(i) === text.charCodeAt(i)) i++;
      const ln = text.slice(0, i).split("\n").length;
      throw new ParseError("entry is valid but not in canonical form", ln);
    }
  }
  return entry;
}
