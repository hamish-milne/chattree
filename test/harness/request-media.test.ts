import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { Conversation } from "../../harness/conversation.ts";
import type { AttachmentPart } from "../../harness/context-builder.ts";
import { ConversionError, type Converter } from "../../harness/converter.ts";
import { prepareContext } from "../../harness/request.ts";
import { envSource } from "../../harness/secrets.ts";
import { nodeHost } from "../../hosts/node.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import { tempDir } from "../support/tmp.ts";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const BMP = Uint8Array.from([...ascii("BM"), ...le32(600), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(2), ...le32(2), 1, 0, 24, 0, ...new Array<number>(560).fill(0)]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);

const registry = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    create: () => ({
      $tag: "fake",
      mediaSpec: () => ({ image: [{ mime: "image/png" }] }),
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("not used");
      },
    }),
  }),
);

async function thread(): Promise<Conversation> {
  const convo = await Conversation.create(nodeHost(), join(await tempDir(), "c"), { providers: { registry, secrets: envSource({}) }, config: "providers:\n  f:\n    $tag: fake\n" });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: "look" }, { $tag: "attachment", name: "a.bmp", data: { $tag: "blob", sha256: await convo.store.put(BMP), bytes: BMP.length, mime: "image/bmp" } }] });
  return convo;
}

const fake = (fail = false): Converter => ({
  id: "fake 1",
  can: () => true,
  async convert() {
    if (fail) throw new ConversionError("no");
    return PNG;
  },
});

describe("prepareContext converts media for the sink", () => {
  test("the request has the converted picture, the thread keeps the original, the cache lands in the git directory", async () => {
    const convo = await thread();
    const p = await prepareContext(convo, { system: "s", cost: false, media: { converter: async () => fake() } });
    const part = (p.context.turns[0] as { parts: AttachmentPart[] }).parts[1];
    assert.deepEqual([part?.mime, part?.bytes.length], ["image/png", PNG.length]);
    assert.equal(p.converted?.[0]?.to, "image/png");
    const dir = join(await convo.git.commonDir(), "chattree", "convert");
    assert.equal((await nodeHost().fs.readdir(dir)).length, 1);
    const entry = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : [])).find((e) => e.$tag === "user");
    assert.ok(entry && "content" in entry && entry.content.some((c) => c.$tag === "attachment" && c.data.mime === "image/bmp"));
  });

  test("a failure goes in as a warning and a note, with cost checks on or off", async () => {
    const convo = await thread();
    for (const cost of [false, undefined] as const) {
      const p = await prepareContext(convo, { system: "s", ...(cost === false ? { cost } : { allowDrift: ["pricing_changed" as const] }), media: { converter: async () => fake(true), cache: false } });
      assert.equal(p.warnings.filter((w) => w.kind === "media_not_sent").length, 1);
      assert.equal(p.converted, undefined);
    }
  });
});
