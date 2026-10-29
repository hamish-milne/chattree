import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { Journal, JournalBusy, readJournal, RequestSuperseded } from "../../harness/journal.ts";
import { StreamAccumulator } from "../../harness/partial.ts";
import { requestStream, runRequest } from "../../harness/turn.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import { ProviderError, type Completed, type ProviderAdapter, type StreamEvent, type StreamRequest } from "../../providers/types.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";
import { slow, slowOptions } from "../support/slow.ts";

const host = nodeHost();

// ---- a provider whose behaviour each test scripts ---------------------------------------------------------------

type Step = StreamEvent | Error | ((signal: AbortSignal) => Promise<void>);
let steps: Step[] = [];
let ending: Completed = done([{ type: "text", text: "ok" }]);
let retrieve: ProviderAdapter["retrieve"];
let lastRequest: StreamRequest | undefined;

function done(blocks: Completed["blocks"], extra: Partial<Completed> = {}): Completed {
  return { blocks, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, observed: { model: "m1", response_id: "resp_1" }, ext: { store: true }, ...extra };
}
/** Resolves when the request is aborted, rejecting as a provider does. */
const hang: Step = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ProviderError({ kind: "aborted", message: "aborted" })), { once: true }));
const pause = (ms: number): Step => () => new Promise((r) => setTimeout(r, ms));

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
        lastRequest = req;
        for (const s of steps) {
          if (req.signal.aborted) throw new ProviderError({ kind: "aborted", message: "aborted" });
          if (s instanceof Error) throw s;
          if (typeof s === "function") await s(req.signal);
          else yield s;
        }
        return ending;
      },
      retrieve: (r) => (retrieve === undefined ? Promise.resolve(undefined) : retrieve(r)),
    }),
  }),
);

const CONFIG = "providers:\n  f:\n    $tag: fake\n";
const hi: NewEntry = { $tag: "user", content: [{ $tag: "text", text: "hi" }] };
const opts = (extra: Record<string, unknown> = {}) => ({ providers: { registry, secrets: envSource({}) }, ...extra });

async function fresh(config = CONFIG) {
  const dir = join(await tempDir(), "c");
  const events: ConversationEvent[] = [];
  const convo = await Conversation.create(host, dir, { ...opts({ onEvent: (e: ConversationEvent) => void events.push(e) }), config });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  await convo.append(hi);
  steps = [];
  ending = done([{ type: "text", text: "ok" }]);
  retrieve = undefined;
  return { dir, convo, events };
}
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const last = async (c: Conversation): Promise<ChatEntry> => (await entries(c)).at(-1) as ChatEntry;
const exists = (p: string) => stat(p).then(() => true, () => false);
const run = (c: Conversation, o: Record<string, unknown> = {}) => runRequest(c, { system: "s", cost: false, ...o });
const text = (index: number, t: string): StreamEvent[] => [{ type: "text.delta", index, text: t }, { type: "block.done", index, block: { type: "text", text: t } }];

describe("accumulating a stream", () => {
  test("complete blocks, text in progress and a started call are kept; unfinished reasoning is not", () => {
    const a = new StreamAccumulator();
    for (const e of [
      { type: "started" },
      { type: "reasoning.delta", index: 0, text: "hmm" },
      ...text(1, "done text"),
      { type: "text.delta", index: 2, text: "half a sen" },
      { type: "tool_call.start", index: 3, call_id: "c1", name: "read" },
      { type: "tool_call.delta", index: 3, args_delta: '{"pa' },
      { type: "usage", usage: { input_tokens: 4, output_tokens: 1 } },
    ] as StreamEvent[]) a.add(e);
    assert.deepEqual(a.blocks(), [
      { type: "text", text: "done text" },
      { type: "text", text: "half a sen" },
      { type: "tool_call", call_id: "c1", name: "read", args: {}, args_raw: '{"pa' },
    ]);
    assert.equal(a.usage?.input_tokens, 4);
    assert.equal(new StreamAccumulator().hasContent, false);
  });
});

