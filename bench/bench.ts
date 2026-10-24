import { decodeStrict, emitEntry, encodeEntry, endsCleanly, lastCompleteSpan, parseEntry, parseFile, scan, decodeSpan, type Value } from "../src/index.ts";
import { Rng, realisticEntry } from "../test/support/gen.ts";

const NL = 0x0a;
const DASH = 0x2d;
const SP = 0x20;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function time(fn: () => unknown, runs = 7, warmup = 2): number {
  for (let i = 0; i < warmup; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

const rows: string[][] = [];
function report(name: string, ms: number, bytes: number) {
  const mbs = bytes / 1e6 / (ms / 1000);
  rows.push([name, ms >= 1 ? ms.toFixed(1) + " ms" : (ms * 1000).toFixed(1) + " us", mbs >= 10 ? mbs.toFixed(0) + " MB/s" : mbs.toFixed(1) + " MB/s"]);
}

function build(n: number): { bytes: Uint8Array; entries: Map<string, Value>[] } {
  const rng = new Rng(2026);
  const entries = Array.from({ length: n }, (_, i) => realisticEntry(rng, i));
  const parts = entries.map(encodeEntry);
  const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, entries };
}

// Alternative framing implementations, for comparison with the shipped scan().
function scanHopping(bytes: Uint8Array): number {
  let count = 1;
  let i = 0;
  for (;;) {
    const nl = bytes.indexOf(NL, i);
    if (nl < 0 || nl + 2 >= bytes.length) break;
    if (bytes[nl + 1] === DASH && bytes[nl + 2] === SP) count++;
    i = nl + 1;
  }
  return count;
}

function parseAllStrings(bytes: Uint8Array, canonical: boolean): number {
  const text = decodeStrict(bytes);
  let start = 0;
  let n = 0;
  for (;;) {
    const i = text.indexOf("\n- ", start);
    const end = i < 0 ? text.length : i + 1;
    parseEntry(text.slice(start, end), { canonical });
    n++;
    if (i < 0) break;
    start = end;
  }
  return n;
}

function parseAllBytes(bytes: Uint8Array, canonical: boolean): number {
  const { spans } = scan(bytes);
  for (const s of spans) decodeSpan(bytes, s, { canonical });
  return spans.length;
}

for (const n of [2000, 20000]) {
  rows.length = 0;
  const { bytes, entries } = build(n);
  const size = bytes.length;
  const nonAscii = bytes.reduce((c, b) => c + (b >= 0x80 ? 1 : 0), 0);
  console.log(`\n=== ${n} entries, ${(size / 1e6).toFixed(1)} MB, ${((nonAscii / size) * 100).toFixed(2)}% non-ASCII bytes ===`);

  // sanity: the variants must agree
  if (parseAllStrings(bytes, true) !== n || parseAllBytes(bytes, true) !== n || scanHopping(bytes) !== n) throw new Error("variants disagree");

  const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
  report("UTF-8 decode, fatal (strict)", time(() => fatal.decode(bytes)), size);
  report("UTF-8 decode, non-fatal", time(() => lenient.decode(bytes)), size);
  report("emit all entries (strings)", time(() => { for (const e of entries) emitEntry(e); }), size);
  report("emit + encode all entries (bytes)", time(() => { for (const e of entries) encodeEntry(e); }), size);

  rows.push(["-- framing only (find entry boundaries, detect truncation)", "", ""]);
  report("bytes: scan() manual loop", time(() => scan(bytes)), size);
  report("bytes: indexOf(LF) hopping (count only)", time(() => scanHopping(bytes)), size);
  report("string: strict decode + indexOf('\\n- ')", time(() => {
    const t = decodeStrict(bytes);
    let c = 0;
    for (let i = t.indexOf("\n- "); i >= 0; i = t.indexOf("\n- ", i + 1)) c++;
    return c;
  }), size);

  rows.push(["-- load everything into Maps", "", ""]);
  report("strings, canonical check ON", time(() => parseAllStrings(bytes, true), 5), size);
  report("bytes framing, canonical check ON", time(() => parseAllBytes(bytes, true), 5), size);
  report("strings, canonical check OFF", time(() => parseAllStrings(bytes, false), 5), size);
  report("bytes framing, canonical check OFF", time(() => parseAllBytes(bytes, false), 5), size);
  report("parseFile() (bytes, canonical ON)", time(() => parseFile(bytes), 5), size);

  const w = Math.max(...rows.map((r) => (r[0] as string).length));
  for (const r of rows) {
    if ((r[0] as string).startsWith("--")) console.log(r[0]);
    else console.log(`  ${(r[0] as string).padEnd(w)}  ${(r[1] as string).padStart(10)}  ${(r[2] as string).padStart(10)}`);
  }

  console.log("-- opening an existing transcript to append (is the tail clean? what is the last entry?)");
  const tOpenBytes = time(() => { endsCleanly(bytes); const s = lastCompleteSpan(bytes); return s && decodeSpan(bytes, s); }, 200, 20);
  const tOpenStrings = time(() => { const t = decodeStrict(bytes); const i = t.lastIndexOf("\n- "); return t.endsWith("\n\n") && parseEntry(t.slice(i + 1)); }, 7, 2);
  console.log(`  bytes: lastCompleteSpan + decode last entry only: ${(tOpenBytes * 1000).toFixed(1)} us`);
  console.log(`  strings: decode whole file, then slice last entry: ${tOpenStrings.toFixed(1)} ms  (${(tOpenStrings / tOpenBytes).toFixed(0)}x slower)`);
}
