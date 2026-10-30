import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { GEMINI_ROWS } from "../../providers/catalog/gemini-rows.ts";
import { OPENCODE_GO_ROWS } from "../../providers/catalog/opencode-go-rows.ts";
import { applyGeminiLimits, CatalogShapeError, parseOpencodeList, renderRows } from "../../providers/catalog/refresh.ts";

describe("rendering snapshot rows", () => {
  test("what is written reads back as the same rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-"));
    for (const [rows, head, name] of [
      [OPENCODE_GO_ROWS, { comment: "/** x */", type: "GoRow", from: "../opencode-go.ts", name: "ROWS" }, "go.ts"],
      [GEMINI_ROWS, { comment: "/** y */", type: "GeminiRow", from: "../gemini.ts", name: "ROWS" }, "gem.ts"],
    ] as const) {
      const file = join(dir, name);
      await writeFile(file, renderRows(rows, head));
      const back = ((await import(pathToFileURL(file).href)) as { ROWS: unknown }).ROWS;
      assert.deepEqual(back, rows);
    }
  });
});

describe("the Gemini model list", () => {
  const body = {
    models: [
      { name: "models/gemini-3.8-flash", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-9-new", inputTokenLimit: 1, outputTokenLimit: 1, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-1", supportedGenerationMethods: ["embedContent"] },
    ],
  };
  test("limits are filled in for known models, and new chat models are reported", () => {
    const { rows, unknown } = applyGeminiLimits(body, GEMINI_ROWS);
    const flash = rows.find((r) => r.id === "gemini-3.8-flash");
    assert.equal(flash?.context, 1_048_576);
    assert.equal(flash?.output, 65_536);
    assert.equal(rows.find((r) => r.id === "gemini-4-argon")?.context, undefined, "a model missing from the list keeps what it had");
    assert.deepEqual(unknown, ["gemini-9-new"]);
  });
  test("a body of another shape is refused with what it has", () => {
    assert.throws(() => applyGeminiLimits({ error: "x" }, GEMINI_ROWS), (e) => e instanceof CatalogShapeError && /error/.test(e.message));
  });
});

describe("the OpenCode Go list", () => {
  // The nesting here is the one the parser looks for first; it was described to us, not copied (providers/catalog/refresh.ts).
  const entry = { id: "m1", name: "M One", api: { type: "chat-completions" }, limit: { context: 1000, output: 100 }, cost: { input: 1, output: 2, cache_read: 0.1 }, reasoning: { effort: ["low", "high"] }, modalities: { input: ["text", "image"] }, open_weights: true };
  test("a list of that shape becomes rows, keeping the bands the list does not carry", () => {
    const prev = [{ ...OPENCODE_GO_ROWS[0], id: "m1", long: { above_tokens: 5, input: 2, output: 4 } }] as never;
    const [r] = parseOpencodeList({ object: "list", data: [entry] }, prev);
    assert.deepEqual(r, { id: "m1", name: "M One", api: "chat-completions", context: 1000, output: 100, price: { input: 1, output: 2, cache_read: 0.1 }, long: { above_tokens: 5, input: 2, output: 4 }, efforts: ["low", "high"], images: true, open_weights: true });
  });
  test("a missing field is named, with the keys that were there", () => {
    const { limit: _l, ...noLimit } = entry;
    assert.throws(() => parseOpencodeList({ data: [noLimit] }), (e) => e instanceof CatalogShapeError && /m1: no usable "context"/.test(e.message) && /name/.test(e.message));
    assert.throws(() => parseOpencodeList({ data: [{ ...entry, api: { type: "carrier-pigeon" } }] }), /carrier-pigeon/);
    assert.throws(() => parseOpencodeList({ nope: 1 }), /found keys: nope/);
  });
});
