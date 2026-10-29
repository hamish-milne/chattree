import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { harnessConfig } from "../../harness/config.ts";
import { childModel, describeModels, resolveSubagentModels } from "../../harness/subagent-models.ts";
import { modelsFor, type ModelInfo } from "../../providers/registry.ts";
import { ANTHROPIC_MODELS } from "../../providers/pricing-data.ts";

const catalog = {
  big: { cost_tier: "high" as const, description: "the best", reasoning: { low: { effort: "low" }, high: { effort: "high" } }, default_reasoning: "high", max_output_tokens: 64000 },
  small: { cost_tier: "low" as const, description: "cheap", reasoning: { off: { thinking: "off" } }, max_output_tokens: 8000 },
};
const lookup = (p: string, id: string): ModelInfo | undefined => (p === "a" ? (catalog as Record<string, ModelInfo>)[id] : undefined);
const parent = { provider: "a", id: "big", settings: { max_output_tokens: 16000, effort: "high", temperature: 0.5 } };

describe("the model catalog", () => {
  test("a provider's own entry for a model is merged field by field over the bundled one", () => {
    const merged = modelsFor(ANTHROPIC_MODELS, { models: { "claude-sonnet-5-5": { context_window: 500_000 } } });
    assert.equal(merged["claude-sonnet-5-5"]?.context_window, 500_000);
    assert.equal(merged["claude-sonnet-5-5"]?.cost_tier, "medium", "what was not overridden stays");
    assert.ok(merged["claude-haiku-5-5"]?.description !== undefined);
  });

  test("harness.yml accepts descriptions and levels in models, and refuses a default that is not a level", () => {
    const ok = harnessConfig.safeParse({ providers: { p: { $tag: "x", models: { m: { description: "d", cost_tier: "low", reasoning: { low: { effort: "low" } }, default_reasoning: "low" } } } } });
    assert.ok(ok.success);
    assert.ok(harnessConfig.safeParse({ subagent: { models: { "p/m": { reasoning: ["low"] } } } }).success);
    assert.ok(!harnessConfig.safeParse({ subagent: { models: { "no-slash": {} } } }).success);
  });
});

describe("resolving the models a subagent may use", () => {
  test("takes description, tier and levels from the catalog; the list can narrow and reword", () => {
    const r = resolveSubagentModels({ "a/big": { reasoning: ["low"], description: "mine" }, "a/small": {} }, new Set(["a"]), lookup);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.models.map((m) => [m.key, m.description, Object.keys(m.levels), m.defaultLevel]), [["a/big", "mine", ["low"], undefined], ["a/small", "cheap", ["off"], undefined]]);
  });

  test("a provider that is not configured and a level the catalog lacks are problems; an unknown model is allowed", () => {
    const r = resolveSubagentModels({ "z/m": {}, "a/big": { reasoning: ["max"] }, "a/mystery": {} }, new Set(["a"]), lookup);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.join("\n"), /no provider z/);
    assert.match(r.problems.join("\n"), /no reasoning level "max"/);
    assert.ok(r.models.some((m) => m.key === "a/mystery" && Object.keys(m.levels).length === 0));
  });

  test("the description says nothing about prices, so a price update does not change it", () => {
    const text = describeModels(resolveSubagentModels({ "a/big": {} }, new Set(["a"]), lookup).models);
    assert.doesNotMatch(text, /\$|USD|per million/i);
    assert.match(text, /cost: high/);
  });
});

describe("the child's model setting", () => {
  const models = resolveSubagentModels({ "a/big": {}, "a/small": {}, "b/other": {} }, new Set(["a", "b"]), (p, id) => (p === "b" ? { description: "elsewhere" } : lookup(p, id))).models;

  test("nothing chosen is the parent's own setup", () => {
    assert.deepEqual(childModel({}, models, parent, catalog.big), { ok: true, model: undefined, key: "inherit", level: undefined });
    assert.deepEqual(childModel({ model: "a/big" }, models, parent, catalog.big), { ok: true, model: undefined, key: "inherit", level: undefined });
  });

  test("another level of the same model keeps the parent's other settings", () => {
    const c = childModel({ reasoning: "low" }, models, parent, catalog.big);
    assert.deepEqual(c.ok && c.model?.settings, { max_output_tokens: 16000, effort: "low", temperature: 0.5 });
  });

  test("another model starts from the output cap only: the parent's other settings belong to the parent's model", () => {
    const c = childModel({ model: "a/small", reasoning: "off" }, models, parent, catalog.big);
    assert.deepEqual(c.ok && c.model, { provider: "a", id: "small", settings: { max_output_tokens: 8000, thinking: "off" } });
    assert.equal(c.ok && approvalKeyOf(c), "a/small@off");
  });

  test("another provider needs a known cap of its own", () => {
    const c = childModel({ model: "b/other" }, models, parent, catalog.big);
    assert.ok(!c.ok && /output cap for b\/other is not known/.test(c.message));
  });

  test("a model that is not offered, and a level it lacks, are refused with what is allowed", () => {
    const no = childModel({ model: "a/huge" }, models, parent, catalog.big);
    assert.ok(!no.ok && /a\/big, a\/small, b\/other/.test(no.message));
    const lvl = childModel({ model: "a/small", reasoning: "high" }, models, parent, catalog.big);
    assert.ok(!lvl.ok && /its levels are off/.test(lvl.message));
  });

  test("a model's default level applies when another model is chosen without one", () => {
    const c = childModel({ model: "a/big", reasoning: undefined }, models, { ...parent, id: "small" }, catalog.small);
    assert.deepEqual(c.ok && c.model?.settings, { max_output_tokens: 16000, effort: "high" });
  });
});

import { approvalKey } from "../../harness/subagent-models.ts";
const approvalKeyOf = (c: { key: string; level: string | undefined }): string => approvalKey(c);
