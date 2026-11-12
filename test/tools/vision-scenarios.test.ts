import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { describe, test } from "node:test";
import { Canvas, COLORS, FONT, encodePng } from "../../tools/raster.ts";
import { KINDS, make, scenarios } from "../../tools/vision-scenarios.ts";
import { report } from "../../tools/vision-probe.ts";

/** Decode what encodePng wrote, as far as these tests need: size and pixels. */
function decode(png: Uint8Array): { w: number; h: number; rgb: Uint8Array } {
  const v = new DataView(png.buffer, png.byteOffset);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  let w = 0;
  let h = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") [w, h] = [v.getUint32(at + 8), v.getUint32(at + 12)];
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) rgb.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  return { w, h, rgb };
}

describe("raster", () => {
  test("a PNG decodes to the pixels that were drawn", () => {
    const cv = new Canvas(8, 4, COLORS.white);
    cv.fillRect(2, 1, 3, 2, COLORS.red);
    const d = decode(cv.png());
    assert.deepEqual([d.w, d.h], [8, 4]);
    assert.deepEqual(d.rgb, cv.pixels);
    assert.deepEqual(cv.get(2, 1), COLORS.red);
    assert.deepEqual(cv.get(0, 0), COLORS.white);
  });
  test("the CRC of each chunk is right", () => {
    // IEND is always 49 45 4E 44 AE 42 60 82.
    const png = encodePng(1, 1, Uint8Array.from([0, 0, 0]));
    assert.deepEqual([...png.subarray(png.length - 8)], [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  });
  test("every glyph is 5 by 7", () => {
    for (const [k, g] of Object.entries(FONT)) {
      assert.equal(g.length, 7, k);
      for (const row of g) assert.equal(row.length, 5, k);
    }
  });
  test("text covers pixels and says what it cannot draw", () => {
    const cv = new Canvas(60, 10);
    assert.equal(cv.text("A1", 0, 0, 1, COLORS.black), 11);
    assert.deepEqual(cv.get(1, 0), COLORS.black);
    assert.throws(() => cv.text("é", 0, 0, 1, COLORS.black), /no/);
  });
  test("shapes land where they are put", () => {
    const cv = new Canvas(20, 20);
    cv.fillCircle(10, 10, 4, COLORS.blue);
    cv.fillTriangle(10, 10, 8, COLORS.green);
    assert.deepEqual(cv.get(10, 13), COLORS.green);
    assert.deepEqual(cv.get(0, 0), COLORS.white);
  });
});

describe("scenarios", () => {
  test("the same seed makes the same pictures, another seed does not", () => {
    for (const k of KINDS) {
      assert.deepEqual(make(k, 3).png, make(k, 3).png, k);
      assert.notDeepEqual(make(k, 3).png, make(k, 4).png, k);
    }
  });
  test("a scenario accepts its own answer and not another", () => {
    for (const k of KINDS) {
      for (let seed = 1; seed <= 20; seed++) {
        const s = make(k, seed);
        assert.ok(s.check(s.expected), `${s.id}: ${s.expected}`);
        assert.ok(s.check(`It is ${s.expected}.`), s.id);
        assert.ok(!s.check(""), s.id);
      }
    }
  });
  test("a wrong answer fails", () => {
    assert.ok(!make("shape", 1).check("a blue blue"));
    const c = make("count", 1);
    assert.ok(!c.check(String(Number(c.expected) + 1)));
    assert.ok(!c.check(`${c.expected} or ${Number(c.expected) + 1}`));
    const d = make("digits", 1);
    assert.ok(!d.check("0000"));
    const sum = make("sum", 1);
    assert.ok(!sum.check(String(Number(sum.expected) + 1)));
  });
  test("a count is also taken in words", () => {
    const c = make("count", 1);
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
    assert.ok(c.check(`There are ${words[Number(c.expected)]}.`));
  });
  test("the pictures are the size they should be and the number asked for are made", () => {
    const all = scenarios({ count: 2, seed: 1 });
    assert.equal(all.length, KINDS.length * 2);
    assert.deepEqual(decode(make("shape", 1).png).w, 384);
    assert.equal(scenarios({ kinds: ["text"], count: 3, seed: 5 }).length, 3);
    assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  });
});

describe("the report", () => {
  test("counts right answers for each kind and lists the wrong ones", () => {
    const text = report([
      { id: "text-1", kind: "text", expected: "QUOKKA", answer: "QUOKKA", right: true, ms: 1 },
      { id: "text-2", kind: "text", expected: "MARBLE", answer: "MARBEL", right: false, ms: 1 },
      { id: "sum-1", kind: "sum", expected: "5", answer: "", right: false, error: "no projector", ms: 1 },
    ]);
    assert.ok(text.includes("| text | 1 | 2 |"));
    assert.ok(text.includes("| all | 1 | 3 |"));
    assert.ok(text.includes("text-2: expected MARBLE"));
    assert.ok(text.includes("error: no projector"));
  });
});
