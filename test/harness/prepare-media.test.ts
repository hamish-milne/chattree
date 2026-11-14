import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AttachmentPart, ModelContext } from "../../harness/context-builder.ts";
import { hostConvertCache, type ConvertCache, type ConvertKey } from "../../harness/convert-cache.ts";
import { ConversionError, type Converter } from "../../harness/converter.ts";
import { prepareMedia } from "../../harness/prepare-media.ts";
import type { MediaSpec } from "../../harness/media-spec.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const pad = (a: number[], n = 600): Uint8Array => Uint8Array.from([...a, ...new Array<number>(Math.max(0, n - a.length)).fill(0)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
const BMP = pad([...ascii("BM"), ...le32(600), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(2), ...le32(2), 1, 0, 24, 0]);

const att = (name: string, mime: string, bytes: Uint8Array, kind: AttachmentPart["kind"] = "image"): AttachmentPart => ({ type: "attachment", kind, name, mime, sha256: `${name}-${bytes.length}`, bytes });
const ctx = (turns: ModelContext["turns"]): ModelContext => ({ system: "s", instructions: undefined, turns, tools: [], cacheHints: [] });
const SPEC: MediaSpec = { image: [{ mime: "image/png" }] };

function converter(o: { fail?: boolean; calls?: string[] } = {}): Converter {
  return {
    id: "fake 1",
    can: (from, to) => from.kind === "image" && to.mime === "image/png",
    async convert(bytes, from, to) {
      o.calls?.push(`${from.mime}->${to.mime}`);
      if (o.fail) throw new ConversionError("it would not decode");
      return Uint8Array.from([...PNG, bytes.length & 255]);
    },
  };
}

function memoryCache(): ConvertCache & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  const k = (key: ConvertKey): string => `${key.source}|${key.to}|${key.converter}`;
  return { map, get: async (key) => map.get(k(key)), put: async (key, b) => void map.set(k(key), b) };
}

