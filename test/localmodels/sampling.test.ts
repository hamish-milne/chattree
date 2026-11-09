import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { localModelsSchema } from "../../localmodels/config.ts";
import { baseModels, fromGenerationConfig, readGgufSampling, resolveSampling, samplingYaml, fileReader } from "../../localmodels/sampling.ts";
import { gguf, SAMPLING } from "../support/gguf.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

const reader = (b: Buffer) => async (start: number, length: number): Promise<Uint8Array> => b.subarray(start, start + length);
const entry = (m: Record<string, unknown>) => localModelsSchema.parse({ models: { m } }).models["m"] as NonNullable<ReturnType<typeof localModelsSchema.parse>["models"]["m"]>;

describe("reading sampling from a GGUF header", () => {
  test("finds the general.sampling keys after a vocabulary, as clean numbers", async () => {
    assert.deepEqual(await readGgufSampling(reader(gguf(SAMPLING))), { temperature: 0.6, top_p: 0.95, top_k: 20, repeat_penalty: 1.1 });
  });

  test("a file without the keys gives none, and a vocabulary larger than one read is walked", async () => {
    assert.deepEqual(await readGgufSampling(reader(gguf([]))), {});
    assert.deepEqual(await readGgufSampling(reader(gguf(SAMPLING, 200_000))), { temperature: 0.6, top_p: 0.95, top_k: 20, repeat_penalty: 1.1 });
  });

  test("says what is wrong with something that is not a GGUF header", async () => {
    await assert.rejects(readGgufSampling(reader(Buffer.from("not a model at all, just text"))), /not a GGUF file/);
    await assert.rejects(readGgufSampling(reader(gguf(SAMPLING).subarray(0, 60))), /ended inside its header/);
  });

  test("reads a file on disk", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "m.gguf"), gguf(SAMPLING));
    assert.equal((await readGgufSampling(fileReader(join(dir, "m.gguf")))).top_k, 20);
  });
});

describe("generation_config.json and base_model", () => {
  test("takes temperature, top_p and top_k, and only sensible values", () => {
    assert.deepEqual(fromGenerationConfig({ temperature: 0.7, top_p: 0.8, top_k: 20, do_sample: true, repetition_penalty: 1.05 }), { temperature: 0.7, top_p: 0.8, top_k: 20 });
    assert.deepEqual(fromGenerationConfig({ temperature: "hot", top_p: 7, top_k: 1.5 }), {});
    assert.deepEqual(fromGenerationConfig(null), {});
  });

  test("base models come from the card, a list, or the tags", () => {
    assert.deepEqual(baseModels({ cardData: { base_model: "Qwen/Qwen3-0.6B" } }), ["Qwen/Qwen3-0.6B"]);
    assert.deepEqual(baseModels({ cardData: { base_model: ["a/b", "c/d", 3] } }), ["a/b", "c/d"]);
    assert.deepEqual(baseModels({ tags: ["gguf", "base_model:openai/gpt-oss-20b", "base_model:quantized:openai/gpt-oss-20b"] }), ["openai/gpt-oss-20b"]);
    assert.deepEqual(baseModels({}), []);
  });
});

describe("resolving a model's sampling", () => {
  async function hub(): Promise<HttpFixture> {
    const h = await HttpFixture.start();
    const file = gguf([]);
    h.on("/api/models/org/quant/tree/main", { body: JSON.stringify([{ type: "file", path: "Model-Q4_K_M.gguf", size: file.length }]), headers: { "content-type": "application/json" } });
    h.on("/org/quant/resolve/main/Model-Q4_K_M.gguf", { body: file });
    h.on("/api/models/org/quant", { body: JSON.stringify({ cardData: { base_model: "org/reupload" } }), headers: { "content-type": "application/json" } });
    h.on("/api/models/org/reupload", { body: JSON.stringify({ tags: ["base_model:vendor/original"] }), headers: { "content-type": "application/json" } });
    h.on("/api/models/vendor/original", { body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    h.on("/vendor/original/resolve/main/generation_config.json", { body: JSON.stringify({ temperature: 1, top_p: 1 }) });
    return h;
  }

  test("the settings win, whole, without any network", async () => {
    const r = await resolveSampling(entry({ hf: "org/quant:Q4_K_M", sampling: { temperature: 0.3 } }), { fetch: () => Promise.reject(new Error("offline")) });
    assert.deepEqual(r, { values: { temperature: 0.3 }, source: "settings", detail: "the settings file", notes: [] });
  });

  test("with no values in the settings, the header is next: from the file on disk, or by Range request", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "m.gguf"), gguf(SAMPLING));
    const local = await resolveSampling(entry({ hf: "org/quant:Q4_K_M" }), { localFile: join(dir, "m.gguf"), fetch: () => Promise.reject(new Error("offline")) });
    assert.equal(local.source, "gguf");
    assert.equal(local.values.top_k, 20);

    const h = await HttpFixture.start();
    try {
      const file = gguf(SAMPLING);
      h.on("/api/models/org/quant/tree/main", { body: JSON.stringify([{ type: "file", path: "Model-Q4_K_M.gguf", size: file.length }]) });
      h.on("/org/quant/resolve/main/Model-Q4_K_M.gguf", { body: file });
      const remote = await resolveSampling(entry({ hf: "org/quant:Q4_K_M" }), { hfBase: h.base });
      assert.equal(remote.source, "gguf");
      assert.match(remote.detail ?? "", /org\/quant\/Model-Q4_K_M\.gguf/);
      assert.ok(h.seen.some((s) => s.headers["range"] !== undefined), "asked for a range, not the whole file");
    } finally {
      await h.close();
    }
  });

  test("with nothing in the header it follows base_model, through a re-upload, to generation_config.json", async () => {
    const h = await hub();
    try {
      const r = await resolveSampling(entry({ hf: "org/quant:Q4_K_M" }), { hfBase: h.base });
      assert.equal(r.source, "generation_config");
      assert.deepEqual(r.values, { temperature: 1, top_p: 1 });
      assert.equal(r.detail, "generation_config.json of vendor/original");
      assert.deepEqual(r.notes, []);
    } finally {
      await h.close();
    }
  });

  test("when nothing has any, there is nothing, and a failed lookup is a note, not an error", async () => {
    const h = await hub();
    h.routes.delete("/vendor/original/resolve/main/generation_config.json");
    try {
      const r = await resolveSampling(entry({ hf: "org/quant:Q4_K_M" }), { hfBase: h.base });
      assert.deepEqual([r.source, r.values], [undefined, {}]);
    } finally {
      await h.close();
    }
    const down = await resolveSampling(entry({ hf: "org/quant:Q4_K_M" }), { hfBase: "http://127.0.0.1:1" });
    assert.equal(down.source, undefined);
    assert.ok(down.notes.length >= 1);
  });

  test("a plain url has only its header to look in", async () => {
    const h = await HttpFixture.start();
    try {
      h.on("/m.gguf", { body: gguf(SAMPLING) });
      assert.equal((await resolveSampling(entry({ url: `${h.base}/m.gguf` }))).values.temperature, 0.6);
    } finally {
      await h.close();
    }
  });

  test("the snippet for the settings", () => {
    assert.equal(samplingYaml("q", { temperature: 0.6, top_k: 20 }), "local_models:\n  models:\n    q:\n      sampling: { temperature: 0.6, top_k: 20 }");
  });
});