describe("a request", () => {
  test("streams its events, commits the response, and leaves no journal", async () => {
    const { convo } = await fresh();
    steps = [{ type: "started" }, { type: "observed", observed: { model: "m1", response_id: "resp_1" } }, ...text(0, "ok"), { type: "usage", usage: { input_tokens: 10, output_tokens: 5 } }];
    const seen: string[] = [];
    const r = await run(convo, { onEvent: (e: StreamEvent) => void seen.push(e.type) });
    assert.deepEqual(seen, ["started", "observed", "text.delta", "block.done", "usage"]);
    assert.equal(r.status, "completed");
    const e = await last(convo);
    assert.equal(e.$tag, "assistant");
    if (e.$tag !== "assistant") return;
    assert.equal(e.stop_reason, "end_turn");
    assert.deepEqual(e.usage, { input_tokens: 10, output_tokens: 5 });
    assert.deepEqual(e.ext, { response_id: "resp_1", store: true });
    assert.deepEqual(e.blocks, [{ $tag: "text", text: "ok" }]);
    assert.equal(await exists(await convo.journalPath()), false);
    assert.equal(lastRequest?.context.turns.at(-1)?.role, "user", "the model was shown the user's message");
    await assertHistoryInvariants(convo);
  });

  test("the journal holds the request and its events while it runs", async () => {
    const { convo } = await fresh();
    const tip = (await entries(convo)).at(-1) as { id: string };
    steps = [...text(0, "one"), pause(30), ...text(1, "two")];
    const gen = requestStream(convo, { system: "s", cost: false, journal: { flushMs: 1 } });
    await gen.next();
    await gen.next(); // text.delta, block.done of the first block
    await new Promise((r) => setTimeout(r, 20));
    const j = await readJournal(host, await convo.journalPath());
    assert.equal(j?.start.provider, "f");
    assert.equal(j?.start.after, tip.id);
    assert.match(j?.start.context_digest ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(j?.events.map((e) => e.type), ["text.delta", "block.done"]);
    for await (const _ of gen) void _;
    assert.equal(await exists(await convo.journalPath()), false);
  });

  test("a second request on a branch is refused while one is in flight, and nothing is sent for it", async () => {
    const { convo } = await fresh();
    steps = [...text(0, "a"), pause(40)];
    const gen = requestStream(convo, { system: "s", cost: false });
    await gen.next();
    await assert.rejects(run(convo), (e) => e instanceof JournalBusy && e.live);
    for await (const _ of gen) void _;
  });

  test("a model the provider reports differently is recorded with the response", async () => {
    const { convo } = await fresh();
    ending = done([{ type: "text", text: "ok" }], { observed: { model: "m1-2026-10-01", response_id: "r" } });
    const r = await run(convo);
    assert.equal(r.status === "completed" && r.entries.length, 2);
    const es = await entries(convo);
    assert.equal(es.at(-2)?.$tag, "agent_setup");
    assert.equal((es.at(-1) as { model: string }).model, "m1-2026-10-01");
  });
});

describe("a request that ends early", () => {
  test("a provider failure keeps what arrived: whole blocks, text so far, the started call, and the tokens", async () => {
    const { convo } = await fresh();
    steps = [
      ...text(0, "first"),
      { type: "text.delta", index: 1, text: "second, cut" },
      { type: "tool_call.start", index: 2, call_id: "c", name: "ls" },
      { type: "usage", usage: { input_tokens: 7, output_tokens: 3 } },
      new ProviderError({ kind: "network", message: "connection reset" }),
    ];
    const r = await run(convo);
    assert.equal(r.status, "interrupted");
    const e = await last(convo);
    assert.deepEqual(e, { ...e, $tag: "interrupted", by: "error", error: "connection reset", usage: { input_tokens: 7, output_tokens: 3 } });
    if (e.$tag !== "interrupted") return;
    assert.deepEqual(e.partial.map((b) => b.$tag), ["text", "text", "tool_call"]);
    assert.equal(await exists(await convo.journalPath()), false);
    await assertHistoryInvariants(convo);
  });

  test("a failure before anything arrived throws and leaves the transcript as it was", async () => {
    const { convo } = await fresh();
    const before = (await entries(convo)).length;
    steps = [new ProviderError({ kind: "auth", message: "bad key", status: 401 })];
    await assert.rejects(run(convo), (e) => e instanceof ProviderError && e.kind === "auth");
    assert.equal((await entries(convo)).length, before);
    assert.equal(await exists(await convo.journalPath()), false, "so asking again is possible");
  });

  test("the user stops it: text so far is kept as interrupted by the user; before anything arrived it is cancelled", async () => {
    const { convo } = await fresh();
    const ac = new AbortController();
    steps = [{ type: "text.delta", index: 0, text: "partial answ" }, hang];
    const p = run(convo, { signal: ac.signal, onEvent: () => void setTimeout(() => ac.abort(), 5) });
    const r = await p;
    assert.equal(r.status === "interrupted" && r.by, "user");
    const e = await last(convo);
    assert.equal(e.$tag === "interrupted" && e.by, "user");
    assert.equal(e.$tag === "interrupted" && e.error, undefined);

    const ac2 = new AbortController();
    steps = [hang];
    setTimeout(() => ac2.abort(), 5);
    const before = (await entries(convo)).length;
    assert.equal((await run(convo, { signal: ac2.signal })).status, "cancelled");
    assert.equal((await entries(convo)).length, before);
    assert.equal(await exists(await convo.journalPath()), false);
  });

  test("a consumer that stops iterating counts as the user stopping it", async () => {
    const { convo } = await fresh();
    steps = [...text(0, "abc"), hang];
    const gen = requestStream(convo, { system: "s", cost: false });
    await gen.next();
    await gen.next();
    await gen.return(undefined as never);
    const e = await last(convo);
    assert.equal(e.$tag === "interrupted" && e.by, "user");
    assert.equal(e.$tag === "interrupted" && e.partial.length, 1);
    assert.equal(await exists(await convo.journalPath()), false);
  });

  test("the turn's deadline stops it, and harness.yml's max_turn_seconds sets one", async () => {
    const { convo } = await fresh();
    steps = [...text(0, "abc"), hang];
    const r = await run(convo, { deadline: Date.now() + 400 });
    assert.equal(r.status === "interrupted" && r.by, "error");
    const e = await last(convo);
    assert.match(e.$tag === "interrupted" ? (e.error ?? "") : "", /time limit/);

    const { convo: c2 } = await fresh(`${CONFIG}limits:\n  max_turn_seconds: 0.03\n`);
    steps = [hang];
    await assert.rejects(run(c2), (err) => err instanceof ProviderError && err.kind === "timeout");
  });

  test("when the commit fails the journal is kept, so open can still recover the response", async () => {
    const { convo, dir } = await fresh();
    ending = done([{ type: "text", text: "paid for" }]);
    steps = [];
    const real = convo.appendResponse.bind(convo);
    convo.appendResponse = () => Promise.reject(new Error("disk full"));
    await assert.rejects(run(convo), /disk full/);
    convo.appendResponse = real;
    const again = await Conversation.open(host, dir, opts({ journalStaleMs: 0 }));
    assert.equal(again.recovery.journal?.outcome, "completed");
    const e = await last(again);
    assert.equal(e.$tag === "assistant" && e.blocks[0]?.$tag === "text" && e.blocks[0].text, "paid for");
  });
});

// ---- crashes ------------------------------------------------------------------------------------------------------

/** A process that died mid-request: a journal with these events, never discarded, and nothing committed. */
async function crash(convo: Conversation, events: StreamEvent[], extra: { done?: Completed; after?: string | null; torn?: string } = {}): Promise<string> {
  const tip = (await entries(convo)).at(-1) as { id: string };
  const path = await convo.journalPath();
  const j = await Journal.begin(host, path, { provider: "f", model: "m1", setup_digest: "s", context_digest: "c", after: extra.after === null ? undefined : (extra.after ?? tip.id), at: Date.now() }, { heartbeatMs: 0, flushMs: 1 });
  for (const e of events) j.write({ t: "event", e });
  if (extra.done !== undefined) j.write({ t: "done", completed: extra.done });
  await j.abandon();
  if (extra.torn !== undefined) await appendFile(path, extra.torn);
  return path;
}
const reopen = (dir: string, extra: Record<string, unknown> = {}) => Conversation.open(host, dir, opts({ journalStaleMs: 0, ...extra }));

describe("recovery in open", () => {
  test("what arrived becomes an interrupted entry by error, with the tokens, and the journal is deleted", async () => {
    const { convo, dir } = await fresh();
    const path = await crash(convo, [{ type: "started" }, ...text(0, "kept"), { type: "text.delta", index: 1, text: "half" }, { type: "usage", usage: { input_tokens: 9, output_tokens: 2 } }], { torn: '{"t":"event","e":{"type":"text.del' });
    const events: ConversationEvent[] = [];
    const again = await reopen(dir, { onEvent: (e: ConversationEvent) => void events.push(e) });
    assert.equal(again.recovery.journal?.outcome, "interrupted");
    const e = await last(again);
    assert.equal(e.$tag, "interrupted");
    if (e.$tag !== "interrupted") return;
    assert.equal(e.by, "error");
    assert.match(e.error ?? "", /recovered from the journal/);
    assert.deepEqual(e.usage, { input_tokens: 9, output_tokens: 2 });
    assert.deepEqual(e.partial.map((b) => b.$tag === "text" && b.text), ["kept", "half"]);
    assert.equal(await exists(path), false);
    await again.flushEvents();
    assert.ok(events.some((x) => x.type === "recovery" && x.report.journal?.outcome === "interrupted"));
    await assertHistoryInvariants(again);
  });

  test("a journal that saw the stream complete commits the response itself", async () => {
    const { convo, dir } = await fresh();
    await crash(convo, text(0, "all of it"), { done: done([{ type: "text", text: "all of it" }]) });
    const again = await reopen(dir);
    assert.equal(again.recovery.journal?.outcome, "completed");
    const e = await last(again);
    assert.equal(e.$tag, "assistant");
    assert.deepEqual(e.$tag === "assistant" && e.usage, { input_tokens: 10, output_tokens: 5 });
  });

  test("a stored response is retrieved by id; if the provider has forgotten it, or fails, the partial is kept with a note", async () => {
    for (const how of ["found", "gone", "fails"] as const) {
      const { convo, dir } = await fresh();
      retrieve = how === "found" ? async () => done([{ type: "text", text: "full answer" }]) : how === "gone" ? async () => undefined : async () => { throw new Error("network down"); };
      await crash(convo, [{ type: "observed", observed: { response_id: "resp_9" } }, { type: "text.delta", index: 0, text: "full ans" }]);
      const again = await reopen(dir);
      const e = await last(again);
      if (how === "found") {
        assert.equal(again.recovery.journal?.outcome, "retrieved");
        assert.equal(e.$tag === "assistant" && e.blocks[0]?.$tag === "text" && e.blocks[0].text, "full answer");
      } else {
        assert.equal(again.recovery.journal?.outcome, "interrupted");
        assert.match(again.recovery.journal?.note ?? "", how === "gone" ? /no longer has/ : /network down/);
        assert.equal(e.$tag === "interrupted" && e.partial.length, 1);
      }
    }
  });

  test("a process that died after the commit only loses its journal", async () => {
    const { convo, dir } = await fresh();
    const path = await crash(convo, text(0, "x"));
    await convo.appendResponse({ $tag: "assistant", provider: "f", model: "m1", blocks: [{ $tag: "text", text: "x" }], stop_reason: "end_turn" });
    const n = (await entries(convo)).length;
    const again = await reopen(dir);
    assert.equal(again.recovery.journal?.outcome, "already_committed");
    assert.equal((await entries(again)).length, n);
    assert.equal(await exists(path), false);
  });

  test("a journal with nothing in it, or for entries the branch no longer has, is discarded", async () => {
    const a = await fresh();
    const p1 = await crash(a.convo, [{ type: "started" }]);
    assert.equal((await reopen(a.dir)).recovery.journal?.outcome, "discarded");
    assert.equal(await exists(p1), false);
    const b = await fresh();
    await crash(b.convo, text(0, "x"), { after: "01JZZZZZZZZZZZZZZZZZZZZZZZ" });
    const again = await reopen(b.dir);
    assert.equal(again.recovery.journal?.outcome, "discarded");
    assert.match(again.recovery.journal?.note ?? "", /no longer contains/);
    const c = await fresh();
    const bad = await c.convo.journalPath();
    await mkdir(join(bad, ".."), { recursive: true });
    await writeFile(bad, "not json\n");
    assert.equal((await reopen(c.dir)).recovery.journal?.outcome, "discarded");
  });

  test("a recent journal belongs to a request that may still be running, and is left alone", async () => {
    const { convo, dir } = await fresh();
    const path = await crash(convo, text(0, "x"));
    const n = (await entries(convo)).length;
    const again = await Conversation.open(host, dir, opts({ journalStaleMs: 60_000 }));
    assert.equal(again.recovery.journal?.outcome, "in_flight");
    assert.equal((await entries(again)).length, n);
    assert.equal(await exists(path), true);
    await assert.rejects(run(again), (e) => e instanceof JournalBusy && e.live);
  });

  test("an old journal blocks new requests until open has recovered it", async () => {
    const { convo } = await fresh();
    await crash(convo, text(0, "x"));
    await assert.rejects(runRequest(convo, { system: "s", cost: false, journal: {} }), (e) => e instanceof JournalBusy);
  });

  test("a heartbeat keeps a quiet request's journal fresh", async () => {
    const { convo } = await fresh();
    steps = [pause(1500)];
    const p = requestStream(convo, { system: "s", cost: false, journal: { heartbeatMs: 20, flushMs: 5 } }).next();
    let beats = 0;
    for (const deadline = Date.now() + 1000; beats < 2 && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 25));
      beats = ((await readFile(await convo.journalPath(), "utf8").catch(() => "")).match(/"t":"beat"/g) ?? []).length;
    }
    assert.ok(beats >= 2, `only ${beats} heartbeats`);
    await p;
  });
});

