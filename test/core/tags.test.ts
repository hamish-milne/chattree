import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BlobRef,
  EmitError,
  MemoryBlobStore,
  ParseError,
  Tagged,
  encodeEntry,
  emitEntry,
  externalize,
  fromPlain,
  parseEntry,
  parseFile,
  peekTag,
  resolve,
  scan,
  valueEquals,
  type Entry,
  type Value,
} from "../../src/index.ts";
import { Rng, randomEntry } from "../support/gen.ts";

const m = (o: unknown) => fromPlain(o) as Map<string, Value>;
const H = "ab".repeat(32);

describe("tag layout", () => {
  test("every position, exactly", () => {
    const e = new Tagged(
      "user",
      new Map<string, Value>([
        ["id", "x"],
        ["content", [new Tagged("text", m({ text: "hi" })), new Tagged("attachment", new Map<string, Value>([["data", new BlobRef(H, 1)]]))]],
        ["note", new Tagged("n", "plain")],
        ["body", new Tagged("md", "a\nb")],
        ["empty", new Tagged("e", new Map())],
        ["items", new Tagged("list", [1, "a"])],
        ["nested", [new Tagged("md", "p\nq\n"), new Tagged("s", "word"), new Tagged("l", [new Tagged("t", m({ k: 1 }))]), new Tagged("z", [])]],
      ]),
    ) as Entry;
    const expected =
      "- !user\n" +
      "  id: x\n" +
      "  content:\n" +
      "  - !text\n" +
      "    text: hi\n" +
      "  - !attachment\n" +
      `    data: !blob {sha256: "${H}", bytes: 1}\n` +
      "  note: !n plain\n" +
      "  body: !md |-\n" +
      "    a\n" +
      "    b\n" +
      "  empty: !e {}\n" +
      "  items: !list\n" +
      "  - 1\n" +
      "  - a\n" +
      "  nested:\n" +
      "  - !md |\n" +
      "    p\n" +
      "    q\n" +
      "  - !s word\n" +
      "  - !l\n" +
      "    - !t\n" +
      "      k: 1\n" +
      "  - !z []\n" +
      "\n";
    assert.equal(emitEntry(e), expected);
    assert.ok(valueEquals(parseEntry(expected), e));
  });

  test("empty tagged entry and untagged entries coexist", () => {
    assert.equal(emitEntry(new Tagged("header", new Map()) as Entry), "- !header {}\n\n");
    assert.ok(valueEquals(parseEntry("- !header {}\n\n"), new Tagged("header", new Map())));
    assert.equal(emitEntry(m({ a: 1 })), "- a: 1\n\n");
  });

  test("tag names with namespace punctuation", () => {
    for (const tag of ["a", "A1", "x-vendor/thing", "a.b", "e5", "ns/sub.type-2"]) {
      const e = new Tagged(tag, m({ k: "v" })) as Entry;
      assert.ok(emitEntry(e).startsWith(`- !${tag}\n`));
      assert.ok(valueEquals(parseEntry(emitEntry(e)), e));
    }
  });

  test("unknown tags survive a read and rewrite byte for byte", () => {
    const text = "- !from-the-future\n  id: x\n  shiny: !new-thing\n    a: 1\n  list:\n  - !other z\n\n";
    assert.equal(emitEntry(parseEntry(text)), text);
  });
});

describe("tags the emitter refuses", () => {
  const bad: [string, () => unknown][] = [
    ["reserved name blob", () => new Tagged("blob", new Map())],
    ["empty name", () => new Tagged("", new Map())],
    ["name starting with a digit", () => new Tagged("1a", new Map())],
    ["name with a space", () => new Tagged("a b", new Map())],
    ["name with a bang", () => new Tagged("a!b", new Map())],
    ["name that is too long", () => new Tagged("a".repeat(200), new Map())],
    ["wrapping a number", () => new Tagged("t", 5)],
    ["wrapping null", () => new Tagged("t", null)],
    ["wrapping a boolean", () => new Tagged("t", true)],
    ["wrapping a blob reference", () => new Tagged("t", new BlobRef(H, 1))],
    ["wrapping another tag", () => new Tagged("t", new Tagged("u", "x"))],
    ["a tagged entry wrapping a list", () => emitEntry(new Tagged("t", ["x"]) as Entry)],
    ["a tagged entry wrapping a string", () => emitEntry(new Tagged("t", "x") as Entry)],
  ];
  for (const [name, fn] of bad) test(name, () => assert.throws(fn, EmitError));
});

