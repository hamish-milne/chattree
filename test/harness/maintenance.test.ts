import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (n: number): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text: `message ${n}` }] });

async function loose(convo: Conversation): Promise<number> {
  const out = await convo.git.text(["count-objects", "-v"], { readOnly: true });
  return Number(/^count: (\d+)$/m.exec(out)?.[1]);
}

describe("repository maintenance", () => {
  test("loose objects are packed automatically once past the threshold, and history is intact", async () => {
    const events: ConversationEvent[] = [];
    const dir = join(await tempDir(), "c");
    const config = "maintenance: { loose_objects: 40, check_every: 5 }\n";
    const convo = await Conversation.create(host, dir, { config, onEvent: (e) => void events.push(e) });
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      await convo.append(say(i));
      peak = Math.max(peak, await loose(convo));
    }
    await convo.flushEvents();
    const packs = events.filter((e) => e.type === "maintenance");
    assert.ok(packs.length > 0, "maintenance ran");
    assert.ok(peak < 200, `loose objects stayed bounded (peak ${peak})`);
    const e = packs[0] as Extract<ConversationEvent, { type: "maintenance" }>;
    assert.equal(e.report.action, "pack_loose");
    assert.ok(e.report.before.looseObjects > 40 && e.report.after.looseObjects < e.report.before.looseObjects);
    assert.equal((await convo.readEntries()).length, 41);
    assert.deepEqual(await verifyHistory(convo), []);
  });

  test("auto: false leaves the repository alone; maintain() packs on request; a reopened conversation reads fine", async () => {
    const dir = join(await tempDir(), "c");
    const convo = await Conversation.create(host, dir, { config: "maintenance: { auto: false, loose_objects: 5, check_every: 1 }\n" });
    for (let i = 0; i < 10; i++) await convo.append(say(i));
    const before = await loose(convo);
    assert.ok(before > 30);
    const r = await convo.maintain();
    assert.equal(r.action, "pack_loose");
    assert.ok((await loose(convo)) < before / 2);
    const again = await Conversation.open(host, dir);
    assert.equal((await again.readEntries()).length, 11);
  });

  test("many packs are consolidated; queued appends and maintenance do not lose entries", async () => {
    const dir = join(await tempDir(), "c");
    const convo = await Conversation.create(host, dir, { config: "maintenance: { auto: false, packs: 3 }\n" });
    for (let i = 0; i < 6; i++) {
      await convo.append(say(i));
      await convo.git.run(["repack", "-d", "-q"]);
    }
    const stats = async (): Promise<number> => Number(/^packs: (\d+)$/m.exec(await convo.git.text(["count-objects", "-v"], { readOnly: true }))?.[1]);
    assert.ok((await stats()) > 3);
    await Promise.all([convo.maintain(), convo.append(say(100)), convo.append(say(101)), convo.append(say(102))]);
    assert.equal(await stats(), 1);
    const last = await Conversation.open(host, dir);
    assert.equal((await last.readEntries()).length, 1 + 6 + 3);
    assert.deepEqual(await verifyHistory(last), []);
  });
});
