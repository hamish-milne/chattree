import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { runRequest } from "../../harness/turn.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import { ProviderError, type Completed, type StreamEvent } from "../../providers/types.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const say = (t: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text: t }] });
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const textOf = (e: ChatEntry | undefined): string => (e?.$tag === "user" && typeof e.content[0] === "object" && e.content[0].$tag === "text" ? String(e.content[0].text) : "");

let hanging = false;
const registry = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    create: () => ({
      $tag: "fake",
      async *stream(req) {
        const e: StreamEvent = { type: "text.delta", index: 0, text: "partial" };
        yield e;
        if (hanging) await new Promise<void>((_, reject) => req.signal.addEventListener("abort", () => reject(new ProviderError({ kind: "aborted", message: "aborted" })), { once: true }));
        yield { type: "block.done", index: 0, block: { type: "text", text: "done" } };
        return { blocks: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, observed: {}, ext: {} } satisfies Completed;
      },
    }),
  }),
);
const opts = (extra: Record<string, unknown> = {}) => ({ providers: { registry, secrets: envSource({}) }, ...extra });
const CONFIG = "providers:\n  f:\n    $tag: fake\n";

async function pair(extra: Record<string, unknown> = {}) {
  const dir = join(await tempDir(), "c");
  const a = await Conversation.create(host, dir, { ...opts(), config: CONFIG });
  await a.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  await a.append(say("one"));
  const events: ConversationEvent[] = [];
  const b = await Conversation.open(host, dir, opts({ onEvent: (e: ConversationEvent) => void events.push(e), ...extra }));
  return { dir, a, b, events };
}

describe("two handles on one thread", () => {
  test("an append adopts what the other handle wrote instead of failing, and the entries are announced as foreign", async () => {
    const { a, b, events } = await pair();
    await a.append(say("two"));
    await a.append(say("three"));
    await b.append(say("four"));
    await b.flushEvents();
    assert.deepEqual((await entries(b)).slice(-3).map(textOf), ["two", "three", "four"]);
    const foreign = events.filter((e) => e.type === "entry" && e.foreign === true).map((e) => (e.type === "entry" ? textOf(e.value) : ""));
    assert.deepEqual(foreign, ["two", "three"]);
    await a.append(say("five"));
    assert.deepEqual((await entries(a)).slice(-5).map(textOf), ["one", "two", "three", "four", "five"]);
    await assertHistoryInvariants(a);
    assert.equal((await a.index()).length, (await b.index()).length);
  });

  test("sync() returns the other handle's entries once", async () => {
    const { a, b } = await pair();
    await a.append(say("x"));
    await a.append(say("y"));
    assert.deepEqual((await b.sync()).map((f) => textOf(f.value)), ["x", "y"]);
    assert.deepEqual(await b.sync(), []);
  });

  test("watch() yields entries as other handles append, and stops on abort", async () => {
    const { a, b } = await pair();
    const ac = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const f of b.watch({ signal: ac.signal, pollMs: 20 })) {
        seen.push(textOf(f.value));
        if (seen.length === 2) ac.abort();
      }
    })();
    await a.append(say("p"));
    await a.append(say("q"));
    await done;
    assert.deepEqual(seen, ["p", "q"]);
  });

  test("debris that was never committed is not adopted: the handle refuses and says to reopen", async () => {
    const { dir, a, b } = await pair();
    await appendFile(join(dir, "chat.yml"), "- !user\n  id: 01J00000000000000000000000\n  content:\n    - !text\n      text: sneaked in\n");
    await assert.rejects(b.append(say("later")), (e) => e instanceof ConversationError && /changed by something else/.test(e.message));
    await assert.rejects(a.append(say("later")), ConversationError);
    const reopened = await Conversation.open(host, dir, opts());
    await reopened.append(say("after repair"));
    await assertHistoryInvariants(reopened);
  });
});

describe("activity and abort across handles", () => {
  test("idle, then a live request that another handle can see and abort; the owner records what had arrived", async () => {
    const { a, b } = await pair();
    assert.deepEqual(await b.activity(), { state: "idle" });
    hanging = true;
    const running = runRequest(a, { system: "s", cost: false, owner: { pid: 4711, session: "s1" }, abortPollMs: 20 });
    let act = await b.activity();
    for (let i = 0; i < 100 && act.state === "idle"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      act = await b.activity();
    }
    assert.equal(act.state, "request");
    if (act.state !== "request") return;
    assert.deepEqual([act.live, act.provider, act.model, act.owner?.pid, act.owner?.session], [true, "f", "m1", 4711, "s1"]);
    assert.equal(await b.requestAbort(), "requested");
    const r = await running;
    hanging = false;
    assert.equal(r.status, "interrupted");
    if (r.status === "interrupted") assert.equal(r.by, "user");
    assert.deepEqual(await b.activity(), { state: "idle" });
    assert.equal(await b.requestAbort(), "none");
    await b.append(say("after")); // adopts the interrupted entry
    await assertHistoryInvariants(b);
  });

  test("a request whose journal went quiet is stale: abort says so and recoverRequest records it", async () => {
    let clock = Date.now();
    const { a, b } = await pair({ now: () => clock });
    hanging = true;
    const ac = new AbortController();
    const running = runRequest(a, { system: "s", cost: false, abortPollMs: 20, signal: ac.signal });
    for (let i = 0; i < 100 && (await b.activity()).state === "idle"; i++) await new Promise((r) => setTimeout(r, 20));
    clock += 10 * 60_000;
    const act = await b.activity();
    assert.equal(act.state === "request" && act.live, false);
    assert.equal(await b.requestAbort(), "stale");
    hanging = false;
    await b.recoverRequest();
    ac.abort(); // the original process is still alive in this test; its late result must not be committed twice
    await assert.rejects(running, /recovered by another process/);
    assert.deepEqual(await b.activity(), { state: "idle" });
  });
});
