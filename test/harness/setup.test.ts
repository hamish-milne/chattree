import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { ChangeNotAllowed, Conversation, ConversationError, type ConversationEvent, type NewEntry } from "../../harness/conversation.ts";
import { CHANGE_KINDS, type ChatEntry } from "../../harness/entries.ts";
import { foldSetup, inToolLoop, minimizeChange, emptySetup, type Change } from "../../harness/setup.ts";
import { verifyHistory } from "../../harness/verify.ts";
import { faultyHost } from "../support/hosts.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (model = "claude-sonnet-5-5", blocks: Extract<NewEntry, { $tag: "assistant" }>["blocks"] = [{ $tag: "text", text: "ok" }]): Extract<NewEntry, { $tag: "assistant" }> => ({
  $tag: "assistant",
  provider: "anthropic",
  model,
  blocks,
  stop_reason: "end_turn",
});
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", settings: { max_output_tokens: 8000 } };

async function fresh(opts: Parameters<typeof Conversation.create>[2] = {}, h = host) {
  const dir = join(await tempDir(), "conv");
  return { dir, convo: await Conversation.create(h, dir, opts) };
}
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const problems = async (c: Conversation) => (await verifyHistory(c, { deep: true })).map((p) => `${p.severity}:${p.code}`);

describe("folding", () => {
  test("deltas set and remove; the model block is replaced whole; later entries win", () => {
    const e = (v: object): ChatEntry => ({ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", ...v }) as ChatEntry;
    const s = foldSetup([
      e({ model: sonnet, tools: { set: { a: { hash: H1, store: "blob" }, b: { hash: H1, store: "blob" } } } }),
      e({ tools: { set: { a: { hash: H2, store: "external", ref: "x" } }, remove: ["b"] }, instructions: { hash: H1, store: "blob" } }),
      e({ model: { provider: "openai", id: "gpt-5.4" } }),
    ]);
    assert.deepEqual(Object.keys(s.tools), ["a"]);
    assert.equal(s.tools["a"]?.hash, H2);
    assert.deepEqual(s.model, { provider: "openai", id: "gpt-5.4" });
    assert.equal(s.instructions?.hash, H1);
  });

  test("minimizeChange drops what is already in force", () => {
    const base = foldSetup([{ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: sonnet, tools: { set: { a: { hash: H1, store: "blob" } } } }]);
    assert.deepEqual(minimizeChange(base, { model: { ...sonnet }, tools: { set: { a: { hash: H1, store: "blob" } }, remove: ["nope"] } }), {});
    assert.deepEqual(minimizeChange(base, { tools: { set: { a: { hash: H1, store: "blob" }, c: { hash: H2, store: "blob" } } } }), { tools: { set: { c: { hash: H2, store: "blob" } } } });
    assert.deepEqual(minimizeChange(emptySetup(), {}), {});
  });

  test("a fork inherits the fold; a subagent starts from nothing", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet, tools: { set: { a: { hash: H1, store: "blob" } } } });
    await convo.append(user("hi"));
    const fork = await convo.fork();
    assert.deepEqual(await fork.conversation?.setup(), await convo.setup());
    const sub = await convo.spawnSubagent({ brief: "look", callId: "c1" });
    assert.equal((await sub.conversation?.setup())?.model, undefined);
    assert.equal(await sub.conversation?.setupChange({ model: { provider: "anthropic", id: "claude-haiku-5-5" } }, { reason: "subagent" }).then((a) => a?.tag), "agent_setup");
    assert.equal((await sub.conversation?.setup())?.model?.id, "claude-haiku-5-5");
    assert.equal((await convo.setup()).model?.id, "claude-sonnet-5-5", "the parent is unaffected");
    assert.deepEqual(await problems(sub.conversation as Conversation), []);
  });

  test("inToolLoop: a call with no result yet", () => {
    const call: ChatEntry = { $tag: "assistant", id: "01ARZ3NDEKTSV4RRFFQ69G5FA1", provider: "p", model: "m", stop_reason: "tool_use", blocks: [{ $tag: "tool_call", call_id: "c", name: "t", args: {} }] };
    const res: ChatEntry = { $tag: "tool_result", id: "01ARZ3NDEKTSV4RRFFQ69G5FA2", call_id: "c", is_error: false, content: "x" };
    assert.equal(inToolLoop([call]), true);
    assert.equal(inToolLoop([call, res]), false);
    assert.equal(inToolLoop([]), false);
  });
});