describe(slow("crash sweep over the journal"), slowOptions, () => {
  test("a journal cut anywhere recovers to a valid transcript, and a complete one to the response", async () => {
    const src = await fresh();
    const path = await crash(src.convo, [{ type: "started" }, { type: "observed", observed: { response_id: "r" } }, ...text(0, "hello"), { type: "text.delta", index: 1, text: "wor" }, { type: "usage", usage: { input_tokens: 3, output_tokens: 1 } }], { done: done([{ type: "text", text: "hello world" }]) });
    const bytes = await readFile(path);
    const cuts = new Set<number>();
    let at = 0;
    for (const line of bytes.toString("utf8").split("\n").slice(0, -1)) {
      at += Buffer.byteLength(line) + 1;
      cuts.add(at);
      cuts.add(at - 1);
      cuts.add(at - Math.ceil(line.length / 2));
    }
    const outcomes = new Map<string, number>();
    for (const cut of [...cuts].sort((a, b) => a - b)) {
      const { convo, dir } = await fresh();
      retrieve = async () => undefined;
      const p = await crash(convo, [], {});
      await writeFile(p, bytes.subarray(0, cut));
      // the start record's `after` is the source conversation's, so give this one the same by rewriting it
      const text0 = (await readFile(p, "utf8")).replace(/"after":"[^"]*"/, `"after":${JSON.stringify(((await entries(convo)).at(-1) as { id: string }).id)}`);
      await writeFile(p, text0);
      const again = await reopen(dir);
      const o = again.recovery.journal?.outcome ?? "none";
      outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
      const last2 = await last(again);
      if (o === "completed") assert.equal(last2.$tag, "assistant");
      if (o === "interrupted") assert.equal(last2.$tag, "interrupted");
      assert.equal(await exists(p), false, `cut at ${cut}`);
      await assertHistoryInvariants(again);
    }
    assert.ok((outcomes.get("completed") ?? 0) >= 1 && (outcomes.get("interrupted") ?? 0) >= 1 && (outcomes.get("discarded") ?? 0) >= 1, JSON.stringify([...outcomes]));
  });
});

