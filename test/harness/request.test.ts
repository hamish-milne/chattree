import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { ChangeNotAllowed, Conversation } from "../../harness/conversation.ts";
import { encodeDefinition, hashDefinition, pinDefinition, type DefinitionSource, type ToolDefinition } from "../../harness/definitions.ts";
import { prepareContext } from "../../harness/request.ts";
import { contextProblems } from "../../harness/context-builder.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const tool = (name: string): ToolDefinition => ({ name, description: name, input_schema: { type: "object" } });
const say = (model: string) => ({ $tag: "assistant" as const, provider: "main", model, blocks: [{ $tag: "text" as const, text: "ok" }], stop_reason: "end_turn" });

async function fresh() {
  const convo = await Conversation.create(host, join(await tempDir(), "c"));
  const run = await pinDefinition("tool", tool("run"), { store: "blob", blobs: convo.store });
  const ext = await pinDefinition("tool", tool("ext"), { store: "external", ref: "tools/ext.json" });
  const instr = await pinDefinition("instructions", "be brief", { store: "blob", blobs: convo.store });
  await convo.setupChange({ model: { provider: "main", id: "gpt-5.4" }, tools: { set: { run, ext } }, instructions: instr });
  return convo;
}
const source = (ext: ToolDefinition = tool("ext")): DefinitionSource => ({
  list: async () => [{ kind: "tool", name: "run", hash: await hashDefinition("tool", tool("run")) }, { kind: "tool", name: "ext", hash: await hashDefinition("tool", ext) }, { kind: "instructions", name: "instructions", hash: await hashDefinition("instructions", "be brief") }],
  get: async (kind, name) => (kind === "tool" && name === "ext" ? encodeDefinition("tool", ext) : undefined),
});

describe("prepareContext", () => {
  test("builds the context from the pinned definitions and the folded setup", async () => {
    const convo = await fresh();
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "hi" }] });
    const { setup, context } = await prepareContext(convo, { system: "sys", source: source() });
    assert.equal(setup.model?.id, "gpt-5.4");
    assert.deepEqual(context.tools.map((t) => t.name), ["ext", "run"]);
    assert.equal(context.instructions, "be brief");
    assert.deepEqual(contextProblems(context), []);
  });

  test("an agent with no model, drift, and an unacknowledged provider change are all refused", async () => {
    const empty = await Conversation.create(host, join(await tempDir(), "e"));
    await assert.rejects(prepareContext(empty, { system: "s" }), /no model/);

    const convo = await fresh();
    await assert.rejects(prepareContext(convo, { system: "s" }), (e) => e instanceof ChangeNotAllowed && /no definition source/.test(e.message));
    await assert.rejects(prepareContext(convo, { system: "s", source: source(tool("changed")) }), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("tools_changed"));

    await convo.appendResponse(say("gpt-5.4-2026-03-05"), { model: "gpt-5.4-2026-03-05" }); // alias resolves: fine
    await prepareContext(convo, { system: "s", source: source() });
    await convo.appendResponse(say("gpt-5.4-2026-09-01"), { model: "gpt-5.4-2026-09-01" }); // a real change
    await assert.rejects(prepareContext(convo, { system: "s", source: source() }), (e) => e instanceof ChangeNotAllowed && /request not allowed/.test(e.message));
    await prepareContext(convo, { system: "s", source: source(), standing: ["resolved_model_changed"] });
  });

  test("reasoning goes only to the model that wrote it, using the dated id after resolution", async () => {
    const convo = await fresh();
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "hi" }] });
    await convo.appendResponse({ ...say("gpt-5.4-2026-03-05"), blocks: [{ $tag: "reasoning", provider: "main", payload: { encrypted: "ENC" } }, { $tag: "text", text: "a" }] }, { model: "gpt-5.4-2026-03-05" });
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "more" }] });
    const { context } = await prepareContext(convo, { system: "s", source: source() });
    const a = context.turns[1];
    assert.ok(a?.role === "assistant" && a.blocks[0]?.type === "reasoning");
  });
});
