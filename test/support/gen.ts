import { BlobRef, Tagged, type Entry, type Value } from "../../src/index.ts";

/** Build strings from numeric code points so this file never needs invisible or separator characters. */
export const cp = (...c: number[]): string => String.fromCodePoint(...c);

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)] as T;
  }
}

/** Fragments chosen to stress quoting, block scalars, framing and YAML typing rules. */
export const PIECES: readonly string[] = [
  "a", "b", "Z", "0", "9", " ", "  ", "\t", "\n", "\n", "\n\n", "\r", "\r\n",
  '"', "'", "\\", "#", ":", ": ", "- ", "-", "---", "...", "|", "|-", ">", "{", "}", "[", "]", ",",
  "&", "*", "!", "!blob {", "%", "@", "`", "?", "~", "<<", "=",
  "null", "true", "no", "on", "y", "1e5", "0x1f", "0o17", ".inf", "12:30", "key: value", "- item", "\n- item", "\n  - x",
  cp(0), cp(0x1b), cp(0x7f), cp(0x85), cp(0x2028), cp(0x2029), cp(0xfeff), cp(0xfffe), cp(0xffff),
  cp(0xe9), cp(0xf1), cp(0x65, 0x301), cp(0xa0), cp(0x65e5, 0x672c, 0x8a9e), cp(0x1f600), cp(0x1f469, 0x200d, 0x1f4bb), cp(0x10ffff),
];

export const EDGE_STRINGS: readonly string[] = [
  "", " ", "\n", "\t", "a ", " a", "a\n", "a\n\n", "\na", "a\n ", "a\n  ", "a\n\nb", "a\n\n\nb", "a\tb\n", "x\r\ny", "\r",
  "- a\n- b", "#c\nd", "key: v\nk2: v2", "|\n", "---\n", "...\n", "a\n- b", "a\n  - b\n", "null", "true", "NO", "On", "y", "123", "1.5",
  "-", "- ", "!blob {sha256: x}", cp(0xfeff) + "a", "a" + cp(0x2028) + "b", "a\nb" + cp(0x85),
];

const WORDS = ["id", "type", "user", "text", "name", "args", "path", "content", "tool_call", "x", "key_1", "a.b-c", "Z9", "_u", "e5", "E-3", "e", "inf", "nan", "extra"];
const RESERVED = ["y", "n", "yes", "no", "true", "false", "on", "off", "null", "Null", "TRUE", "No"];

export function randomString(rng: Rng): string {
  const r = rng.next();
  if (r < 0.15) return rng.pick(EDGE_STRINGS);
  if (r < 0.3) return rng.pick(WORDS) + (rng.chance(0.3) ? String(rng.int(100)) : "");
  if (r < 0.4) {
    const piece = rng.pick(PIECES);
    return piece.repeat(1 + rng.int(300));
  }
  let s = "";
  const n = rng.int(11);
  for (let i = 0; i < n; i++) s += rng.pick(PIECES);
  return s;
}

export function randomKey(rng: Rng): string {
  const r = rng.next();
  if (r < 0.4) return rng.pick(WORDS);
  if (r < 0.55) return rng.pick(RESERVED);
  if (r < 0.62) return String(rng.int(1000));
  // Slice by code point: slicing UTF-16 units could split a surrogate pair and produce an unencodable key.
  return Array.from(randomString(rng)).slice(0, 40).join("");
}

export interface GenOptions {
  /** Restrict numbers to forms that YAML 1.1 and 1.2 agree on (no exponents). */
  simpleNumbers?: boolean;
  /** Include BlobRef values. */
  blobs?: boolean;
  /** Wrap some maps, lists and strings (and some whole entries) in tags. */
  tags?: boolean;
}

export const TAGS: readonly string[] = ["user", "assistant", "tool_call", "text", "x-vendor/thing", "a.b", "T1", "header", "e5"];

function randomNumber(rng: Rng, simple: boolean): number {
  const r = rng.next();
  let n: number;
  if (r < 0.5) n = rng.int(2_000_000) - 1_000_000;
  else if (r < 0.65) n = Math.floor(rng.next() * Number.MAX_SAFE_INTEGER) * (rng.chance(0.5) ? -1 : 1);
  else if (r < 0.9 || simple) n = Number((rng.next() * 1000 - 500).toFixed(1 + rng.int(5)));
  else n = rng.pick([1e21, 1.5e-7, 2.5e300, 5e-324, Number.MAX_SAFE_INTEGER * 10, -3e-9]);
  return Object.is(n, -0) ? 0 : n;
}

