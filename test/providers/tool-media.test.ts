import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttachmentPart, ModelContext } from "../../harness/context-builder.ts";
import { emptySetup, type AgentSetup } from "../../harness/setup.ts";
import { buildAnthropicBody } from "../../providers/anthropic.ts";
import { buildChatBody } from "../../providers/openai-compatible.ts";
import { buildResponsesBody } from "../../providers/openai-responses.ts";
import { resultContent } from "../../providers/dialects/media.ts";
import { ProviderError } from "../../providers/types.ts";

const png: AttachmentPart = { type: "attachment", kind: "image", name: "out.png", mime: "image/png", sha256: "0".repeat(64), bytes: Uint8Array.from([1, 2, 3]) };
const wav: AttachmentPart = { type: "attachment", kind: "audio", name: "a.wav", mime: "audio/wav", sha256: "1".repeat(64), bytes: Uint8Array.from([4, 5]) };
const pdf: AttachmentPart = { type: "attachment", kind: "pdf", name: "d.pdf", mime: "application/pdf", sha256: "2".repeat(64), bytes: Uint8Array.from([6]) };
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

const setup: AgentSetup = { ...emptySetup(), model: { provider: "p", id: "m", settings: { max_output_tokens: 256 } } };
const turnsWith = (media: AttachmentPart[]): ModelContext["turns"] => [
  { role: "user", parts: [{ type: "text", text: "look" }] },
  { role: "assistant", provider: "p", model: "m", blocks: [{ type: "tool_call", call_id: "c1", name: "mm_read", args: { path: "out.png" } }] },
  { role: "tool_results", results: [{ call_id: "c1", is_error: false, content: "out.png: picture", truncated: false, ...(media.length === 0 ? {} : { media }) }] },
];
const ctx = (media: AttachmentPart[]): ModelContext => ({ system: "S", instructions: undefined, turns: turnsWith(media), tools: [], cacheHints: [] });

describe("media in a tool result, on each wire", () => {
  test("anthropic: the tool_result content is an array of the text and an image block", () => {
    const m = (buildAnthropicBody(ctx([png]), setup, { cacheControl: false })["messages"] as { content: Record<string, unknown>[] }[]).at(-1);
    const c = m?.content[0] as { type: string; tool_use_id: string; content: Record<string, unknown>[] };
    assert.equal(c.type, "tool_result");
    assert.deepEqual(c.content[0], { type: "text", text: "out.png: picture" });
    assert.deepEqual(c.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: b64(png.bytes) } });
  });

  test("anthropic: a PDF is a document block, and sound is refused", () => {
    const m = (buildAnthropicBody(ctx([pdf]), setup, { cacheControl: false })["messages"] as { content: Record<string, unknown>[] }[]).at(-1);
    assert.equal(((m?.content[0] as { content: { type: string }[] }).content[1] as { type: string }).type, "document");
    assert.throws(() => buildAnthropicBody(ctx([wav]), setup, { cacheControl: false }), ProviderError);
  });

  test("anthropic: a result without media keeps a plain string", () => {
    const m = (buildAnthropicBody(ctx([]), setup, { cacheControl: false })["messages"] as { content: Record<string, unknown>[] }[]).at(-1);
    assert.equal((m?.content[0] as { content: unknown }).content, "out.png: picture");
  });

  test("openai-responses: function_call_output.output is an array with an input_image", () => {
    const input = buildResponsesBody(ctx([png]), setup, { store: false, replayItemIds: true, chain: false, pruneAtCompaction: true })["input"] as Record<string, unknown>[];
    const o = input.at(-1) as { type: string; output: Record<string, unknown>[] };
    assert.equal(o.type, "function_call_output");
    assert.deepEqual(o.output[0], { type: "input_text", text: "out.png: picture" });
    assert.equal(o.output[1]?.["type"], "input_image");
    assert.match(String(o.output[1]?.["image_url"]), new RegExp(`^data:image/png;base64,${b64(png.bytes)}$`));
    assert.throws(() => buildResponsesBody(ctx([wav]), setup, { store: false, replayItemIds: true, chain: false, pruneAtCompaction: true }), ProviderError);
  });

  test("openai-compatible: a text note in the tool message, then a user message holding the media", () => {
    const msgs = buildChatBody(ctx([png, wav]), setup, { maxTokensParam: "max_tokens", includeUsage: true })["messages"] as { role: string; content: unknown }[];
    const tool = msgs.at(-2) as { role: string; content: string };
    assert.equal(tool.role, "tool");
    assert.match(tool.content, /out\.png: picture/);
    assert.match(tool.content, /2 attachments are in the next message/);
    const user = msgs.at(-1) as { role: string; content: Record<string, unknown>[] };
    assert.equal(user.role, "user");
    assert.match(String(user.content[0]?.["text"]), /From the result of call c1: out\.png/);
    assert.equal(user.content.find((p) => p["type"] === "image_url") !== undefined, true);
    assert.deepEqual(user.content.find((p) => p["type"] === "input_audio"), { type: "input_audio", input_audio: { data: b64(wav.bytes), format: "wav" } });
  });

  test("openai-compatible: a PDF in a result is refused", () => {
    assert.throws(() => buildChatBody(ctx([pdf]), setup, { maxTokensParam: "max_tokens", includeUsage: true }), ProviderError);
  });
});

describe("media in a tool result, for a local dialect", () => {
  test("one marker per item follows the result text, and the items are collected in order", () => {
    const media: AttachmentPart[] = [];
    assert.equal(resultContent({ content: "seen", media: [png, wav] }, "<m>", media), "seen\n<m>\n<m>");
    assert.deepEqual(media, [png, wav]);
  });
  test("a result with no media is unchanged; a PDF or a missing marker is refused", () => {
    assert.equal(resultContent({ content: "seen" }, "<m>", []), "seen");
    assert.throws(() => resultContent({ content: "x", media: [pdf] }, "<m>", []), ProviderError);
    assert.throws(() => resultContent({ content: "x", media: [png] }, undefined, []), ProviderError);
  });
});
