import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalog, resolveName, samplingSettings } from "../../localmodels/catalog.ts";
import { localModelsSchema } from "../../localmodels/config.ts";

const config = localModelsSchema.parse({
  defaults: { ctx_size: 8192 },
  models: {
    qwen: { hf: "o/qwen:Q4_K_M", ctx_size: 32768, aliases: ["q", "default"], description: "General use", tool_convention: "flat", sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 } },
    small: { url: "https://x.test/small.gguf" },
  },
});

describe("the catalog", () => {
  test("has each model under its name and aliases, with what the settings say", () => {
    const c = catalog(config);
    assert.deepEqual(Object.keys(c).sort(), ["default", "q", "qwen", "small"]);
    assert.deepEqual(c["q"], { context_window: 32768, description: "General use", tool_convention: "flat" });
    assert.deepEqual(c["small"], { context_window: 8192 }); // the default context size
  });

  test("resolves an alias to the name, and leaves what it does not know", () => {
    assert.equal(resolveName(config, "default"), "qwen");
    assert.equal(resolveName(config, "small"), "small");
    assert.equal(resolveName(config, "nope"), "nope");
  });

  test("pins sampling as the adapter's model settings", () => {
    assert.deepEqual(samplingSettings(config.models["qwen"]!.sampling), { temperature: 0.6, top_p: 0.95, extra: { top_k: 20, min_p: 0 } });
    assert.deepEqual(samplingSettings(undefined), {});
    assert.deepEqual(samplingSettings({ temperature: 0 }), { temperature: 0 });
  });
});
