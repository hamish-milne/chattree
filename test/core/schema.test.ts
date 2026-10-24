import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BlobData,
  BlobRef,
  MemoryBlobStore,
  Pipeline,
  SchemaError,
  Tagged,
  canonicalText,
  defineEntry,
  emitEntry,
  externalizeLarge,
  findDropped,
  fromPlain,
  hashValue,
  mapStrings,
  objectToValue,
  parseEntry,
  redact,
  resolve,
  sha256Hex,
  sortKeysDeep,
  valueEquals,
  valueToObject,
  wellFormed,
  type Entry,
  type Transform,
  type Value,
} from "../../src/index.ts";
import { Rng, randomEntry } from "../support/gen.ts";
import { any, arr, bool, either, lit, num, obj, opt, schema, str } from "../support/mini.ts";

const H = "cd".repeat(32);
const m = (o: unknown) => fromPlain(o) as Map<string, Value>;

describe("plain-object bridge", () => {
  test("tags become $tag, tagged lists and strings become $value, blob refs become $tag blob", () => {
    const v = new Tagged(
      "user",
      new Map<string, Value>([
        ["id", "x"],
        ["parts", [new Tagged("text", m({ text: "hi" })), new Tagged("md", "# h"), new Tagged("l", [1, 2])]],
        ["data", new BlobRef(H, 3, "image/png")],
        ["plain", m({ a: 1 })],
      ]),
    );
    const o = valueToObject(v) as Record<string, unknown>;
    assert.deepEqual(o, {
      $tag: "user",
      id: "x",
      parts: [{ $tag: "text", text: "hi" }, { $tag: "md", $value: "# h" }, { $tag: "l", $value: [1, 2] }],
      data: { $tag: "blob", sha256: H, bytes: 3, mime: "image/png" },
      plain: { a: 1 },
    });
    assert.deepEqual(Object.keys(o).slice(0, 2), ["$tag", "id"], "$tag comes first");
    assert.ok(valueEquals(objectToValue(o), v));
  });

  test("round trip for random values, up to the key order JS objects cannot keep", () => {
    const rng = new Rng(8080);
    for (let i = 0; i < 3000; i++) {
      const e = randomEntry(rng, { tags: true, blobs: true });
      const back = objectToValue(valueToObject(e));
      assert.ok(valueEquals(sortKeysDeep(back), sortKeysDeep(e)), `entry ${i}`);
    }
  });

  test("keys named __proto__ are kept as data, not as prototypes", () => {
    const evil = new Map<string, Value>([["__proto__", m({ polluted: true })], ["ok", 1]]);
    const o = valueToObject(evil) as Record<string, unknown>;
    assert.deepEqual(Object.keys(o), ["__proto__", "ok"]);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.ok(valueEquals(objectToValue(o), evil));
  });

  test("undefined fields are skipped; binary becomes BlobData", () => {
    const v = objectToValue({ a: 1, b: undefined, c: new Uint8Array([1, 2]) }) as Map<string, Value>;
    assert.deepEqual([...v.keys()], ["a", "c"]);
    assert.ok(v.get("c") instanceof BlobData);
  });

  const bad: [string, () => unknown][] = [
    ["a map using a reserved key", () => valueToObject(m({ $tag: "x" }))],
    ["a map using $value", () => valueToObject(new Tagged("t", m({ $value: 1 })))],
    ["$value without $tag", () => objectToValue({ $value: 1 })],
    ["$value mixed with fields", () => objectToValue({ $tag: "t", $value: "x", other: 1 })],
    ["a non-string $tag", () => objectToValue({ $tag: 5 })],
    ["an invalid tag name", () => objectToValue({ $tag: "no good" })],
    ["the reserved tag blob with the wrong fields", () => objectToValue({ $tag: "blob", sha256: 1 })],
    ["a Date", () => objectToValue({ when: new Date() })],
    ["a function", () => objectToValue({ f: () => 1 })],
    ["undefined inside a list", () => objectToValue([1, undefined])],
    ["a tag around a number", () => objectToValue({ $tag: "t", $value: 5 })],
    ["unstored binary on the way out", () => valueToObject(new BlobData(new Uint8Array(1)))],
  ];
  for (const [name, fn] of bad) test(`rejects ${name}`, () => assert.throws(fn, SchemaError));

  test("findDropped lists fields a stripping validator would discard", () => {
    const input = { a: 1, extra: 2, nested: { keep: 1, drop: 2 }, list: [{ x: 1, y: 2 }], gone: undefined };
    const output = { a: 1, nested: { keep: 1 }, list: [{ x: 1 }] };
    assert.deepEqual(findDropped(input, output), ["extra", "nested.drop", "list[0].y"]);
  });
});

