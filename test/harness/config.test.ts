import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { harnessConfig } from "../../harness/config.ts";
import { editConfig, parseConfig } from "../../src/config.ts";
import { schema as miniSchema, obj, str, num, opt, arr } from "../support/mini.ts";

const BASE = `# Harness config
version: 1
model:
  provider: anthropic   # primary
  model: claude-sonnet-5-5
tools: [read_file, run_command]
skills:
  - pdf
mcp_servers:
  search:
    url: https://search.example.com/mcp
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
    assert.deepEqual(r.value.tools, ["read_file", "run_command"]);
    assert.equal(r.value.model.provider, "anthropic");
    const minimal = await ok("version: 1\nmodel: {provider: openai, model: gpt-5}\n");
    assert.deepEqual(minimal.value.tools, []);
    assert.deepEqual(minimal.value.mcp_servers, {});
  });

  test("validation issues carry paths", async () => {
    const issues = await bad(BASE.replace("provider: anthropic", "provider: gemini"));
    assert.ok(issues.some((i) => i.path === "model.provider"), JSON.stringify(issues));
    const nested = await bad(BASE.replace("https://search.example.com/mcp", "not a url"));
    assert.ok(nested.length > 0);
  });

  test("unknown fields are rejected by default and allowed when not strict", async () => {
    const text = BASE + "colour: blue\n";
    const issues = await bad(text);
    assert.ok(issues.some((i) => i.path === "colour"));
    assert.ok((await parseConfig(text, harnessConfig, { strict: false })).ok);
  });

  const rejected: [string, string][] = [
    ["aliases", "version: 1\nmodel: &m {provider: openai, model: x}\nmcp_servers: {}\nother: *m\n"],
    ["anchors", "version: 1\nmodel: &m {provider: openai, model: x}\n"],
    ["custom tags", "version: 1\nmodel: !custom {provider: openai, model: x}\n"],
    ["duplicate keys", "version: 1\nversion: 1\nmodel: {provider: openai, model: x}\n"],
    ["multiple documents", "version: 1\nmodel: {provider: openai, model: x}\n---\nversion: 2\n"],
    ["syntax errors", "version: 1\nmodel: {provider: openai\n"],
    ["a non-map root", "- a\n- b\n"],
    ["an empty file", ""],
    ["non-string keys", "1: a\nversion: 1\nmodel: {provider: openai, model: x}\n"],
    ["the reserved $tag key", "$tag: x\nversion: 1\nmodel: {provider: openai, model: x}\n"],
    ["NUL bytes", "version: 1\u0000\n"],
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
  test("ignores comments, spacing, quoting, style and key order", async () => {
    const a = await ok(BASE);
    const b = await ok(`version: 1
skills: [pdf]
mcp_servers: {search: {url: "https://search.example.com/mcp"}}
tools:
- read_file
- "run_command"
model: {model: claude-sonnet-5-5, provider: anthropic}
`);
    assert.equal(a.hash, b.hash);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
  });

  test("an explicit value equal to the default hashes the same as the omitted one", async () => {
    const a = await ok("version: 1\nmodel: {provider: openai, model: x}\n");
    const b = await ok("version: 1\nmodel: {provider: openai, model: x}\ntools: []\nskills: []\n");
    assert.equal(a.hash, b.hash);
  });

  test("values and list order change it", async () => {
    const a = await ok(BASE);
    assert.notEqual(a.hash, (await ok(BASE.replace("claude-sonnet-5-5", "claude-opus-5-5"))).hash);
    assert.notEqual(a.hash, (await ok(BASE.replace("[read_file, run_command]", "[run_command, read_file]"))).hash);
    assert.notEqual(a.hash, (await ok(BASE.replace("[read_file, run_command]", "[read_file]"))).hash);
  });

  test("a string and a number never collide", async () => {
    const s = miniSchema(obj({ v: (v, p) => ({ value: v }) }));
    const a = await parseConfig("v: 1\n", s);
    const b = await parseConfig('v: "1"\n', s);
    assert.ok(a.ok && b.ok && a.hash !== b.hash);
  });
});

describe("editing", () => {
  test("keeps comments and layout, changes only what was asked", async () => {
    const r = await editConfig(BASE, harnessConfig, (doc) => {
      doc.setIn(["model", "model"], "claude-opus-5-5");
    });
    assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
    // Comments and structure survive; the library may normalise spacing before a trailing comment.
    assert.equal(r.text.replace(/ +#/, "   #"), BASE.replace("claude-sonnet-5-5", "claude-opus-5-5"));
    assert.equal(r.value.model.model, "claude-opus-5-5");
    assert.equal(r.hash, (await ok(r.text)).hash);
  });

  test("adding to a list keeps the comment on the line before", async () => {
    const r = await editConfig(BASE, harnessConfig, (doc) => {
      doc.addIn(["skills"], "xlsx");
    });
    assert.ok(r.ok);
    assert.match(r.text, /^# Harness config\n/);
    assert.match(r.text, /provider: anthropic\s+# primary/);
    assert.deepEqual(r.value.skills, ["pdf", "xlsx"]);
  });

  test("an edit that makes the file invalid is refused", async () => {
    const r = await editConfig(BASE, harnessConfig, (doc) => {
      doc.setIn(["model", "provider"], "gemini");
    });
    assert.ok(!r.ok && r.issues.some((i) => i.path === "model.provider"));
  });

  test("a file that is already broken cannot be edited", async () => {
    const r = await editConfig("a: [", harnessConfig, () => {});
    assert.ok(!r.ok);
  });
});
