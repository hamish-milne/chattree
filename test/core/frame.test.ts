import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FrameError,
  ParseError,
  appendEntry,
  decodeStrict,
  encodeEntry,
  endsCleanly,
  fromPlain,
  lastCompleteSpan,
  parseFile,
  scan,
  valueEquals,
  type Entry,
  type Value,
} from "../../src/index.ts";
import { Rng, cp, randomEntry } from "../support/gen.ts";

const cat = (...xs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of xs) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};
const bytesOf = (s: string) => new TextEncoder().encode(s);

/** A deterministic set of small entries, with non-ASCII content so some cuts land mid-character. */
function smallEntries(seed: number, count: number): Entry[] {
  const rng = new Rng(seed);
  const out: Entry[] = [];
  while (out.length < count) {
    const e = randomEntry(rng, { tags: true });
    const body = e instanceof Map ? e : e.value;
    if (body.size > 0 && encodeEntry(e).length < 700) out.push(e);
  }
  out.push(fromPlain({ id: "x", text: cp(0x65e5, 0x672c, 0x8a9e, 0x1f600) + "\n" + cp(0xe9) + "\n- not an entry\n" }) as Map<string, Value>);
  return out;
}

describe("framing a complete file", () => {
  test("spans are contiguous and parse back to the originals", () => {
    const entries = smallEntries(1, 40);
    const encoded = entries.map(encodeEntry);
    const file = cat(...encoded);
    const r = scan(file);
    assert.equal(r.truncated, false);
    assert.equal(r.validLength, file.length);
    let at = 0;
    r.spans.forEach((s, i) => {
      assert.equal(s.start, at);
      assert.equal(s.end - s.start, (encoded[i] as Uint8Array).length);
      at = s.end;
    });
    const parsed = parseFile(file);
    assert.equal(parsed.entries.length, entries.length);
    parsed.entries.forEach((e, i) => assert.ok(valueEquals(e, entries[i] as Value)));
  });

  test("an empty file is valid and empty", () => {
    assert.deepEqual(scan(new Uint8Array(0)), { spans: [], validLength: 0, truncated: false });
    assert.equal(lastCompleteSpan(new Uint8Array(0)), undefined);
  });

  test("text that looks like entry markers inside values cannot confuse framing", () => {
    const tricky = [
      fromPlain({ a: "x\n- y\n\n- z\n" }),
      fromPlain({ a: ["- b\n- c", "\n- d"], "- k": "- v" }),
      fromPlain({ a: "line\n\n\n- not a start\n  - nested" }),
    ] as Map<string, Value>[];
    const file = cat(...tricky.map(encodeEntry));
    const parsed = parseFile(file);
    assert.equal(parsed.entries.length, 3);
    parsed.entries.forEach((e, i) => assert.ok(valueEquals(e, tricky[i] as Value)));
  });
});