describe("setupChange", () => {
  test("the first setup needs no flags; a no-op records nothing", async () => {
    const { convo } = await fresh();
    const a = await convo.setupChange({ model: sonnet, tools: { set: { a: { hash: H1, store: "blob" } } } });
    assert.equal(a?.tag, "agent_setup");
    const n = (await convo.index()).length;
    assert.equal(await convo.setupChange({ model: sonnet }), undefined);
    assert.equal((await convo.index()).length, n);
    await assertHistoryInvariants(convo);
  });

  test("a model change is refused without its flag, and says what would allow it", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    const n = (await convo.index()).length;
    await assert.rejects(convo.setupChange({ model: { provider: "anthropic", id: "claude-opus-5-5" } }), (e) => {
      assert.ok(e instanceof ChangeNotAllowed);
      assert.deepEqual(e.allowWith, ["model_changed"]);
      assert.match(e.message, /claude-sonnet-5-5 to claude-opus-5-5/);
      return true;
    });
    assert.equal((await convo.index()).length, n, "nothing was recorded");
    await convo.setupChange({ model: { provider: "anthropic", id: "claude-opus-5-5" } }, { allow: ["model_changed"] });
    const last = (await entries(convo)).at(-1);
    assert.ok(last?.$tag === "agent_setup" && last.reason === "user");
    assert.deepEqual(last.allow, ["model_changed"]);
    await assert.rejects(convo.setupChange({ model: { provider: "openai", id: "gpt-5.4" } }, { allow: ["model_changed"] }), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("provider_changed"));
  });

  test("settings-only changes are free unless the adapter classifies them", async () => {
    const classify = (from: { model?: { settings?: unknown } }, to: { model?: { settings?: unknown } }): Change[] =>
      JSON.stringify(from.model?.settings) === JSON.stringify(to.model?.settings) ? [] : [{ kind: "cache_break", message: "settings invalidate the cache", estimatedCost: 0.5 }];
    const free = await fresh();
    await free.convo.setupChange({ model: sonnet });
    await free.convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 1 } } });
    const { convo } = await fresh({ classify });
    await convo.setupChange({ model: sonnet });
    await assert.rejects(convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 1 } } }), (e) => e instanceof ChangeNotAllowed && e.changes[0]?.estimatedCost === 0.5);
    await convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 1 } } }, { allow: ["cache_break"] });
  });

  test("tools, instructions and pricing changes are classified", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet, tools: { set: { a: { hash: H1, store: "blob" } } }, instructions: { hash: H1, store: "blob" }, pricing: { table: H1 } });
    const kinds = async (c: Parameters<Conversation["setupChange"]>[0]) =>
      convo.setupChange(c).then(
        () => [],
        (e: unknown) => (e as ChangeNotAllowed).allowWith,
      );
    assert.deepEqual(await kinds({ tools: { set: { a: { hash: H2, store: "blob" } } } }), ["tools_changed"]);
    assert.deepEqual(await kinds({ tools: { remove: ["a"] } }), ["tools_changed"]);
    assert.deepEqual(await kinds({ instructions: { hash: H2, store: "blob" } }), ["instructions_changed"]);
    assert.deepEqual(await kinds({ pricing: { table: H2 } }), ["pricing_changed"]);
    assert.deepEqual(await kinds({ skills: { set: { s: { hash: H1, store: "external", ref: "skills/s" } } } }), ["tools_changed"]);
  });

  test("inside a tool loop any model or tool change also needs mid_loop", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    await convo.append(user("go"));
    await convo.append(reply("claude-sonnet-5-5", [{ $tag: "tool_call", call_id: "c1", name: "run", args: {} }]));
    await assert.rejects(convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 1 } } }), (e) => e instanceof ChangeNotAllowed && e.allowWith.join() === "mid_loop");
    await assert.rejects(convo.setupChange({ model: { provider: "anthropic", id: "x" } }), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("mid_loop") && e.allowWith.includes("model_changed"));
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "ok" });
    await convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 1 } } });
  });

  test("allow can name any kind and is recorded only as far as it was needed", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    await convo.setupChange({ model: { provider: "anthropic", id: "x" } }, { allow: CHANGE_KINDS });
    const last = (await entries(convo)).at(-1);
    assert.ok(last?.$tag === "agent_setup");
    assert.deepEqual(last.allow, ["model_changed"]);
  });
});