const MIMES = ["text/plain", "application/octet-stream", "image/png", "application/json"];

function randomHex(rng: Rng): string {
  let h = "";
  for (let i = 0; i < 64; i++) h += "0123456789abcdef"[rng.int(16)];
  return h;
}

export function randomValue(rng: Rng, depth: number, opts: GenOptions = {}): Value {
  const v = randomUntagged(rng, depth, opts);
  const wrappable = typeof v === "string" || Array.isArray(v) || v instanceof Map;
  return opts.tags === true && wrappable && rng.chance(0.25) ? new Tagged(rng.pick(TAGS), v) : v;
}

function randomUntagged(rng: Rng, depth: number, opts: GenOptions): Value {
  const containers = depth < 4;
  const r = rng.next();
  if (r < 0.05) return null;
  if (r < 0.1) return rng.chance(0.5);
  if (r < 0.2) return randomNumber(rng, opts.simpleNumbers === true);
  if (opts.blobs === true && r < 0.25) return new BlobRef(randomHex(rng), rng.int(1_000_000), rng.chance(0.7) ? rng.pick(MIMES) : undefined);
  if (r < 0.6 || !containers) return randomString(rng);
  if (r < 0.8) {
    const n = rng.int(5);
    return Array.from({ length: n }, () => randomValue(rng, depth + 1, opts));
  }
  const m = new Map<string, Value>();
  const n = rng.int(5);
  for (let i = 0; i < n; i++) m.set(randomKey(rng), randomValue(rng, depth + 1, opts));
  return m;
}

export function randomEntry(rng: Rng, opts: GenOptions = {}): Entry {
  const m = new Map<string, Value>();
  const n = rng.chance(0.03) ? 0 : 1 + rng.int(5);
  for (let i = 0; i < n; i++) m.set(randomKey(rng), randomValue(rng, 1, opts));
  return opts.tags === true && rng.chance(0.6) ? (new Tagged(rng.pick(TAGS), m) as Entry) : m;
}

const LOREM = ("the quick brown fox jumps over a lazy dog while parsing tool output from the build system and " +
  "reading configuration files error warning note fn let const return await async struct impl trait test passed failed").split(" ");

function paragraph(rng: Rng, targetBytes: number, multiline: boolean): string {
  let s = "";
  while (s.length < targetBytes) {
    s += rng.pick(LOREM) + (multiline && rng.chance(0.08) ? "\n" + " ".repeat(rng.int(3) * 2) : " ");
  }
  return s.trimEnd();
}

/** Entries shaped like real transcript traffic, with mostly ASCII text and occasional non-ASCII. */
export function realisticEntry(rng: Rng, i: number): Map<string, Value> {
  const id = `01K8${String(i).padStart(22, "0")}`;
  const r = rng.next();
  const size = Math.min(3500, Math.floor(40 + Math.exp(rng.next() * 7.5)));
  const nonAscii = rng.chance(0.05) ? " " + cp(0x65e5, 0x672c, 0x8a9e, 0x1f600) : "";
  const m = new Map<string, Value>();
  m.set("id", id);
  if (r < 0.25) {
    m.set("type", "user");
    m.set("content", [new Map<string, Value>([["text", paragraph(rng, size, true) + nonAscii]])]);
  } else if (r < 0.6) {
    m.set("type", "assistant");
    m.set("provider", "anthropic");
    m.set("model", "claude-sonnet-5-5");
    const blocks: Value[] = [];
    if (rng.chance(0.4)) blocks.push(new Map<string, Value>([["text", paragraph(rng, size, true) + nonAscii]]));
    blocks.push(new Map<string, Value>([["tool_call", new Map<string, Value>([
      ["call_id", `toolu_${rng.int(1e9)}`],
      ["name", rng.pick(["run_command", "read_file", "edit_file", "search"])],
      ["args", new Map<string, Value>([["command", paragraph(rng, 20 + rng.int(120), false)]])],
    ])]]));
    m.set("blocks", blocks);
    m.set("stop_reason", "tool_use");
    m.set("usage", new Map<string, Value>([["input", rng.int(50000)], ["output", rng.int(2000)], ["cache_read", rng.int(50000)]]));
  } else {
    m.set("type", "tool_result");
    m.set("call_id", `toolu_${rng.int(1e9)}`);
    m.set("is_error", rng.chance(0.1));
    m.set("content", paragraph(rng, size, true) + nonAscii + "\n");
  }
  return m;
}
