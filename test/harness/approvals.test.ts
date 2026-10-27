import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ALL, FOREVER, addGrants, keyProblem, liveKeys, permitted, revokeGrants, untilAfter, untilMs } from "../../harness/approvals.ts";
import { harnessConfig } from "../../harness/config.ts";
import { parseConfig } from "../../src/config.ts";
import type { Tool } from "../../harness/tools.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");

const tool = (extra: Partial<Tool> = {}): Tool => ({
  definition: { name: "t", description: "t", input_schema: { type: "object", properties: {} } },
  execute: async () => ({ content: "" }),
  ...extra,
});

const FILE = `# Harness config
providers: {}
tools:
  read:
    allow:
      all: 2999-01-01   # safe
  run:
    safe: [grep, cat]
    allow:
      "grep **": 2026-10-27T15:00:00Z
      "git status **": 2026-10-27T11:59:59Z
`;

describe("the tools key in harness.yml", () => {
  test("reads maps of key to expiry, a safe list, and env; absent means no grants", async () => {
    const r = await parseConfig(FILE + "  env: [HOME]\n", harnessConfig);
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
    assert.equal(r.value.tools["read"]?.allow["all"], "2999-01-01");
    assert.deepEqual(r.value.tools["run"]?.safe, ["grep", "cat"]);
    const none = await parseConfig("providers: {}\n", harnessConfig);
    assert.ok(none.ok);
    assert.deepEqual(none.value.tools, {});
  });

  test("an expiry must be a date or a datetime with a zone", async () => {
    for (const bad of ["tomorrow", "2026-10-27T15:00:00", "2026-13-40", "5m", "true"]) {
      const r = await parseConfig(`providers: {}\ntools:\n  run:\n    allow:\n      all: ${bad}\n`, harnessConfig);
      assert.ok(!r.ok, `${bad} should be refused`);
    }
    for (const good of ["2999-01-01", "2026-10-27T15:00Z", "2026-10-27T15:00:00+01:00", "2026-10-27T15:00:00.5Z"]) {
      const r = await parseConfig(`providers: {}\ntools:\n  run:\n    allow:\n      all: ${good}\n`, harnessConfig);
      assert.ok(r.ok, `${good} should be accepted`);
    }
  });

  test("unknown settings inside a tool entry are refused", async () => {
    assert.ok(!(await parseConfig("providers: {}\ntools:\n  run:\n    deny: true\n", harnessConfig)).ok);
  });
});

describe("expiry", () => {
  test("a date is midnight UTC; the boundary instant has expired", () => {
    assert.equal(untilMs("2026-10-28"), Date.parse("2026-10-28T00:00:00Z"));
    assert.equal(untilMs("nonsense"), undefined);
    assert.deepEqual(liveKeys({ a: "2026-10-27T12:00:00Z", b: "2026-10-27T12:00:01Z", c: "bad" }, NOW), ["b"]);
    assert.deepEqual(liveKeys(undefined, NOW), []);
  });
  test("untilAfter counts seconds from now; infinity is forever", () => {
    assert.equal(untilAfter(NOW, 300), "2026-10-27T12:05:00.000Z");
    assert.equal(untilAfter(NOW, 3600), "2026-10-27T13:00:00.000Z");
    assert.equal(untilAfter(NOW, Infinity), FOREVER);
  });
});