describe("prepareMedia", () => {
  test("a file the sink takes passes, and nothing is asked for", async () => {
    let asked = 0;
    const c = ctx([{ role: "user", parts: [{ type: "text", text: "hi" }, att("a.png", "image/png", PNG)] }]);
    const r = await prepareMedia(c, { spec: SPEC, converter: async () => (asked++, converter()) });
    assert.equal(r.context, c);
    assert.equal(asked, 0);
    assert.deepEqual([r.converted, r.warnings], [[], []]);
  });

  test("a file it does not take is converted, once, and then comes from the cache", async () => {
    const calls: string[] = [];
    const cache = memoryCache();
    const c = ctx([{ role: "user", parts: [att("a.bmp", "image/bmp", BMP)] }, { role: "user", parts: [att("a.bmp", "image/bmp", BMP)] }]);
    const r = await prepareMedia(c, { spec: SPEC, converter: async () => converter({ calls }), cache });
    assert.deepEqual(calls, ["image/bmp->image/png"], "same file twice, converted once");
    const first = r.context.turns[0] as { parts: AttachmentPart[] };
    assert.equal(first.parts[0]?.mime, "image/png");
    assert.equal(r.converted.length, 2);
    assert.deepEqual(r.converted[0], { name: "a.bmp", from: "image/bmp", to: "image/png", converter: "fake 1", cached: false });
    assert.equal(cache.map.size, 1);
    // the transcript's own context is untouched
    assert.equal((c.turns[0] as { parts: AttachmentPart[] }).parts[0]?.mime, "image/bmp");
    const again = await prepareMedia(c, { spec: SPEC, converter: async () => converter({ calls }), cache });
    assert.equal(calls.length, 1);
    assert.equal(again.converted[0]?.cached, true);
  });

  test("a conversion that fails becomes a note to the model and a warning, and the request goes", async () => {
    const c = ctx([{ role: "user", parts: [att("a.bmp", "image/bmp", BMP)] }]);
    const r = await prepareMedia(c, { spec: SPEC, converter: async () => converter({ fail: true }) });
    const p = (r.context.turns[0] as { parts: { type: string; text?: string }[] }).parts[0];
    assert.equal(p?.type, "text");
    assert.match(p?.text ?? "", /"a.bmp".*not shown to you: it would not decode.*Tell the user/);
    assert.equal(r.warnings[0]?.kind, "media_not_sent");
    assert.deepEqual(r.converted, []);
  });

  test("media in a tool result: converted, or left out with a note in the result's text", async () => {
    const good = att("g.bmp", "image/bmp", BMP);
    const bad = att("x.bin", "application/x-foo", new Uint8Array([1, 2, 3]));
    const c = ctx([{ role: "tool_results", results: [{ call_id: "1", is_error: false, content: "ok", truncated: false, media: [good, bad] }] }]);
    const r = await prepareMedia(c, { spec: SPEC, converter: async () => converter() });
    const res = (r.context.turns[0] as { results: { content: string; media?: AttachmentPart[] }[] }).results[0];
    assert.equal(res?.media?.length, 1);
    assert.equal(res?.media?.[0]?.mime, "image/png");
    assert.match(res?.content ?? "", /^ok\n\[The picture "x.bin"/);
  });

  test("a result whose media all fail has none left", async () => {
    const c = ctx([{ role: "tool_results", results: [{ call_id: "1", is_error: false, content: "ok", truncated: false, media: [att("a.bmp", "image/bmp", BMP)] }] }]);
    const r = await prepareMedia(c, { spec: SPEC, converter: async () => undefined });
    const res = (r.context.turns[0] as { results: { content: string; media?: AttachmentPart[] }[] }).results[0];
    assert.equal("media" in (res ?? {}), false);
    assert.match(res?.content ?? "", /no converter is available|cannot be converted/);
  });

  test("a converter that cannot be had (the setting) stops the request, but only when something needs converting", async () => {
    const boom = async (): Promise<never> => { throw new Error("the ffmpeg setting is not set"); };
    await assert.rejects(prepareMedia(ctx([{ role: "user", parts: [att("a.bmp", "image/bmp", BMP)] }]), { spec: SPEC, converter: boom }), /ffmpeg setting/);
    await prepareMedia(ctx([{ role: "user", parts: [att("a.png", "image/png", PNG)] }]), { spec: SPEC, converter: boom });
  });

  test("a result over the sink's limit once converted is refused with a note", async () => {
    const c = ctx([{ role: "user", parts: [att("a.bmp", "image/bmp", BMP)] }]);
    const r = await prepareMedia(c, { spec: { image: [{ mime: "image/png", maxBytes: 10 }] }, converter: async () => converter() });
    assert.match(r.warnings[0]?.message ?? "", /over the 10/);
  });

  test("the type is found from the content, not the declared type", async () => {
    const r = await prepareMedia(ctx([{ role: "user", parts: [att("lie.png", "image/png", BMP)] }]), { spec: SPEC, converter: async () => converter() });
    assert.equal(r.converted[0]?.from, "image/bmp");
  });
});

describe("conversion cache", () => {
  const key = (n: string): ConvertKey => ({ source: n.repeat(4), to: "image/png", converter: "ffmpeg 6.1.1" });

  test("keeps what it is given, per converter, and keeps to its size", async () => {
    const dir = join(await tempDir(), "convert");
    const cache = hostConvertCache(nodeHost(), dir, 25);
    await cache.put(key("a"), new Uint8Array(10).fill(1));
    assert.deepEqual(await cache.get(key("a")), new Uint8Array(10).fill(1));
    assert.equal(await cache.get({ ...key("a"), converter: "ffmpeg 7" }), undefined);
    await new Promise((r) => setTimeout(r, 20));
    await cache.put(key("b"), new Uint8Array(10).fill(2));
    await new Promise((r) => setTimeout(r, 20));
    await cache.put(key("c"), new Uint8Array(10).fill(3));
    assert.equal(await cache.get(key("a")), undefined, "the oldest went");
    assert.ok(await cache.get(key("b")));
    assert.ok(await cache.get(key("c")));
  });

  test("a cache that cannot be written is only a miss", async () => {
    const dir = await tempDir();
    const file = join(dir, "not-a-dir");
    await nodeHost().fs.writeAtomic(file, new Uint8Array([1]));
    const cache = hostConvertCache(nodeHost(), join(file, "sub"));
    await cache.put(key("a"), new Uint8Array(3));
    assert.equal(await cache.get(key("a")), undefined);
  });
});