describe("the parser rejects malformed tags", () => {
  const rejected: [string, string][] = [
    ["tag with no body", "- !user\n\n"],
    ["tag on an entry followed by an inline value", "- !user {x: 1}\n\n"],
    ["entry body indented too far", "- !user\n    id: x\n\n"],
    ["entry body not indented", "- !user\nid: x\n\n"],
    ["tag on a number", "- a: !t 5\n\n"],
    ["tag on null", "- a: !t null\n\n"],
    ["tag on a boolean", "- a: !t true\n\n"],
    ["tag on a blob reference", `- a: !t !blob {sha256: "${H}", bytes: 1}\n\n`],
    ["reserved name used as a plain tag", "- a: !blob\n    x: 1\n\n"],
    ["nested tags", "- a: !t !u x\n\n"],
    ["tag with nothing after it", "- a: !t\n\n"],
    ["malformed tag name", "- a: !1bad x\n\n"],
    ["bare bang", "- a: ! x\n\n"],
    ["tab after the tag", "- a: !t\tx\n\n"],
    ["two spaces after the tag", "- a: !t  x\n\n"],
    ["tag followed by a key on the same line (list item)", "- a:\n  - !t k: v\n\n"],
    ["quoted string that would be bare", '- a: !t "b"\n\n'],
    ["over-long tag name", `- a: !${"x".repeat(200)} y\n\n`],
    ["YAML standard tag", "- a: !!str x\n\n"],
    ["tagged list under a tagged key with wrong indentation", "- a: !l\n    - 1\n\n"],
  ];
  for (const [name, text] of rejected) test(name, () => assert.throws(() => parseEntry(text), ParseError));
});

describe("peekTag reads the tag from raw bytes", () => {
  test("matches the parsed tag for every entry of a random file", () => {
    const rng = new Rng(31337);
    const entries = Array.from({ length: 400 }, () => randomEntry(rng, { tags: true }));
    const parts = entries.map(encodeEntry);
    const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      file.set(p, at);
      at += p.length;
    }
    const { spans } = scan(file);
    assert.equal(spans.length, entries.length);
    let tagged = 0;
    spans.forEach((span, i) => {
      const e = entries[i] as Entry;
      assert.equal(peekTag(file, span), e instanceof Map ? undefined : e.tag, `entry ${i}`);
      if (!(e instanceof Map)) tagged++;
    });
    assert.ok(tagged > 100 && tagged < 400, "expected a mix of tagged and untagged entries");
    parseFile(file); // and the whole file still parses
  });

  test("an entry whose first key is quoted is not mistaken for a tagged one", () => {
    const e = new Map<string, Value>([["!user", 1]]);
    const bytes = encodeEntry(e);
    assert.equal(peekTag(bytes, { start: 0, end: bytes.length }), undefined);
  });
});

describe("blobs and tags", () => {
  test("oversized values inside tagged maps and lists are externalized; a directly tagged string stays inline", async () => {
    const store = new MemoryBlobStore();
    const big = "x".repeat(6000);
    const e = new Tagged(
      "tool_result",
      new Map<string, Value>([
        ["content", big],
        ["parts", [new Tagged("text", m({ text: big })), new Tagged("raw", big)]],
      ]),
    ) as Entry;
    const out = (await externalize(e, store)) as Tagged & { value: Map<string, Value> };
    assert.equal(out.tag, "tool_result");
    assert.ok(out.value.get("content") instanceof BlobRef);
    const parts = out.value.get("parts") as Tagged[];
    assert.ok(((parts[0] as Tagged).value as Map<string, Value>).get("text") instanceof BlobRef);
    assert.equal((parts[1] as Tagged).value, big, "a tag cannot wrap a blob reference, so a tagged string stays inline");
    assert.equal(store.blobs.size, 1);
    const back = (await resolve(parseEntry(emitEntry(out)), store)) as Tagged & { value: Map<string, unknown> };
    assert.equal(back.value.get("content"), big);
  });
});