describe("truncation", () => {
  const entries = smallEntries(2, 11);
  const encoded = entries.map(encodeEntry);
  const file = cat(...encoded);
  const ends: number[] = [];
  encoded.reduce((n, x) => (ends.push(n + x.length), n + x.length), 0);

  test(`every one of the ${file.length + 1} possible cut points is detected exactly`, () => {
    let midCharacterCuts = 0;
    for (let c = 0; c <= file.length; c++) {
      const prefix = file.subarray(0, c);
      const expectedValid = ends.filter((e) => e <= c).at(-1) ?? 0;
      const r = scan(prefix);
      assert.equal(r.validLength, expectedValid, `validLength at cut ${c}`);
      assert.equal(r.truncated, c !== expectedValid, `truncated flag at cut ${c}`);
      assert.equal(r.spans.length, ends.filter((e) => e <= c).length, `entry count at cut ${c}`);
      // lastCompleteSpan agrees with the full scan
      const last = lastCompleteSpan(prefix);
      assert.deepEqual(last, r.spans.at(-1), `lastCompleteSpan at cut ${c}`);
      // The incomplete tail may end inside a multi-byte character; it must never be decoded.
      if (c !== expectedValid && (prefix[c - 1] ?? 0) >= 0x80) midCharacterCuts++;
    }
    assert.ok(midCharacterCuts > 0, "expected some cuts inside multi-byte characters");
  });

  test("parseFile returns the intact entries and ignores a tail cut inside a multi-byte character", () => {
    // cut the final entry in the middle of its 4-byte emoji (lead byte 0xF0)
    const lead = file.indexOf(0xf0, ends.at(-2));
    assert.ok(lead > 0);
    const cut = file.subarray(0, lead + 2);
    const r = parseFile(cut);
    assert.equal(r.truncated, true);
    assert.equal(r.entries.length, entries.length - 1);
    assert.throws(() => decodeStrict(cut.subarray(r.validLength)), ParseError, "decoding the raw tail would have failed");
  });

  test("repairing the tail (truncating to validLength) allows appending again", () => {
    const damaged = file.subarray(0, file.length - 10);
    const { validLength } = scan(damaged);
    const extra = fromPlain({ id: "after-crash", type: "user" }) as Map<string, Value>;
    const repaired = cat(damaged.subarray(0, validLength), encodeEntry(extra));
    const r = parseFile(repaired);
    assert.equal(r.truncated, false);
    assert.equal(r.entries.length, entries.length);
    assert.ok(valueEquals(r.entries.at(-1) as Value, extra));
  });

  test("appendEntry refuses every damaged tail and accepts every clean end", () => {
    const extra = fromPlain({ id: "next", type: "user", content: "hello" }) as Map<string, Value>;
    let refused = 0;
    for (let c = 0; c <= file.length; c++) {
      const prefix = file.subarray(0, c);
      const clean = c === 0 || ends.includes(c);
      assert.equal(endsCleanly(prefix), clean, `endsCleanly at cut ${c}`);
      if (clean) {
        assert.equal(parseFile(appendEntry(prefix, extra)).entries.length, ends.filter((e) => e <= c).length + 1);
      } else {
        assert.throws(() => appendEntry(prefix, extra), FrameError, `cut ${c}`);
        refused++;
      }
    }
    assert.ok(refused > 1000);
  });

  test("raw concatenation onto a damaged tail is usually caught by scanning, and appendEntry covers the rest", () => {
    // A blind append can occasionally graft the new entry onto the broken one and yield text that is
    // valid and canonical (e.g. a cut right after a line's indentation, then "- id: ..." continues it as a
    // nested sequence item). Nothing in the bytes distinguishes that from a real entry, so the guarantee is
    // that appendEntry never allows it, not that every blind append is detectable.
    const extra = encodeEntry(fromPlain({ id: "next", type: "user", content: "hello" }) as Map<string, Value>);
    let caught = 0;
    const graftedCuts: number[] = [];
    for (let c = 1; c < file.length; c++) {
      if (ends.includes(c)) continue;
      try {
        parseFile(cat(file.subarray(0, c), extra));
        graftedCuts.push(c);
      } catch (e) {
        assert.ok(e instanceof FrameError || e instanceof ParseError);
        caught++;
      }
    }
    assert.ok(caught > 1000);
    for (const c of graftedCuts) {
      assert.equal(endsCleanly(file.subarray(0, c)), false, `cut ${c}: a graft that scanning missed must be refused by the tail check`);
    }
    console.log(`  blind appends: ${caught} caught by scanning, ${graftedCuts.length} grafted silently (all refused by appendEntry)`);
  });
});

describe("rejecting damaged or foreign files", () => {
  const good = encodeEntry(fromPlain({ id: "a", text: "x" }) as Map<string, Value>);

  test("byte order mark", () => assert.throws(() => scan(cat(Uint8Array.of(0xef, 0xbb, 0xbf), good)), FrameError));
  test("does not start with an entry", () => assert.throws(() => scan(bytesOf("hello\n\n")), FrameError));
  test("starts with a document marker", () => assert.throws(() => scan(cat(bytesOf("---\n"), good)), FrameError));
  test("a non-final entry lacking its terminator", () => {
    const broken = cat(bytesOf("- id: a\n  text: x\n"), good);
    assert.throws(() => scan(broken), FrameError);
  });
  test("invalid UTF-8 inside a complete entry", () => {
    const e = encodeEntry(fromPlain({ id: "a", text: "abc" }) as Map<string, Value>);
    const at = e.indexOf(0x62); // the 'b' in "abc"... or elsewhere; replace one ASCII byte with an invalid lead byte
    const bad = e.slice();
    bad[at] = 0xff;
    assert.throws(() => parseFile(bad), ParseError);
  });
  test("overlong or truncated UTF-8 sequences inside a complete entry", () => {
    const e = encodeEntry(fromPlain({ id: "a", text: "abc" }) as Map<string, Value>);
    const at = e.indexOf(0x62);
    for (const seq of [[0xc0, 0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      const bad = cat(e.subarray(0, at), Uint8Array.from(seq), e.subarray(at + 1));
      assert.throws(() => parseFile(bad), ParseError);
    }
  });
  test("carriage returns (damage, not a repairable truncation)", () => {
    const bad = bytesOf("- id: a\r\n  text: x\r\n\r\n");
    assert.throws(() => parseFile(bad), FrameError);
  });
  test("garbage after a complete entry is damage, not a truncated tail to discard", () => {
    assert.throws(() => scan(cat(good, bytesOf("garbage"))), FrameError);
  });
  test("a control byte in the tail is damage", () => {
    assert.throws(() => scan(cat(good, bytesOf("- id: b\n  text: x"), Uint8Array.of(0))), FrameError);
  });
  test("a plausible partial write is still a truncation", () => {
    const r = scan(cat(good, bytesOf("- id: b\n  text: x")));
    assert.equal(r.truncated, true);
    assert.equal(r.validLength, good.length);
  });
  test("a raw byte order mark character inside an entry", () => {
    const bad = bytesOf('- id: a\n  text: "' + cp(0xfeff) + '"\n\n');
    assert.throws(() => parseFile(bad), ParseError);
  });
  test("a non-canonical but otherwise valid entry", () => {
    assert.throws(() => parseFile(bytesOf('- id: "a"\n\n')), ParseError);
  });
});
