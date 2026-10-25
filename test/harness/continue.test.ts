import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError } from "../../harness/conversation.ts";
import { chattreeEnglishV1 } from "../../harness/renderer.ts";
import { prepareContext } from "../../harness/request.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const text = (t: string) => [{ $tag: "text" as const, text: t }];

async function interrupted() {
  const convo = await Conversation.create(host, join(await tempDir(), "c"));
  await convo.setupChange({ model: { provider: "main", id: "m" } });
  await convo.append({ $tag: "user", content: text("write a long story") });
  const cut = await convo.interrupt({ by: "error", error: "connection reset", partial: [{ $tag: "text", text: "Once upon a" }] });
  return { convo, cut };
}

describe("continueInterrupted", () => {
  test("appends a plain user message tied to the interrupted entry; the model then sees both", async () => {
    const { convo, cut } = await interrupted();
    const a = await convo.continueInterrupted();
    assert.equal(a.tag, "user");
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const last = entries.at(-1) as { $tag: string; content: { text: string }[] };
    assert.equal(last.$tag, "user");
    assert.equal(last.content[0]?.text, chattreeEnglishV1.continueInterrupted());
    const msg = await convo.git.text(["log", "-1", "--format=%B", a.commit], { readOnly: true });
    assert.match(msg, new RegExp(`Chattree-Continues: ${cut.id}`));
    const p = await prepareContext(convo, { system: "s" });
    const flat = JSON.stringify(p.context.turns);
    assert.ok(flat.includes("Once upon a") && flat.includes("cut off"));
    assert.deepEqual(await verifyHistory(convo), []);
  });

  test("the wording comes from the agent's renderer", async () => {
    const { convo } = await interrupted();
    await convo.setupChange({ renderer: "shout" } as never, { allow: ["renderer_changed", "cache_break"] });
    await convo.continueInterrupted({ renderers: { shout: { ...chattreeEnglishV1, continueInterrupted: () => "GO ON" } } });
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    assert.match(JSON.stringify(entries.at(-1)), /GO ON/);
  });

  test("takes the host's own wording, ignores setup entries after the interruption, and refuses twice or after anything else", async () => {
    const { convo } = await interrupted();
    await convo.setupChange({ model: { provider: "main", id: "m2" } }, { allow: ["model_changed", "cache_break", "cost_increase", "capability_loss", "reasoning_dropped", "context_overflow"] });
    assert.equal((await convo.readEntries()).at(-1)?.ok === true && ((await convo.readEntries()).at(-1) as { value: { $tag: string } }).value.$tag, "agent_setup");
    await convo.continueInterrupted({ instruction: "keep going" });
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    assert.equal(JSON.stringify(entries.at(-1)).includes("keep going"), true);
    await assert.rejects(convo.continueInterrupted(), (e) => e instanceof ConversationError && /nothing to continue/.test(e.message));

    const fresh = await Conversation.create(host, join(await tempDir(), "d"));
    await assert.rejects(fresh.continueInterrupted(), /nothing to continue/);
  });
});
