import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BlobData, BlobRef, EmitError, ParseError, emitEntry, fromPlain, parseEntry, valueEquals, type Entry, type Value } from "../../src/index.ts";
import { cp } from "../support/gen.ts";

const entry = (o: unknown) => fromPlain(o) as Map<string, Value>;
const asMap = (e: Entry) => e as Map<string, Value>;

describe("canonical output", () => {
  test("matches the documented layout exactly", () => {
    const e = entry({
      id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D",
      type: "user",
      content: [{ text: "Fix the test\n\nIt fails:\n  expected a\n" }],
    });
    const expected =
      '- id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D"\n' +
      "  type: user\n" +
      "  content:\n" +
      "  - text: |\n" +
      "      Fix the test\n" +
      "      \n" + // empty line inside a block scalar is indent-filled, never truly empty
      "      It fails:\n" +
      "        expected a\n" +
      "\n";
    assert.equal(emitEntry(e), expected);
    assert.ok(valueEquals(parseEntry(expected), e));
  });

  test("empty entry, empty containers, null and booleans", () => {
    assert.equal(emitEntry(new Map()), "- {}\n\n");
    assert.equal(emitEntry(entry({ a: [], b: {}, c: null, d: true, e: false })), "- a: []\n  b: {}\n  c: null\n  d: true\n  e: false\n\n");
  });

  test("nested sequences and sequences of sequences", () => {
    const e = entry({ m: [[1, 2], [], [[3]], { k: [4] }] });
    const t = emitEntry(e);
    assert.equal(t, "- m:\n  -\n    - 1\n    - 2\n  - []\n  -\n    -\n      - 3\n  - k:\n    - 4\n\n");
    assert.ok(valueEquals(parseEntry(t), e));
  });

  test("the terminator is the only truly empty line", () => {
    const e = entry({ a: "x\n\ny\n \nz", b: ["p\n\nq"] });
    const t = emitEntry(e);
    assert.equal(t.indexOf("\n\n"), t.length - 2);
  });

  test("insertion order is preserved, including integer-like keys", () => {
    const m = new Map<string, Value>([["10", 1], ["2", 2], ["b", 3], ["a", 4]]);
    const t = emitEntry(m);
    assert.deepEqual([...asMap(parseEntry(t)).keys()], ["10", "2", "b", "a"]);
  });
});

describe("string forms", () => {
  const form = (s: string) => emitEntry(entry({ k: s }));
  const cases: [string, string][] = [
    ["hello", "- k: hello\n\n"],
    ["claude-sonnet-5-5", "- k: claude-sonnet-5-5\n\n"],
    ["", '- k: ""\n\n'],
    ["true", '- k: "true"\n\n'],
    ["Yes", '- k: "Yes"\n\n'],
    ["NULL", '- k: "NULL"\n\n'],
    ["y", '- k: "y"\n\n'],
    ["123", '- k: "123"\n\n'],
    ["01K8ZQ3M", '- k: "01K8ZQ3M"\n\n'],
    ["a b", '- k: "a b"\n\n'],
    ["a:b", '- k: "a:b"\n\n'],
    ["a\nb", "- k: |-\n    a\n    b\n\n"],
    ["a\nb\n", "- k: |\n    a\n    b\n\n"],
    ["a\n\n", '- k: "a\\n\\n"\n\n'], // would need keep-chomping
    ["\na", '- k: "\\na"\n\n'], // empty first line
    [" a\nb", '- k: " a\\nb"\n\n'], // leading space on first line
    ["a\r\nb", '- k: "a\\r\\nb"\n\n'],
    ["a\u001bb\nc", '- k: "a\\u001bb\\nc"\n\n'],
    ["tab\there", '- k: "tab\\there"\n\n'],
    [cp(0x2028), '- k: "\\u2028"\n\n'],
    [cp(0xfeff), '- k: "\\ufeff"\n\n'],
    [cp(0x85), '- k: "\\u0085"\n\n'],
    ["q\"uote\\", '- k: "q\\"uote\\\\"\n\n'],
    [cp(0x1f600), "- k: " + '"' + cp(0x1f600) + '"' + "\n\n"], // astral characters stay raw
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      assert.equal(form(input), expected);
      assert.equal(asMap(parseEntry(expected)).get("k"), input);
    });
  }

  test("keys: bare when safe, quoted otherwise", () => {
    const t = emitEntry(new Map<string, Value>([["a.b-c", 1], ["on", 2], ["", 3], ["a b", 4], ["-n", 5], ["1", 6]]));
    assert.equal(t, '- a.b-c: 1\n  "on": 2\n  "": 3\n  "a b": 4\n  "-n": 5\n  "1": 6\n\n');
    assert.deepEqual([...asMap(parseEntry(t)).keys()], ["a.b-c", "on", "", "a b", "-n", "1"]);
  });

  test("numbers", () => {
    const e = entry({ a: 0, b: -5, c: 0.5, d: 1e21, e: 1.5e-7, f: 9007199254740991 });
    const t = emitEntry(e);
    assert.equal(t, "- a: 0\n  b: -5\n  c: 0.5\n  d: 1e+21\n  e: 1.5e-7\n  f: 9007199254740991\n\n");
    assert.ok(valueEquals(parseEntry(t), e));
  });

  test("blob references", () => {
    const h = "ab".repeat(32);
    const e = entry({ a: new BlobRef(h, 42, "text/plain"), b: [new BlobRef(h, 0)] });
    const t = emitEntry(e);
    assert.equal(t, `- a: !blob {sha256: "${h}", bytes: 42, mime: "text/plain"}\n  b:\n  - !blob {sha256: "${h}", bytes: 0}\n\n`);
    assert.ok(valueEquals(parseEntry(t), e));
  });
});

