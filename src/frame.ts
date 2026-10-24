import { emitEntry } from "./emit.ts";
import { FrameError, ParseError } from "./errors.ts";
import { parseEntry, type ParseOptions } from "./parse.ts";
import { TAG_NAME, type Entry } from "./value.ts";

const NL = 0x0a;
const DASH = 0x2d;
const SP = 0x20;

export interface Span {
  /** Offset of the entry's leading "- ". */
  start: number;
  /** Offset just past the entry's terminating blank line. */
  end: number;
}

export interface ScanResult {
  /** Complete entries, in order. */
  spans: Span[];
  /** Length of the valid prefix. Truncating the file here removes an incomplete tail and nothing else. */
  validLength: number;
  /** True if bytes after validLength form an incomplete entry (typically an interrupted write). */
  truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict UTF-8 decode: invalid sequences throw, and a BOM is kept (not silently stripped) so it can be rejected. */
export function decodeStrict(bytes: Uint8Array): string {
  let s: string;
  try {
    s = decoder.decode(bytes);
  } catch {
    throw new ParseError("invalid UTF-8");
  }
  if (s.charCodeAt(0) === 0xfeff) throw new ParseError("byte order mark is not allowed");
  return s;
}

export function encodeEntry(entry: Entry): Uint8Array {
  return encoder.encode(emitEntry(entry));
}

/**
 * An incomplete tail must look like a prefix of a valid entry. In a valid file the only control bytes are
 * LF and TAB (everything else is escaped), and the only empty line is the terminator. A tail that breaks
 * either rule is damage, not an interrupted write, and must not be "repaired" by truncation.
 */
function checkTail(bytes: Uint8Array, start: number): void {
  let prev = 0;
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if ((b < 0x20 && b !== NL && b !== 0x09) || b === 0x7f) {
      throw new FrameError(i, `byte 0x${b.toString(16).padStart(2, "0")} cannot occur in a valid entry; the tail is damaged, not merely incomplete`);
    }
    if (b === NL && prev === NL) throw new FrameError(i, "blank line inside an incomplete entry; the tail is damaged, not merely incomplete");
    prev = b;
  }
}

/** True if the file is empty or ends with a complete entry's blank-line terminator. */
export function endsCleanly(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n === 0 || (n >= 2 && bytes[n - 1] === NL && bytes[n - 2] === NL);
}

/**
 * Append one entry to the contents of a transcript. Refuses if the existing bytes end in the middle of an
 * entry: a raw append there can graft the new entry onto the damaged one and still produce valid-looking
 * text, which no later scan can detect. Callers repair first (truncate to scan().validLength).
 * File-based callers do the same with a two-byte read of the file's end, under a lock.
 */
export function appendEntry(file: Uint8Array, entry: Entry): Uint8Array {
  if (!endsCleanly(file)) throw new FrameError(file.length, "file does not end with a complete entry; repair the tail before appending");
  const add = encodeEntry(entry);
  const out = new Uint8Array(file.length + add.length);
  out.set(file);
  out.set(add, file.length);
  return out;
}

/**
 * Frame a transcript file without decoding it. An entry starts at a line beginning "- " in column 0 and
 * is complete only if it ends with a blank line. Both facts are visible in raw bytes, so a file whose
 * tail was cut in the middle of a multi-byte character is handled the same as any other truncation.
 *
 * Throws FrameError if the file does not start with an entry, or if a non-final entry is incomplete
 * (e.g. new entries were appended after a truncated write instead of repairing the tail first).
 */
export function scan(bytes: Uint8Array): ScanResult {
  const n = bytes.length;
  if (n === 0) return { spans: [], validLength: 0, truncated: false };
  if (bytes[0] !== DASH || (n > 1 && bytes[1] !== SP)) {
    throw new FrameError(0, bytes[0] === 0xef ? "byte order mark is not allowed" : "file must start with '- '");
  }

  const starts: number[] = [0];
  // "\n- " begins an entry. A lone "-" at the very end is the first byte of one that was cut short.
  for (let i = 0; i < n - 1; i++) {
    if (bytes[i] === NL && bytes[i + 1] === DASH && (i + 2 === n || bytes[i + 2] === SP)) starts.push(i + 1);
  }

  const spans: Span[] = [];
  let validLength = 0;
  let truncated = false;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k] as number;
    const end = k + 1 < starts.length ? (starts[k + 1] as number) : n;
    if (end - start >= 4 && bytes[end - 1] === NL && bytes[end - 2] === NL) {
      spans.push({ start, end });
      validLength = end;
    } else if (k === starts.length - 1) {
      checkTail(bytes, start);
      truncated = true;
    } else {
      throw new FrameError(start, "entry is missing its terminating blank line (file damaged or appended to after a truncated write)");
    }
  }
  return { spans, validLength, truncated };
}

/** Index of the last entry start at or before `limit - 1`, searching backwards; -1 if none. */
function lastStartBefore(bytes: Uint8Array, limit: number): number {
  const n = bytes.length;
  for (let i = Math.min(limit, n) - 1; i >= 0; i--) {
    if (bytes[i] === DASH && (i + 1 === n || bytes[i + 1] === SP) && (i === 0 || bytes[i - 1] === NL)) return i;
  }
  return -1;
}

/**
 * Locate the final complete entry by scanning backwards, so the cost depends on the size of that entry
 * and not on the file. Unlike scan() it does not validate earlier entries.
 */
export function lastCompleteSpan(bytes: Uint8Array): Span | undefined {
  const n = bytes.length;
  if (n === 0) return undefined;
  let end = n;
  let start = lastStartBefore(bytes, n);
  if (start < 0) return undefined;
  if (!(end - start >= 4 && bytes[end - 1] === NL && bytes[end - 2] === NL)) {
    // The final chunk is an incomplete tail; the entry before it is the one we want.
    end = start;
    if (end === 0) return undefined;
    if (bytes[end - 1] !== NL || bytes[end - 2] !== NL) throw new FrameError(start, "entry before the tail is missing its terminating blank line");
    start = lastStartBefore(bytes, end);
    if (start < 0) return undefined;
  }
  return { start, end };
}

/**
 * The tag of the entry at `span`, read from its first line without decoding or parsing the rest
 * (`- !user` gives "user"). Returns undefined for an untagged entry. Meant for indexes and UIs that
 * filter by entry type; it does not validate the entry.
 */
export function peekTag(bytes: Uint8Array, span: Span): string | undefined {
  let i = span.start + 2;
  if (bytes[i] !== 0x21) return undefined;
  const from = ++i;
  while (i < span.end && bytes[i] !== NL && bytes[i] !== SP) i++;
  let name = "";
  for (let k = from; k < i; k++) name += String.fromCharCode(bytes[k] as number);
  return TAG_NAME.test(name) ? name : undefined;
}

export function decodeSpan(bytes: Uint8Array, span: Span, opts?: ParseOptions): Entry {
  return parseEntry(decodeStrict(bytes.subarray(span.start, span.end)), opts);
}

export interface ParsedFile {
  entries: Entry[];
  validLength: number;
  truncated: boolean;
}

/** Frame, decode and parse a whole file. An incomplete tail is reported, not parsed. */
export function parseFile(bytes: Uint8Array, opts?: ParseOptions): ParsedFile {
  const { spans, validLength, truncated } = scan(bytes);
  return { entries: spans.map((s) => decodeSpan(bytes, s, opts)), validLength, truncated };
}