describe("permitted", () => {
  test("all covers every call, but only while live", async () => {
    const t = tool();
    assert.deepEqual(await permitted(t, {}, { all: FOREVER }, NOW), { permitted: true, key: ALL });
    assert.deepEqual(await permitted(t, {}, { all: "2026-10-27T11:00:00Z" }, NOW), { permitted: false });
    assert.deepEqual(await permitted(t, {}, undefined, NOW), { permitted: false });
  });
  test("other keys are the tool's to judge, and an expired key is never asked", async () => {
    const seen: string[] = [];
    const t = tool({ covers: (key, args) => (seen.push(key), key === "x" && args["v"] === 1) });
    assert.deepEqual(await permitted(t, { v: 1 }, { x: FOREVER, y: FOREVER, old: "2020-01-01" }, NOW), { permitted: true, key: "x" });
    assert.deepEqual(seen, ["x"]);
    assert.deepEqual(await permitted(t, { v: 2 }, { x: FOREVER, y: FOREVER, old: "2020-01-01" }, NOW), { permitted: false });
    assert.deepEqual(seen, ["x", "x", "y"], "expired keys are skipped");
  });
  test("a tool without `covers` is covered only by all", async () => {
    assert.deepEqual(await permitted(tool(), {}, { "grep **": FOREVER }, NOW), { permitted: false });
  });
});

describe("keyProblem", () => {
  test("all is always fine; other keys need a tool that has keys, and its own check", () => {
    assert.equal(keyProblem(tool(), ALL), undefined);
    assert.match(keyProblem(tool(), "grep **") ?? "", /only the key "all"/);
    const t = tool({ covers: () => false, validateKey: (k) => (k.startsWith("git") ? undefined : "must start with git") });
    assert.equal(keyProblem(t, "git status **"), undefined);
    assert.equal(keyProblem(t, "ls"), "must start with git");
    assert.match(keyProblem(t, "  ") ?? "", /empty/);
  });
});

describe("editing the file", () => {
  test("a grant is written under the tool, keeping comments, and expired keys are dropped", async () => {
    const r = await addGrants(FILE, "run", ["cat **"], "2026-10-27T12:05:00.000Z", NOW);
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.match(r.text, /# safe/, "comments survive");
    assert.match(r.text, /cat \*\*/);
    assert.doesNotMatch(r.text, /git status/, "the expired key is pruned");
    assert.equal(r.value.tools["run"]?.allow["cat **"], "2026-10-27T12:05:00.000Z");
    assert.equal(r.value.tools["run"]?.allow["grep **"], "2026-10-27T15:00:00Z");
  });
  test("a short grant never shortens a longer one; a longer one extends", async () => {
    const a = await addGrants(FILE, "read", [ALL], "2026-10-27T12:05:00.000Z", NOW);
    assert.ok(a.ok);
    assert.equal(a.value.tools["read"]?.allow["all"], "2999-01-01");
    const b = await addGrants(FILE, "run", ["grep **"], "2026-10-27T16:00:00.000Z", NOW);
    assert.ok(b.ok);
    assert.equal(b.value.tools["run"]?.allow["grep **"], "2026-10-27T16:00:00.000Z");
  });
  test("a grant creates the tools map and the tool entry when the file has none", async () => {
    const r = await addGrants("providers: {}\n", "edit", [ALL], FOREVER, NOW);
    assert.ok(r.ok, r.ok ? "" : r.message);
    assert.equal(r.value.tools["edit"]?.allow["all"], FOREVER);
  });
  test("several keys at once", async () => {
    const r = await addGrants("providers: {}\n", "run", ["cat **", "grep **"], FOREVER, NOW);
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value.tools["run"]?.allow ?? {}).sort(), ["cat **", "grep **"]);
  });
  test("a bad expiry is refused and nothing changes", async () => {
    const r = await addGrants(FILE, "run", ["cat **"], "soon", NOW);
    assert.equal(r.ok, false);
  });
  test("revoke removes one key or all of a tool's keys, and keeps its other settings", async () => {
    const one = await revokeGrants(FILE, "run", "grep **", NOW);
    assert.ok(one.ok);
    assert.deepEqual(one.value.tools["run"]?.allow, {});
    assert.deepEqual(one.value.tools["run"]?.safe, ["grep", "cat"]);
    const all = await revokeGrants(FILE, "read", undefined, NOW);
    assert.ok(all.ok);
    assert.deepEqual(all.value.tools["read"]?.allow, {});
    const missing = await revokeGrants(FILE, "run", "nope", NOW);
    assert.ok(missing.ok);
  });
});
