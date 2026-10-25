import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { harnessConfig } from "../../harness/config.ts";
import { editConfig, parseConfig } from "../../src/config.ts";
import { schema as miniSchema, obj, str, num, opt, arr } from "../support/mini.ts";

const BASE = `# Harness config
providers:
  main:
    $tag: anthropic   # primary
    api_key_env: ANTHROPIC_API_KEY
  local: !openai-compatible
    base_url: http://localhost:8080/v1
limits:
  max_request_usd: 1.5
  warn_at: 0.8
`;

const ok = async (text: string) => {
  const r = await parseConfig(text, harnessConfig);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
  return r;
};
const bad = async (text: string) => {
  const r = await parseConfig(text, harnessConfig);
  assert.ok(!r.ok, "expected failure");
  return r.issues;
};

describe("reading", () => {
  test("accepts comments, flow style, plain scalars; applies schema defaults", async () => {
    const r = await ok(BASE);
    assert.equal(r.value.providers["main"]?.$tag, "anthropic");
    assert.equal(r.value.limits.max_request_usd, 1.5);
    const minimal = await ok("providers: {a: {$tag: openai}}\n");
    assert.deepEqual(minimal.value.limits, {});
    assert.deepEqual((await ok("limits: {warn_at: 0.5}\n")).value.providers, {});
  });

  test("`!name` on a map is the same as a $tag key, and the rest of the map passes through", async () => {
    const r = await ok(BASE);
    assert.equal(r.value.providers["local"]?.$tag, "openai-compatible");
    assert.equal(r.value.providers["local"]?.["base_url"], "http://localhost:8080/v1");
    const written = await ok("providers:\n  local:\n    $tag: openai-compatible\n    base_url: http://localhost:8080/v1\nlimits: {max_request_usd: 1.5, warn_at: 0.8}\nproviders2: ignored\n".replace("providers2: ignored\n", "").replace("providers:\n  local", "providers:\n  main:\n    $tag: anthropic\n    api_key_env: ANTHROPIC_API_KEY\n  local"));
    assert.equal(written.hash, r.hash);
  });

  test("a tag on anything but a map is refused", async () => {
    assert.ok((await bad("providers: {a: {$tag: !x openai}}\n")).length > 0);
    assert.ok((await bad("providers: !x [a]\n")).length > 0);
    assert.ok((await bad("providers: {a: !x {$tag: y}}\n")).length > 0, "a tag and a $tag key together are ambiguous");
  });

  test("validation issues carry paths", async () => {
    const issues = await bad(BASE.replace("max_request_usd: 1.5", "max_request_usd: -1"));
    assert.ok(issues.some((i) => i.path === "limits.max_request_usd"), JSON.stringify(issues));
    const untagged = await bad("providers: {a: {api_key_env: X}}\n");
    assert.ok(untagged.some((i) => i.path.startsWith("providers.a")), JSON.stringify(untagged));
  });

  test("unknown fields are rejected by default and allowed when not strict", async () => {
    const text = BASE + "colour: blue\n";
    const issues = await bad(text);
    assert.ok(issues.some((i) => i.path === "colour"));
    assert.ok((await parseConfig(text, harnessConfig, { strict: false })).ok);
  });

  const rejected: [string, string][] = [
    ["aliases", "providers: {a: &m {$tag: openai}}\nlimits: {}\nother: *m\n"],
    ["anchors", "providers: {a: &m {$tag: openai}}\n"],
    ["duplicate keys", "providers: {}\nproviders: {}\n"],
    ["multiple documents", "providers: {}\n---\nlimits: {}\n"],
    ["syntax errors", "providers: {a: {$tag: openai\n"],
    ["a non-map root", "- a\n- b\n"],
    ["an empty file", ""],
    ["non-string keys", "1: a\nproviders: {}\n"],
    ["the reserved $value key", "providers: {a: {$tag: openai, $value: x}}\n"],
    ["NUL bytes", "providers: {}\u0000\n"],
  ];
  for (const [name, text] of rejected) {
    test(`rejects ${name}`, async () => {
      assert.ok((await bad(text)).length > 0);
    });
  }

  test("rejects non-finite numbers", async () => {
    const s = miniSchema(obj({ x: num }));
    assert.ok(!(await parseConfig("x: .inf\n", s)).ok);
    assert.ok(!(await parseConfig("x: .nan\n", s)).ok);
  });

  test("works with any Standard Schema validator", async () => {
    const s = miniSchema(obj({ name: str, tags: opt(arr(str)) }));
    const r = await parseConfig("name: x # c\ntags: [a, b]\n", s);
    assert.ok(r.ok && r.value["name"] === "x");
  });
});

describe("hash", () => {
  test("ignores comments, spacing, quoting, style, key order and tag sugar", async () => {
    const a = await ok(BASE);
    const b = await ok(`limits: {warn_at: 0.8, max_request_usd: 1.5}
providers:
  local: {base_url: "http://localhost:8080/v1", $tag: "openai-compatible"}
  main: {api_key_env: ANTHROPIC_API_KEY, $tag: anthropic}
`);
    assert.equal(a.hash, b.hash);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
  });

  test("an explicit value equal to the default hashes the same as the omitted one", async () => {
    const a = await ok("providers: {a: {$tag: openai}}\n");
    const b = await ok("providers: {a: {$tag: openai}}\nlimits: {}\n");
    assert.equal(a.hash, b.hash);
  });

  test("values change it", async () => {
    const a = await ok(BASE);
    assert.notEqual(a.hash, (await ok(BASE.replace("ANTHROPIC_API_KEY", "OTHER_KEY"))).hash);
    assert.notEqual(a.hash, (await ok(BASE.replace("!openai-compatible", "!openai"))).hash);
  });

  test("a string and a number never collide", async () => {
    const s = miniSchema(obj({ v: (v, p) => ({ value: v }) }));
    const a = await parseConfig("v: 1\n", s);
    const b = await parseConfig('v: "1"\n', s);
    assert.ok(a.ok && b.ok && a.hash !== b.hash);
  });
});

describe("editing", () => {
  test("keeps comments, layout and tag sugar, changes only what was asked", async () => {
    const r = await editConfig(BASE, harnessConfig, (doc) => {
      doc.setIn(["limits", "max_request_usd"], 3);
    });
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
    assert.equal(r.text.replace(/ +#/, "   #"), BASE.replace("max_request_usd: 1.5", "max_request_usd: 3"));
    assert.equal(r.value.limits.max_request_usd, 3);
    assert.equal(r.hash, (await ok(r.text)).hash);
  });

  test("an edit that makes the file invalid is refused", async () => {
    const r = await editConfig(BASE, harnessConfig, (doc) => {
      doc.setIn(["limits", "warn_at"], 5);
    });
    assert.ok(!r.ok && r.issues.some((i) => i.path === "limits.warn_at"));
  });

  test("a file that is already broken cannot be edited", async () => {
    const r = await editConfig("a: [", harnessConfig, () => {});
    assert.ok(!r.ok);
  });
});
