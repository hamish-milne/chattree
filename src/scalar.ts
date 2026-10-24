import { EmitError, ParseError } from "./errors.ts";

/**
 * Words that YAML 1.1 or 1.2 parsers may read as non-strings. Compared case-insensitively.
 * Strings equal to these are always quoted, which avoids the "Norway problem".
 */
const RESERVED = new Set(["y", "n", "yes", "no", "true", "false", "on", "off", "null"]);

export const BARE_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Identifier-like words that some YAML parsers still read as numbers. The YAML 1.1 float rule in the
 * `yaml` package, for instance, reads "e5" as NaN. They are quoted like the reserved words.
 */
const EXPONENT_LIKE_RE = /^[eE][+-]?[0-9]/;

/** Words that must be quoted even though they look like identifiers. */
export function isReservedWord(s: string): boolean {
  return RESERVED.has(s.toLowerCase()) || EXPONENT_LIKE_RE.test(s);
}

/** True if the string may be written without quotes: a conservative identifier-like allowlist. */
export function isBare(s: string): boolean {
  return BARE_RE.test(s) && !isReservedWord(s);
}

/** Characters that are never written raw inside a double-quoted scalar. */
const EXTRA_BAD = [0x2028, 0x2029, 0xfeff, 0xfffe, 0xffff].map((c) => "\\u" + c.toString(16)).join("");
const QUOTE_ESCAPE_SRC = '[\\u0000-\\u001f"\\\\\\u007f-\\u009f' + EXTRA_BAD + "]";
const QUOTE_ESCAPE_RE = new RegExp(QUOTE_ESCAPE_SRC, "g");
const QUOTE_ESCAPE_TEST = new RegExp(QUOTE_ESCAPE_SRC);

/** Characters that disqualify a string from block-scalar form (raw LF and TAB are fine). */
const BLOCK_BAD_RE = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f" + EXTRA_BAD + "]");

export function hasBlockBadChars(s: string): boolean {
  return BLOCK_BAD_RE.test(s);
}

export function assertWellFormed(s: string, what = "string"): void {
  if (!s.isWellFormed()) {
    throw new EmitError(`${what} contains a lone surrogate and cannot be encoded as UTF-8; sanitize with toWellFormed() at the tool boundary`);
  }
}

function escapeChar(c: string): string {
  switch (c) {
    case '"': return '\\"';
    case "\\": return "\\\\";
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    default: return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
  }
}

/** Double-quoted scalar. Everything outside printable Unicode is escaped, so the result is one line. */
export function quote(s: string): string {
  assertWellFormed(s);
  return '"' + (QUOTE_ESCAPE_TEST.test(s) ? s.replace(QUOTE_ESCAPE_RE, escapeChar) : s) + '"';
}

/**
 * Chomping indicator if the string can be written as a literal block scalar, else null.
 * "" = clip (single trailing newline), "-" = strip (no trailing newline).
 *
 * Excluded (these fall back to a quoted scalar):
 *  - strings with no newline (a quoted line is clearer),
 *  - raw control characters or Unicode line separators,
 *  - 2+ trailing newlines (would need "keep" chomping and blur the entry terminator),
 *  - a first line that is empty or starts with whitespace (would need an indentation indicator).
 */
export function blockChomp(s: string): "" | "-" | null {
  if (!s.includes("\n")) return null;
  if (BLOCK_BAD_RE.test(s)) return null;
  if (s.endsWith("\n\n")) return null;
  const c0 = s.charCodeAt(0);
  if (c0 === 0x20 || c0 === 0x09 || c0 === 0x0a) return null;
  return s.endsWith("\n") ? "" : "-";
}

export interface QuotedScan {
  value: string;
  /** Index just past the closing quote. */
  end: number;
}

/**
 * Scan a double-quoted scalar starting at text[start] === '"'. Strict: only the escapes the
 * emitter produces are accepted, and raw characters the emitter would escape are rejected.
 * Written as a loop (no regex backtracking) so hostile input cannot blow the stack.
 */
export function scanQuoted(text: string, start: number, line?: number): QuotedScan {
  let i = start + 1;
  let chunkStart = i;
  let out = "";
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      out += text.slice(chunkStart, i);
      if (!out.isWellFormed()) throw new ParseError("escape sequence produces a lone surrogate", line);
      return { value: out, end: i + 1 };
    }
    if (c === 0x5c) {
      out += text.slice(chunkStart, i);
      const e = text.charCodeAt(i + 1);
      switch (e) {
        case 0x22: out += '"'; i += 2; break;
        case 0x5c: out += "\\"; i += 2; break;
        case 0x6e: out += "\n"; i += 2; break;
        case 0x72: out += "\r"; i += 2; break;
        case 0x74: out += "\t"; i += 2; break;
        case 0x75: {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-f]{4}$/.test(hex)) throw new ParseError("invalid \\u escape (need 4 lowercase hex digits)", line);
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default: throw new ParseError("unsupported escape sequence", line);
      }
      chunkStart = i;
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || c === 0xfffe || c === 0xffff) {
      throw new ParseError(`raw U+${c.toString(16).padStart(4, "0").toUpperCase()} must be escaped inside quotes`, line);
    }
    i++;
  }
  throw new ParseError("unterminated quoted string", line);
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new EmitError(`cannot represent non-finite number ${n}`);
  if (Object.is(n, -0)) throw new EmitError("cannot represent negative zero");
  return String(n);
}

export const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/;
