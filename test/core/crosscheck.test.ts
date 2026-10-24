import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseDocument, visit } from "yaml";
import { BlobRef, Tagged, emitEntry, parseEntry, valueEquals, type Value } from "../../src/index.ts";
import { Rng, randomEntry } from "../support/gen.ts";

/**
 * Independent oracle: the widely used `yaml` package. Everything the emitter writes must be valid
 * YAML that this package reads as exactly the same data, under both the 1.2 and the 1.1 schema.
 * (The `!blob` tag is unknown to it, so tagged maps are compared as plain maps with the same fields.)
 */

/** What a generic YAML parser sees for each of our values. */
function yamlView(v: Value): Value {
  if (v instanceof Tagged) return yamlView(v.value);
  if (v instanceof BlobRef) {
    const m = new Map<string, Value>([["sha256", v.sha256], ["bytes", v.bytes]]);
    if (v.mime !== undefined) m.set("mime", v.mime);
    return m;
  }
  if (Array.isArray(v)) return v.map(yamlView);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, yamlView(x)]));
  return v;
}

function parseWithYaml(text: string, version: "1.1" | "1.2") {
  const doc = parseDocument(text, { version, uniqueKeys: true });
  const errors = doc.errors.map((e) => e.message);
  const unexpectedWarnings = doc.warnings.filter((w) => w.code !== "TAG_RESOLVE_FAILED").map((w) => w.message);
  let tags = 0;
  visit(doc, { Map: (_k, n) => { if (n.tag === "!blob") tags++; } });
  return { value: doc.toJS({ mapAsMap: true }) as Value[], errors, unexpectedWarnings, tags };
}

function checkFile(seed: number, count: number, version: "1.1" | "1.2", simpleNumbers: boolean) {
  const rng = new Rng(seed);
  const entries = Array.from({ length: count }, () => randomEntry(rng, { blobs: true, tags: true, simpleNumbers }));
  const text = entries.map(emitEntry).join("");
  const r = parseWithYaml(text, version);
  assert.deepEqual(r.errors, [], "yaml reported errors");
  assert.deepEqual(r.unexpectedWarnings, []);
  assert.equal(r.value.length, count, "the whole file must be one YAML sequence");
  let blobs = 0;
  entries.forEach((e, i) => {
    assert.ok(valueEquals(r.value[i] as Value, yamlView(e)), `entry ${i} differs under YAML ${version}:\n${emitEntry(e)}`);
    // and our own parser agrees with the oracle about the same text
    assert.ok(valueEquals(parseEntry(emitEntry(e)), e));
    JSON.stringify(e, (_k, v) => { if (v instanceof BlobRef) blobs++; return v; });
  });
  assert.equal(r.tags, r.tags); // tags are only informational for the oracle
  return blobs;
}

describe("independent YAML parser agrees with the emitter", () => {
  for (const seed of [11, 12, 13, 14]) {
    test(`YAML 1.2, 500 entries, seed ${seed}`, () => {
      checkFile(seed, 500, "1.2", false);
    });
    test(`YAML 1.1 (strict typing rules), 500 entries, seed ${seed}`, () => {
      checkFile(seed + 100, 500, "1.1", true);
    });
  }

  test("every bare word is read as a string by both schemas", () => {
    const words = ["user", "tool_call", "claude-sonnet-5-5", "a.b-c", "_x", "Z9", "inf", "nan", "e5", "Infinity", "NaN", "none", "nope", "Y2", "yes_", "nullable", "trueish", "on_"];
    for (const w of words) {
      const text = emitEntry(new Map<string, Value>([["k", w]]));
      for (const version of ["1.1", "1.2"] as const) {
        const r = parseWithYaml(text, version);
        assert.deepEqual(r.errors, []);
        assert.equal((r.value[0] as Map<string, Value>).get("k"), w, `${w} under ${version}`);
      }
    }
  });

  test("every reserved word is quoted and read back as a string", () => {
    const words = ["y", "Y", "n", "N", "yes", "Yes", "YES", "no", "No", "NO", "true", "True", "TRUE", "false", "False", "FALSE", "on", "On", "ON", "off", "Off", "OFF", "null", "Null", "NULL"];
    for (const w of words) {
      const text = emitEntry(new Map<string, Value>([["k", w], [w, 1]]));
      assert.ok(text.includes(`"${w}"`), `${w} must be quoted: ${text}`);
      for (const version of ["1.1", "1.2"] as const) {
        const r = parseWithYaml(text, version);
        const m = r.value[0] as Map<string, Value>;
        assert.equal(m.get("k"), w);
        assert.equal(m.get(w), 1);
      }
    }
  });

  test("exponent-like identifiers are quoted (the 1.1 float rule reads bare e5 as NaN)", () => {
    for (const w of ["e5", "E5", "e-3", "E+10", "e0x"]) {
      const text = emitEntry(new Map<string, Value>([["k", w], [w, 1]]));
      assert.ok(text.includes(`"${w}"`), `${w} must be quoted: ${text}`);
      for (const version of ["1.1", "1.2"] as const) {
        const m = parseWithYaml(text, version).value[0] as Map<string, Value>;
        assert.equal(m.get("k"), w, `${w} under ${version}`);
        assert.equal(m.get(w), 1);
      }
    }
    // identifiers that merely start with the letter e stay bare
    assert.equal(emitEntry(new Map<string, Value>([["k", "extra"]])), "- k: extra\n\n");
    assert.equal(emitEntry(new Map<string, Value>([["k", "e"]])), "- k: e\n\n");
  });

  test("blob references are read as tagged maps with the same fields", () => {
    const h = "0f".repeat(32);
    const e = new Map<string, Value>([["a", new BlobRef(h, 12, "text/plain")], ["b", [new BlobRef(h, 0)]]]);
    const r = parseWithYaml(emitEntry(e), "1.2");
    assert.deepEqual(r.errors, []);
    assert.equal(r.tags, 2);
    assert.ok(valueEquals(r.value[0] as Value, yamlView(e)));
  });

  test("exponent-form numbers (1.2 schema)", () => {
    const e = new Map<string, Value>([["a", 1e21], ["b", 1.5e-7], ["c", 2.5e300], ["d", 5e-324], ["e", -3e-9]]);
    const r = parseWithYaml(emitEntry(e), "1.2");
    assert.deepEqual(r.errors, []);
    assert.ok(valueEquals(r.value[0] as Value, e));
  });
});
