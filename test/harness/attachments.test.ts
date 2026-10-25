import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { attachmentKind, normalizeMime } from "../../harness/attachments.ts";
import { Conversation, ConversationError } from "../../harness/conversation.ts";
import { estimateInputTokens } from "../../harness/estimate.ts";
import { prepareContext } from "../../harness/request.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function fresh(config?: string) {
  const convo = await Conversation.create(host, join(await tempDir(), "c"), config === undefined ? {} : { config });
  await convo.setupChange({ model: { provider: "main", id: "m" } });
  return convo;
}

describe("media types", () => {
  test("normalised, and classified by how a model is given the file", () => {
    assert.equal(normalizeMime("Text/Plain; charset=utf-8"), "text/plain");
    assert.equal(normalizeMime("png"), undefined);
    assert.deepEqual(["image/png", "image/jpeg", "application/pdf", "text/markdown", "application/json", "application/ld+json", "image/svg+xml", "application/zip", "video/mp4"].map(attachmentKind), ["image", "image", "pdf", "text", "text", "text", "text", undefined, undefined]);
  });
});

describe("Conversation.attach", () => {
  test("stores the bytes as a blob that records the host's media type; the entry round-trips and verifies", async () => {
    const convo = await fresh();
    const part = await convo.attach(PNG, { mime: "image/png", name: "a.png" });
    assert.deepEqual([part.data.mime, part.data.bytes, part.name], ["image/png", PNG.length, "a.png"]);
    assert.deepEqual(await convo.store.get(part.data.sha256), PNG);
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "see" }, part] });
    assert.deepEqual(await verifyHistory(convo), []);
    const again = await Conversation.open(host, convo.dir);
    const e = (await again.readEntries()).flatMap((x) => (x.ok ? [x.value] : [])).at(-1) as { content: { $tag: string }[] };
    assert.equal(e.content[1]?.$tag, "attachment");
  });

  test("refuses a missing or malformed type, a type no model is given, an empty file, and a file over the limit", async () => {
    const convo = await fresh("attachments: { max_bytes: 10 }\n");
    await assert.rejects(convo.attach(PNG, { mime: "" }), /type\/subtype/);
    await assert.rejects(convo.attach(PNG, { mime: "png" }), /type\/subtype/);
    await assert.rejects(convo.attach(PNG, { mime: "application/zip" }), (e) => e instanceof ConversationError && /cannot be given to a model/.test(e.message));
    await assert.rejects(convo.attach(new Uint8Array(), { mime: "image/png" }), /empty/);
    await assert.rejects(convo.attach(new Uint8Array(11), { mime: "image/png" }), /over the limit of 10/);
    await convo.attach(new Uint8Array(10).fill(1), { mime: "image/png" });
  });
});

describe("attachments in the context", () => {
  test("images and PDFs carry their bytes; text files are inlined through the renderer; the estimate counts them", async () => {
    const convo = await fresh();
    const img = await convo.attach(PNG, { mime: "image/png", name: "a.png" });
    const pdf = await convo.attach(new Uint8Array(5000).fill(7), { mime: "application/pdf", name: "r.pdf" });
    const txt = await convo.attach(enc.encode("hello from a file"), { mime: "text/plain; charset=utf-8", name: "n.txt" });
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "look" }, img, pdf, txt] });
    const { context } = await prepareContext(convo, { system: "s" });
    const parts = (context.turns[0] as { parts: { type: string; kind?: string; mime?: string; text?: string; bytes?: Uint8Array }[] }).parts;
    assert.deepEqual(parts.map((p) => p.type === "text" ? p.text : p.kind), ["look", "image", "pdf", "[Attached file: n.txt]\nhello from a file"]);
    assert.deepEqual(parts[1]?.bytes, PNG);
    assert.equal(parts[2]?.mime, "application/pdf");
    const without = estimateInputTokens({ ...context, turns: [{ role: "user", parts: [{ type: "text", text: "look" }] }] });
    assert.ok(estimateInputTokens(context) - without >= 2000 + 1500 + 200, "an image and a PDF are priced, not just their names");
  });

  test("a missing blob or an attachment without a type is an error, not a silent drop", async () => {
    const convo = await fresh();
    await convo.append({ $tag: "user", content: [{ $tag: "attachment", data: { $tag: "blob", sha256: "c".repeat(64), bytes: 3, mime: "image/png" } }] });
    await assert.rejects(prepareContext(convo, { system: "s" }), /missing/);
    const other = await fresh();
    await other.append({ $tag: "user", content: [{ $tag: "attachment", data: { $tag: "blob", sha256: await other.store.put(PNG), bytes: 7 } }] });
    await assert.rejects(prepareContext(other, { system: "s" }), /no media type/);
  });
});
