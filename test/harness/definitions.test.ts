import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BlobStore } from "../../src/index.ts";
import { sha256Hex } from "../../src/index.ts";
import { DefinitionError, assertDefinitions, checkDefinitions, encodeDefinition, hashDefinition, loadDefinitions, pinDefinition, type DefinitionKind, type DefinitionSource, type ToolDefinition } from "../../harness/definitions.ts";
import { ChangeNotAllowed, foldSetup, type PinnedDefinition } from "../../harness/setup.ts";

const memory = (): BlobStore & { map: Map<string, Uint8Array> } => {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    async put(d) {
      const h = await sha256Hex(d);
      map.set(h, d);
      return h;
    },
    async get(h) {
      return map.get(h);
    },
  };
};
const tool = (name: string, extra: Record<string, unknown> = {}): ToolDefinition => ({ name, description: `${name} tool`, input_schema: { type: "object", properties: { a: { type: "string" } } }, ...extra });
const source = (defs: { kind: DefinitionKind; name: string; value: unknown }[]): DefinitionSource => ({
  async list() {
    return Promise.all(defs.map(async (d) => ({ kind: d.kind, name: d.name, hash: await hashDefinition(d.kind, d.value) })));
  },
  async get(kind, name, hash) {
    const d = defs.find((x) => x.kind === kind && x.name === name);
    if (d === undefined) return undefined;
    const bytes = encodeDefinition(kind, d.value);
    return (await sha256Hex(bytes)) === hash ? bytes : undefined;
  },
});
const setupWith = (v: { tools?: Record<string, PinnedDefinition>; instructions?: PinnedDefinition; skills?: Record<string, PinnedDefinition> }) =>
  foldSetup([{ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: { provider: "p", id: "m" }, ...(v.tools ? { tools: { set: v.tools } } : {}), ...(v.instructions ? { instructions: v.instructions } : {}), ...(v.skills ? { skills: { set: v.skills } } : {}) }]);

describe("hashing", () => {
  test("key order does not matter; any value does; instructions are their own text", async () => {
    const a = await hashDefinition("tool", { name: "x", description: "d", input_schema: { b: 1, a: 2 } });
    assert.equal(a, await hashDefinition("tool", { input_schema: { a: 2, b: 1 }, description: "d", name: "x" }));
    assert.notEqual(a, await hashDefinition("tool", { name: "x", description: "d2", input_schema: { b: 1, a: 2 } }));
    assert.equal(await hashDefinition("instructions", "be brief"), await sha256Hex(new TextEncoder().encode("be brief")));
    assert.throws(() => encodeDefinition("instructions", { a: 1 }), DefinitionError);
  });

  test("a blob pin's hash is the blob's hash, so the verifier can check it", async () => {
    const blobs = memory();
    const pin = await pinDefinition("tool", tool("a"), { store: "blob", blobs });
    assert.equal(pin.store, "blob");
    assert.ok(blobs.map.has(pin.hash));
    const ext = await pinDefinition("tool", tool("a"), { store: "external", ref: "tools/a.json" });
    assert.deepEqual(ext, { hash: pin.hash, store: "external", ref: "tools/a.json" });
  });
});

describe("drift", () => {
  test("unchanged: no issues; blob pins need no source", async () => {
    const blobs = memory();
    const pin = await pinDefinition("tool", tool("a"), { store: "blob", blobs });
    const s = setupWith({ tools: { a: pin } });
    assert.deepEqual(await checkDefinitions(s), []);
    assert.deepEqual(await checkDefinitions(s, source([{ kind: "tool", name: "a", value: tool("a") }])), []);
  });

  test("changed and missing are found in both storage modes; kinds map to the section", async () => {
    const blobs = memory();
    const s = setupWith({
      tools: { a: await pinDefinition("tool", tool("a"), { store: "blob", blobs }), b: await pinDefinition("tool", tool("b"), { store: "external", ref: "b" }), gone: await pinDefinition("tool", tool("gone"), { store: "blob", blobs }) },
      instructions: await pinDefinition("instructions", "v1", { store: "blob", blobs }),
      skills: { pdf: await pinDefinition("skill", { name: "pdf" }, { store: "external", ref: "skills/pdf" }) },
    });
    const src = source([
      { kind: "tool", name: "a", value: tool("a", { description: "edited" }) },
      { kind: "tool", name: "b", value: tool("b") },
      { kind: "instructions", name: "instructions", value: "v2" },
      { kind: "skill", name: "pdf", value: { name: "pdf" } },
    ]);
    const issues = await checkDefinitions(s, src);
    assert.deepEqual(issues.map((i) => [i.kind, i.message.split(" ").slice(0, 3).join(" ")]).sort(), [
      ["instructions_changed", "instructions instructions changed:"],
      ["tools_changed", "tool a changed:"],
      ["tools_changed", "tool gone is"],
    ]);
  });

  test("an external pin with no source cannot be served", async () => {
    const s = setupWith({ tools: { b: await pinDefinition("tool", tool("b"), { store: "external", ref: "b" }) } });
    const issues = await checkDefinitions(s);
    assert.equal(issues.length, 1);
    assert.match(issues[0]?.message ?? "", /no definition source/);
  });

  test("assertDefinitions refuses with the same error as other drift, unless allowed", async () => {
    const blobs = memory();
    const s = setupWith({ tools: { a: await pinDefinition("tool", tool("a"), { store: "blob", blobs }) } });
    const src = source([{ kind: "tool", name: "a", value: tool("a", { flags: { x: 1 } }) }]);
    await assert.rejects(assertDefinitions(s, src), (e) => e instanceof ChangeNotAllowed && e.allowWith.join() === "tools_changed");
    await assertDefinitions(s, src, ["tools_changed"]);
  });
});

describe("loading", () => {
  test("blob and external definitions are fetched, verified, and tools come back sorted by name", async () => {
    const blobs = memory();
    const defs = [{ kind: "tool" as const, name: "z", value: tool("z") }, { kind: "tool" as const, name: "m", value: tool("m") }, { kind: "instructions" as const, name: "instructions", value: "hello" }];
    const s = setupWith({
      tools: { z: await pinDefinition("tool", tool("z"), { store: "external", ref: "z" }), m: await pinDefinition("tool", tool("m"), { store: "blob", blobs }) },
      instructions: await pinDefinition("instructions", "hello", { store: "blob", blobs }),
    });
    const l = await loadDefinitions(s, { blobs, source: source(defs) });
    assert.deepEqual(l.tools.map((t) => t.name), ["m", "z"]);
    assert.equal(l.instructions, "hello");
  });

  test("unavailable or mismatching bytes are errors", async () => {
    const blobs = memory();
    const pin = await pinDefinition("tool", tool("a"), { store: "external", ref: "a" });
    await assert.rejects(loadDefinitions(setupWith({ tools: { a: pin } }), { blobs }), /not available/);
    const lying: DefinitionSource = { list: async () => [], get: async () => new TextEncoder().encode('{"name":"other"}') };
    await assert.rejects(loadDefinitions(setupWith({ tools: { a: pin } }), { blobs, source: lying }), /do not match/);
    const missing = { hash: "cd".repeat(32), store: "blob" as const };
    await assert.rejects(loadDefinitions(setupWith({ tools: { a: missing } }), { blobs }), DefinitionError);
  });
});