describe("a request whose journal was recovered under it", () => {
  test("it does not write a second outcome: RequestSuperseded hands back the response, and the journal is not recreated", async () => {
    const { convo, dir } = await fresh();
    let release: () => void = () => {};
    steps = [...text(0, "late answer"), () => new Promise<void>((r) => (release = r))];
    ending = done([{ type: "text", text: "late answer" }]);
    const running = run(convo, { journal: { flushMs: 1 } });
    running.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30)); // the host is "suspended": nothing arrives, the journal goes stale
    const other = await reopen(dir); // another process opens the branch and recovers the journal
    assert.equal(other.recovery.journal?.outcome, "interrupted");
    release(); // the first process wakes up and finishes
    await assert.rejects(running, (e) => e instanceof RequestSuperseded && e.completed?.blocks[0]?.type === "text");
    const tags = (await entries(other)).map((e) => e.$tag).slice(-2);
    assert.deepEqual(tags, ["user", "interrupted"], "one outcome, not two");
    assert.equal(await exists(await other.journalPath()), false, "the dead request's late writes did not bring the file back");
    await assertHistoryInvariants(other);
  });

  test("an interrupted outcome is guarded the same way", async () => {
    const { convo, dir } = await fresh();
    let release: () => void = () => {};
    steps = [...text(0, "x"), () => new Promise<void>((r) => (release = r)), new ProviderError({ kind: "network", message: "reset" })];
    const running = run(convo, { journal: { flushMs: 1 } });
    running.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await reopen(dir);
    release();
    await assert.rejects(running, (e) => e instanceof RequestSuperseded && e.completed === undefined);
    assert.equal((await entries(convo)).filter((e) => e.$tag === "interrupted").length, 1, "only the recovered outcome is on disk");
  });
});
