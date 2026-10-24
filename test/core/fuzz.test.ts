import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ParseError, emitEntry, parseEntry, valueEquals } from "../../src/index.ts";
import { PIECES, Rng, randomEntry } from "../support/gen.ts";

const SEEDS = [1, 2, 3, 4, 5];
const PER_SEED = 4000;

describe("round-trip properties", () => {
  for (const seed of SEEDS) {
    test(`parse(emit(v)) equals v, seed ${seed}`, () => {
      const rng = new Rng(seed);
      for (let i = 0; i < PER_SEED; i++) {
        const e = randomEntry(rng, { blobs: true, tags: true });
        const t = emitEntry(e);
        const back = parseEntry(t);
        assert.ok(valueEquals(e, back), `round trip failed for entry ${i} of seed ${seed}:\n${t}`);
      }
    });

    test(`emit(parse(t)) equals t, seed ${seed}`, () => {
      const rng = new Rng(seed * 1000);
      for (let i = 0; i < PER_SEED; i++) {
        const t = emitEntry(randomEntry(rng, { blobs: true, tags: true }));
        assert.equal(emitEntry(parseEntry(t)), t);
      }
    });
  }

  test("the non-canonical fast path agrees with the checked path on canonical input", () => {
    const rng = new Rng(77);
    for (let i = 0; i < 3000; i++) {
      const t = emitEntry(randomEntry(rng, { blobs: true, tags: true }));
      assert.ok(valueEquals(parseEntry(t, { canonical: false }), parseEntry(t)));
    }
  });

  test("an entry never contains a column-0 '- ' after its first line, and ends with exactly one blank line", () => {
    const rng = new Rng(5150);
    for (let i = 0; i < 6000; i++) {
      const t = emitEntry(randomEntry(rng, { blobs: true, tags: true }));
      assert.ok(t.startsWith("- "));
      assert.ok(!t.includes("\n- "), `embedded entry start in:\n${t}`);
      assert.equal(t.indexOf("\n\n"), t.length - 2, `blank line before the end in:\n${t}`);
      assert.ok(!t.includes("\r"));
      assert.ok(!t.includes(String.fromCharCode(0xfeff)));
    }
  });
});

describe("hostile input never produces anything but ParseError", () => {
  const INSERTS = [" ", "\n", "\n\n", "-", "- ", ":", ": ", '"', "\\", "|", "!", "#", "\t", "\r", "{", "}", "[", "]", "&", "*", "0", "a", ...PIECES.slice(0, 20)];

  function mutate(rng: Rng, text: string): string {
    let s = text;
    const n = 1 + rng.int(3);
    for (let k = 0; k < n; k++) {
      const at = rng.int(s.length + 1);
      switch (rng.int(5)) {
        case 0: s = s.slice(0, at) + s.slice(at + 1); break; // delete
        case 1: s = s.slice(0, at) + rng.pick(INSERTS) + s.slice(at); break; // insert
        case 2: s = s.slice(0, at) + rng.pick(INSERTS) + s.slice(at + 1); break; // replace
        case 3: s = s.slice(0, at); break; // truncate
        default: { // swap neighbours
          if (at + 1 < s.length) s = s.slice(0, at) + s[at + 1] + s[at] + s.slice(at + 2);
        }
      }
    }
    return s;
  }

  test("mutated entries are rejected or are themselves canonical", () => {
    const rng = new Rng(424242);
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 25000; i++) {
      const base = emitEntry(randomEntry(rng, { blobs: true, tags: true }));
      const bad = mutate(rng, base);
      try {
        const v = parseEntry(bad);
        assert.equal(emitEntry(v), bad, "accepted text must be canonical");
        accepted++;
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        rejected++;
      }
    }
    assert.ok(rejected > 1000, `expected many rejections, got ${rejected}`);
    console.log(`  mutation fuzz: ${rejected} rejected, ${accepted} accepted (and canonical)`);
  });

  test("random printable noise is rejected cleanly", () => {
    const rng = new Rng(9);
    for (let i = 0; i < 5000; i++) {
      let s = "- ";
      const n = rng.int(60);
      for (let k = 0; k < n; k++) s += rng.pick(PIECES);
      s += "\n\n";
      try {
        parseEntry(s);
      } catch (e) {
        assert.ok(e instanceof ParseError, `unexpected ${e}`);
      }
    }
  });
});
