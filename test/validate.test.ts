import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { Type } from "typebox";
import { Settings } from "typebox/system";
import {
  accelerated,
  parse,
  safeParse,
  record,
  rules,
  said,
  section,
  strictObject,
  withDefault,
  ValidationError,
} from "../src/validate.ts";

const modes = [true, false] as const;

for (const accel of modes) {
  describe(`validation (${accel ? "generated checks" : "interpreted checks"})`, () => {
    before(() => Settings.Set({ useAcceleration: accel }));
    const Spec = Type.Union([
      Type.Codec(Type.Enum(["a", "b"]))
        .Decode((type) => ({ type }))
        .Encode((s) => s.type),
      strictObject({ type: Type.Enum(["a", "b"]), n: Type.Optional(Type.Integer({ minimum: 0 })) }),
    ]);
    const Entry = rules(
      strictObject({
        rev: withDefault(Type.String(), "main"),
        x: Type.Optional(Type.Integer()),
        y: Type.Optional(Type.Integer()),
        hash: Type.Optional(
          Type.Codec(said("64 hex digits", Type.String({ pattern: "^[0-9a-fA-F]{4}$" })))
            .Decode((s) => s.toLowerCase())
            .Encode((s) => s),
        ),
        spec: Type.Optional(Spec),
        tags: Type.Optional(Type.Array(strictObject({ k: withDefault(Type.String(), "dflt") }))),
      }),
      [(v) => ((v.x === undefined) === (v.y === undefined) ? "give x or y, not both and not neither" : undefined)],
    );
    const Root = strictObject({
      version: withDefault(Type.Literal(1), 1),
      sub: section({ a: withDefault(Type.Integer(), 3) }),
      items: withDefault(record(said("lower case letters", Type.String({ pattern: "^[a-z]+$" })), Entry), {}),
    });
    const bad = (v: unknown): string[] => {
      const r = safeParse(Root, v);
      assert.equal(r.ok, false);
      return r.ok ? [] : r.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };

    test("is generated or interpreted as asked", () => {
      parse(Root, {});
      assert.equal(accelerated(Root), accel);
    });

    test("fills defaults, at the root, in objects, in record values and in arrays", () => {
      assert.deepEqual(parse(Root, {}), { version: 1, sub: { a: 3 }, items: {} });
      const v = parse(Root, { items: { k: { x: 1, tags: [{}, { k: "z" }] } } });
      assert.deepEqual(v.items["k"], { rev: "main", x: 1, tags: [{ k: "dflt" }, { k: "z" }] });
    });

    test("does not change what it is given", () => {
      const input = { items: { k: { x: 1 } } };
      parse(Root, input);
      assert.deepEqual(input, { items: { k: { x: 1 } } });
    });

    test("runs codecs after the check: a lower-cased hash, a bare type that means an object", () => {
      const v = parse(Root, { items: { k: { x: 1, hash: "ABCD", spec: "a" }, j: { y: 1, spec: { type: "b", n: 2 } } } });
      assert.equal(v.items["k"]?.hash, "abcd");
      assert.deepEqual(v.items["k"]?.spec, { type: "a" });
      assert.deepEqual(v.items["j"]?.spec, { type: "b", n: 2 });
    });

    test("rejects unknown fields where the object is strict, naming the field", () => {
      assert.deepEqual(bad({ nope: 1, sub: { b: 2 } }), [
        "nope: unknown field (not in the schema)",
        "sub.b: unknown field (not in the schema)",
      ]);
    });

    test("says what is wrong where, with the sentence the schema carries", () => {
      assert.deepEqual(bad({ items: { k: { x: 1, hash: "zz" } } }), ["items.k.hash: 64 hex digits"]);
      assert.deepEqual(bad({ items: { k: { x: -1.5 } } }), ["items.k.x: must be integer"]);
      assert.deepEqual(bad({ items: { "Bad Name": { x: 1 } } }), ["items.Bad Name: the name must be lower case letters"]);
    });

    test("reports a rule between fields at the object it is attached to", () => {
      assert.deepEqual(bad({ items: { k: {} } }), ["items.k: give x or y, not both and not neither"]);
      assert.deepEqual(bad({ items: { k: { x: 1, y: 2 } } }), ["items.k: give x or y, not both and not neither"]);
    });

    test("shows the form that got furthest when no form of a choice fits", () => {
      assert.deepEqual(bad({ items: { k: { x: 1, spec: { type: "c" } } } }), [
        "items.k.spec.type: must be equal to one of the allowed values",
      ]);
      assert.deepEqual(bad({ items: { k: { x: 1, spec: 5 } } }), ["items.k.spec: must be equal to one of the allowed values or object"]);
    });

    test("puts array positions in the path as numbers", () => {
      const r = safeParse(Root, { items: { k: { x: 1, tags: [{}, { k: 1 }] } } });
      assert.equal(r.ok, false);
      assert.deepEqual(r.ok ? [] : r.issues[0]?.path, ["items", "k", "tags", 1, "k"]);
    });

    test("parse throws every problem at once", () => {
      assert.throws(
        () => parse(Root, { nope: 1, items: { k: {} } }),
        (e: unknown) => e instanceof ValidationError && e.issues.length === 2,
      );
    });

    test("exports plain JSON Schema: no refinements, codecs or hidden keys", () => {
      const json = JSON.parse(JSON.stringify(Root)) as Record<string, unknown>;
      assert.equal(json["type"], "object");
      assert.equal(JSON.stringify(json).includes("~"), false);
      assert.equal(JSON.stringify(json).includes("refine"), false);
    });
  });
}