// A small entry vocabulary: note (text + optional tags) and event (count + payload of tagged parts).
const noteType = defineEntry("note", schema(obj({ $tag: lit("note"), id: str, text: either(str, obj({ $tag: lit("blob"), sha256: str, bytes: num, mime: opt(str) })), tags: opt(arr(str)) })));
const eventType = defineEntry(
  "event",
  schema(obj({
    $tag: lit("event"),
    id: str,
    ok: bool,
    parts: arr(either(obj({ $tag: lit("text"), text: str }), obj({ $tag: lit("data"), value: any }))),
  })),
);

describe("Pipeline", () => {
  const plain = new Pipeline({ types: [noteType, eventType] });

  test("encode then emit then parse then decode gives the input back", async () => {
    const input = { $tag: "event", id: "e1", ok: true, parts: [{ $tag: "text", text: "line one\nline two" }, { $tag: "data", value: { n: 1, list: [1, 2] } }] };
    const entry = await plain.encode(input);
    const text = emitEntry(entry);
    assert.ok(text.startsWith("- !event\n"));
    const r = await plain.decode(parseEntry(text));
    assert.ok(r.ok);
    assert.deepEqual(r.value, input);
  });

  test("field order in the file follows the schema, not the input", async () => {
    const entry = await plain.encode({ tags: ["x"], text: "t", id: "n1", $tag: "note" });
    assert.equal(emitEntry(entry), "- !note\n  id: n1\n  text: t\n  tags:\n  - x\n\n");
  });

  test("writes are strict: fields the schema would drop are an error, with paths", async () => {
    await assert.rejects(
      plain.encode({ $tag: "event", id: "e", ok: true, parts: [{ $tag: "text", text: "x", surprise: 1 }], extra: 1 }),
      (e) => e instanceof SchemaError && e.issues.map((i) => i.path).join() === "parts[0].surprise,extra",
    );
  });

  test("strict can be turned off, and then extras are dropped", async () => {
    const lax = new Pipeline({ types: [noteType], strict: false });
    const entry = await lax.encode({ $tag: "note", id: "n1", text: "t", extra: 1 });
    assert.equal(emitEntry(entry), "- !note\n  id: n1\n  text: t\n\n");
  });

  test("validation issues carry readable paths", async () => {
    await assert.rejects(
      plain.encode({ $tag: "event", id: "e", ok: "yes", parts: [{ $tag: "text", text: 5 }] }),
      (e) => e instanceof SchemaError && e.issues.some((i) => i.path === "ok") && /ok: expected boolean/.test(e.message),
    );
  });

  const refusals: [string, unknown][] = [
    ["no $tag", { id: "x" }],
    ["a non-string $tag", { $tag: 5 }],
    ["an unknown $tag", { $tag: "nope", id: "x" }],
    ["a non-object", "hello"],
    ["null", null],
  ];
  for (const [name, input] of refusals) test(`encode refuses ${name}`, async () => assert.rejects(plain.encode(input), SchemaError));

  test("a schema that loses the $tag is caught", async () => {
    const p = new Pipeline({ types: [defineEntry("loose", schema(obj({ id: str })))] });
    await assert.rejects(p.encode({ $tag: "loose", id: "x" }), /must keep the \$tag/);
  });

  test("duplicate entry types are a configuration error", () => {
    assert.throws(() => new Pipeline({ types: [noteType, noteType] }), /duplicate entry type/);
  });

  test("tags lists what is registered", () => assert.deepEqual(plain.tags, ["note", "event"]));

  describe("reading", () => {
    test("unknown tag: reported, raw preserved, rewritable byte for byte", async () => {
      const text = "- !from-the-future\n  id: x\n  shiny: !thing\n    a: 1\n\n";
      const entry = parseEntry(text);
      const r = await plain.decode(entry);
      assert.ok(!r.ok);
      assert.equal(r.reason, "unknown-tag");
      assert.equal(r.tag, "from-the-future");
      assert.equal(emitEntry(r.raw), text);
    });

    test("untagged entries are reported, not thrown", async () => {
      const r = await plain.decode(parseEntry("- id: x\n\n"));
      assert.ok(!r.ok && r.reason === "untagged");
    });

    test("an invalid entry in a file is reported with issue paths and its raw value", async () => {
      const entry = parseEntry("- !event\n  id: e\n  ok: maybe\n  parts: []\n\n");
      const r = await plain.decode(entry);
      assert.ok(!r.ok && r.reason === "invalid");
      assert.deepEqual(r.issues.map((i) => i.path), ["ok"]);
      assert.equal(r.raw, entry);
    });

    test("a reserved key in a stored map is reported as invalid, not thrown", async () => {
      const r = await plain.decode(parseEntry('- !note\n  id: n1\n  text: t\n  "$tag": sneaky\n\n'));
      assert.ok(!r.ok && r.reason === "invalid");
    });

    test("unknown fields from a newer minor version are ignored", async () => {
      const entry = parseEntry("- !note\n  id: n1\n  text: t\n  added_later: 1\n  nested_later: !whatever\n    x: 1\n\n");
      const r = await plain.decode(entry);
      assert.ok(r.ok);
      assert.deepEqual(r.value, { $tag: "note", id: "n1", text: "t" });
    });
  });

  describe("transforms", () => {
    test("redact then externalize: secrets never reach the blob store", async () => {
      const store = new MemoryBlobStore();
      const p = new Pipeline({
        types: [noteType],
        transforms: [redact([/sk-[A-Za-z0-9]{10,}/]), externalizeLarge(store, { threshold: 200 })],
      });
      const secret = "sk-ABCDEFGHIJKLMNOP";
      const entry = await p.encode({ $tag: "note", id: "n", text: `key=${secret} ` + "filler ".repeat(100) });
      const text = emitEntry(entry);
      assert.ok(!text.includes(secret));
      assert.ok(text.includes("!blob"));
      for (const bytes of store.blobs.values()) assert.ok(!new TextDecoder().decode(bytes).includes(secret));
      const r = await p.decode(parseEntry(text));
      assert.ok(r.ok);
      const resolved = (await resolve(parseEntry(text), store)) as Tagged & { value: Map<string, unknown> };
      assert.match(resolved.value.get("text") as string, /^key=\[REDACTED\] filler/);
    });

    test("redact handles several patterns, non-global regexes, and leaves keys alone", async () => {
      const t = redact([/aaa/, /b+/g], "#");
      const out = (await t(m({ aaa: "xaaaxaaa bbb", list: ["bb", 1], tagged: new Tagged("s", "aaa") }))) as Map<string, Value>;
      assert.equal(out.get("aaa"), "x#x# #");
      assert.deepEqual(out.get("list"), ["#", 1]);
      assert.ok(valueEquals(out.get("tagged") as Value, new Tagged("s", "#")));
    });

    test("wellFormed replaces lone surrogates, so the entry can be emitted", async () => {
      const lone = "x" + String.fromCharCode(0xd800) + "y";
      const p = new Pipeline({ types: [noteType], transforms: [wellFormed()] });
      const entry = await p.encode({ $tag: "note", id: "n", text: lone });
      assert.ok(emitEntry(entry).includes("x" + String.fromCharCode(0xfffd) + "y"));
    });

    test("mapStrings leaves blob references, numbers and structure alone", async () => {
      const t = mapStrings((s) => s.toUpperCase());
      const input = m({ a: "x", b: new BlobRef(H, 1), c: 2, d: [null, true] });
      const out = (await t(input)) as Map<string, Value>;
      assert.equal(out.get("a"), "X");
      assert.ok(valueEquals(out.get("b") as Value, new BlobRef(H, 1)));
    });

    test("verify catches a transform that breaks the entry; verify:false lets it through", async () => {
      const breaker: Transform = (v) => {
        const body = (v as Tagged).value as Map<string, Value>;
        return new Tagged("note", new Map<string, Value>([...body, ["text", 42]]));
      };
      await assert.rejects(new Pipeline({ types: [noteType], transforms: [breaker] }).encode({ $tag: "note", id: "n", text: "t" }), /no longer valid after transforms/);
      const p = new Pipeline({ types: [noteType], transforms: [breaker], verify: false });
      assert.ok(emitEntry(await p.encode({ $tag: "note", id: "n", text: "t" })).includes("text: 42"));
    });

    test("a transform may not turn the entry into something else", async () => {
      const p = new Pipeline({ types: [noteType], transforms: [() => "oops"] });
      await assert.rejects(p.encode({ $tag: "note", id: "n", text: "t" }), SchemaError);
    });

    test("transforms run in the order given", async () => {
      const log: string[] = [];
      const mark = (name: string): Transform => (v) => (log.push(name), v);
      await new Pipeline({ types: [noteType], transforms: [mark("a"), mark("b"), mark("c")] }).encode({ $tag: "note", id: "n", text: "t" });
      assert.deepEqual(log, ["a", "b", "c"]);
    });
  });
});