describe("unrepresentable values are rejected by the emitter", () => {
  const bad: [string, () => unknown][] = [
    ["lone high surrogate", () => emitEntry(entry({ a: "x" + String.fromCharCode(0xd800) }))],
    ["lone low surrogate in key", () => emitEntry(new Map<string, Value>([[String.fromCharCode(0xdc00), 1]]))],
    ["NaN", () => emitEntry(entry({ a: NaN }))],
    ["Infinity", () => emitEntry(entry({ a: Infinity }))],
    ["negative zero", () => emitEntry(entry({ a: -0 }))],
    ["unstored BlobData", () => emitEntry(entry({ a: new BlobData(new Uint8Array(3)) }))],
    ["non-Map entry", () => emitEntry([] as unknown as Map<string, Value>)],
    ["nesting beyond the limit", () => emitEntry(entry({ a: nest(70) }))],
    ["key beyond the limit", () => emitEntry(new Map<string, Value>([["k".repeat(5000), 1]]))],
  ];
  for (const [name, fn] of bad) test(name, () => assert.throws(fn, EmitError));

  test("nesting right at the limit round-trips", () => {
    const e = entry({ a: nest(30) });
    assert.ok(valueEquals(parseEntry(emitEntry(e)), e));
  });
});

function nest(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? { k: v } : [v];
  return v;
}

describe("the parser accepts only canonical text", () => {
  const rejected: [string, string][] = [
    ["quoted string that would be bare", '- a: "b"\n\n'],
    ["two spaces after colon", "- a:  b\n\n"],
    ["trailing space", "- a: b \n\n"],
    ["two spaces after dash", "-  a: b\n\n"],
    ["missing terminator", "- a: b\n"],
    ["extra trailing blank line", "- a: b\n\n\n"],
    ["CRLF line endings", "- a: b\r\n\r\n"],
    ["tab indentation", "- a:\n\tb: 1\n\n"],
    ["duplicate keys", "- a: 1\n  a: 2\n\n"],
    ["unknown escape", '- a: "\\x41"\n\n'],
    ["uppercase hex in escape", '- a: "\\u00E9"\n\n'],
    ["escaped surrogate pair", '- a: "\\ud83d\\ude00"\n\n'],
    ["lone surrogate escape", '- a: "\\ud800"\n\n'],
    ["raw control character in quotes", '- a: "x\u0001y"\n\n'],
    ["leading-zero integer", "- a: 007\n\n"],
    ["float with trailing zero", "- a: 1.0\n\n"],
    ["uppercase exponent", "- a: 1E5\n\n"],
    ["negative zero", "- a: -0\n\n"],
    ["overflowing exponent", "- a: 1e999\n\n"],
    ["unsafe integer", "- a: 12345678901234567890\n\n"],
    ["YAML 1.1 boolean", "- a: yes\n\n"],
    ["tilde null", "- a: ~\n\n"],
    ["single-quoted string", "- a: 'b'\n\n"],
    ["flow mapping", "- a: {b: 1}\n\n"],
    ["flow sequence", "- a: [1, 2]\n\n"],
    ["anchor", "- a: &x 1\n\n"],
    ["alias", "- a: *x\n\n"],
    ["other tag", "- a: !!str 1\n\n"],
    ["malformed blob", '- a: !blob {sha256: "zz", bytes: 1}\n\n'],
    ["keep-chomped block scalar", "- a: |+\n    x\n\n\n"],
    ["folded block scalar", "- a: >\n    x\n\n"],
    ["block scalar with indentation indicator", "- a: |2\n    x\n\n"],
    ["empty block scalar", "- a: |\n\n"],
    ["block scalar whose first line starts with a space", "- a: |-\n     x\n    y\n\n"],
    ["comment", "- a: 1 # note\n\n"],
    ["document marker", "---\n- a: 1\n\n"],
    ["scalar entry", "- 5\n\n"],
    ["key without value or block", "- a:\n\n"],
    ["wrong nested indentation", "- a:\n   b: 1\n\n"],
    ["sequence indented too deep", "- a:\n    - 1\n\n"],
    ["empty block sequence marker", "- a:\n  -\n\n"],
    ["text after quoted string", '- a: "x" y\n\n'],
    ["unterminated string", '- a: "x\n\n'],
    ["indent-only line not following a block", "- a: 1\n  \n\n"],
    ["empty text", ""],
    ["only a terminator", "\n\n"],
  ];
  for (const [name, text] of rejected) test(name, () => assert.throws(() => parseEntry(text), ParseError));

  test("non-canonical but structurally valid text is accepted when canonical=false", () => {
    const e = parseEntry('- a: "b"\n\n', { canonical: false });
    assert.equal(asMap(e).get("a"), "b");
  });

  test("excessive nesting is a ParseError, not a stack overflow", () => {
    let t = "- a:\n";
    for (let i = 1; i < 500; i++) t += " ".repeat(2 * i) + "a:\n";
    t += " ".repeat(1000) + "a: 1\n\n";
    assert.throws(() => parseEntry(t), ParseError);
  });
});