describe("responses and provider-observed changes", () => {
  test("without a setup, a response is appended as it is", async () => {
    const { convo } = await fresh();
    const out = await convo.appendResponse(reply("whatever"), { model: "whatever" });
    assert.equal(out.length, 1);
    assert.deepEqual((await convo.checkRequest()).unacknowledged, []);
  });

  test("a response from the model the setup names adds nothing", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    assert.equal((await convo.appendResponse(reply(), { model: "claude-sonnet-5-5" })).length, 1);
  });

  test("an alias resolves once, expectedly, and requests then use the dated model", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: { provider: "openai", id: "gpt-5.4" } });
    const out = await convo.appendResponse({ ...reply(), provider: "openai" }, { model: "gpt-5.4-2026-03-05" });
    assert.deepEqual(out.map((a) => a.tag), ["agent_setup", "assistant"]);
    const [setup, resp] = await entries(convo).then((e) => e.slice(-2));
    assert.ok(setup?.$tag === "agent_setup" && setup.reason === "resolved" && setup.model?.resolved === "gpt-5.4-2026-03-05" && setup.changes === undefined);
    assert.ok(resp?.$tag === "assistant" && resp.model === "gpt-5.4-2026-03-05", "the assistant entry records the served model");
    const s = await convo.checkRequest();
    assert.deepEqual(s.unacknowledged, [], "an alias resolving is not gated");
    // The same model again: nothing to record.
    assert.equal((await convo.appendResponse({ ...reply(), provider: "openai" }, { model: "gpt-5.4-2026-03-05" })).length, 1);
    await assertHistoryInvariants(convo);
  });

  test("a later change is recorded before its response, atomically, gates the next request, and is acknowledged by a mutation", async () => {
    const events: ConversationEvent[] = [];
    const { convo } = await fresh({ onEvent: (e) => void events.push(e) });
    await convo.setupChange({ model: { provider: "openai", id: "gpt-5.4", resolved: "gpt-5.4-2026-03-05" } });
    const out = await convo.appendResponse({ ...reply(), provider: "openai" }, { model: "gpt-5.4-2026-06-01" });
    assert.deepEqual(out.map((a) => a.tag), ["agent_setup", "assistant"]);
    await convo.flushEvents();
    const changed = events.filter((e) => e.type === "setup_changed");
    assert.equal(changed.length, 2, "one for the setup, one for the provider change");
    const provider = changed.at(-1);
    assert.ok(provider?.type === "setup_changed" && provider.value.reason === "provider");
    assert.deepEqual(provider.value.changes, ["resolved_model_changed"]);

    // Recorded as fact; the next request is refused until acknowledged or covered.
    assert.equal((await convo.setup()).model?.resolved, "gpt-5.4-2026-06-01");
    await assert.rejects(convo.checkRequest(), (e) => e instanceof ChangeNotAllowed && e.allowWith.join() === "resolved_model_changed" && /request not allowed/.test(e.message));
    await convo.checkRequest(["resolved_model_changed"]);
    await assert.rejects(convo.setupChange({}, { acknowledges: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] }), ConversationError);
    const ack = await convo.setupChange({}, { acknowledges: [out[0]?.id as string] });
    assert.equal(ack?.tag, "agent_setup");
    assert.deepEqual((await convo.checkRequest()).unacknowledged, []);
    assert.deepEqual(await problems(convo), []);
  });

  test("the adapter's classification is recorded on the provider entry", async () => {
    const classify = (): Change[] => [{ kind: "capability_loss", message: "no tool calls with this model" }];
    const { convo } = await fresh({ classify });
    await convo.setupChange({ model: { provider: "openai", id: "gpt-5.4", resolved: "a" } });
    await convo.appendResponse({ ...reply(), provider: "openai" }, { model: "b" });
    const last = (await entries(convo)).at(-2);
    assert.ok(last?.$tag === "agent_setup");
    assert.deepEqual(last.changes, ["resolved_model_changed", "capability_loss"]);
  });

  test("an unreported model defaults to the response's own", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    assert.equal((await convo.appendResponse(reply("claude-sonnet-5-5"))).length, 1);
  });
});

describe("verification", () => {
  test("a provider change with no response after it is an error; so is an unknown acknowledgement", async () => {
    const { convo } = await fresh();
    await convo.setupChange({ model: sonnet });
    await convo.append({ $tag: "agent_setup", reason: "provider", model: { ...sonnet, resolved: "x" }, changes: [] });
    await convo.append(user("hi"));
    await convo.append({ $tag: "agent_setup", reason: "user", acknowledges: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] });
    assert.deepEqual(await problems(convo), ["error:provider-setup-orphan", "warning:acknowledges-unknown"]);
  });

  test("a flow that starts without a model is flagged (a subagent starts from nothing)", async () => {
    const { convo } = await fresh();
    await convo.append({ $tag: "agent_setup", reason: "user", tools: { set: { a: { hash: H1, store: "blob" } } } });
    assert.deepEqual(await problems(convo), ["warning:setup-incomplete"]);
  });
});

describe("crash safety", () => {
  test("a failure anywhere in appendResponse leaves a consistent conversation, and the setup entry never appears without its response", async () => {
    const run = async (h: ReturnType<typeof faultyHost>) => {
      const f = await fresh({}, h);
      await f.convo.setupChange({ model: { provider: "openai", id: "gpt-5.4", resolved: "a" } });
      return f;
    };
    const probe = faultyHost(host, Infinity);
    const p = await run(probe);
    probe.arm(Infinity);
    const base = probe.ops;
    await p.convo.appendResponse({ ...reply(), provider: "openai" }, { model: "b" });
    const total = probe.ops - base;
    assert.ok(total > 0);
    for (let k = 1; k <= total; k++) {
      const h = faultyHost(host, Infinity);
      const { dir, convo } = await run(h);
      h.arm(k);
      await assert.rejects(convo.appendResponse({ ...reply(), provider: "openai" }, { model: "b" }), (e) => e instanceof Error && /injected fault/.test(e.message));
      const now = Date.now() + 120_000;
      const reopened = await Conversation.open(host, dir, { now: () => now, lock: { staleAfterMs: 1000, timeoutMs: 0 } });
      await assertHistoryInvariants(reopened);
      const tags = (await entries(reopened)).map((e) => e.$tag);
      const setups = tags.filter((t) => t === "agent_setup").length;
      const responses = tags.filter((t) => t === "assistant").length;
      assert.ok(setups - 1 === responses, `sweep ${k}: ${tags.join()}`);
    }
  });
});