describe("hashing", () => {
  test("independent of map key order, sensitive to values and list order", async () => {
    const a = m({ x: 1, y: { p: [1, 2], q: "s" } });
    const b = m({ y: { q: "s", p: [1, 2] }, x: 1 });
    assert.equal(await hashValue(a), await hashValue(b));
    assert.notEqual(await hashValue(a), await hashValue(m({ x: 2, y: { p: [1, 2], q: "s" } })));
    assert.notEqual(await hashValue(a), await hashValue(m({ x: 1, y: { p: [2, 1], q: "s" } })));
  });

  test("tags are part of the data", async () => {
    assert.notEqual(await hashValue(new Tagged("a", m({ k: 1 }))), await hashValue(new Tagged("b", m({ k: 1 }))));
    assert.notEqual(await hashValue(new Tagged("a", m({ k: 1 }))), await hashValue(m({ k: 1 })));
  });

  test("canonical text is the entry format with sorted keys, and the hash is its SHA-256", async () => {
    const v = m({ b: 2, a: [m({ z: 1, q: 2 })] });
    assert.equal(canonicalText(v), "- value:\n    a:\n    - q: 2\n      z: 1\n    b: 2\n\n");
    assert.equal(await hashValue(v), await sha256Hex(new TextEncoder().encode(canonicalText(v))));
  });

  test("sortKeysDeep sorts by code unit and does not modify its input", () => {
    const v = m({ b: 1, B: 2, a: 3 });
    assert.deepEqual([...(sortKeysDeep(v) as Map<string, Value>).keys()], ["B", "a", "b"]);
    assert.deepEqual([...v.keys()], ["b", "B", "a"]);
  });
});

// keep the generic helpers referenced so a failing import is a loud type error rather than silently unused
void [bool, num, opt, any] as unknown as Entry[];
