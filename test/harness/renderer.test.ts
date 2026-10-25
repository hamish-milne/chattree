import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { ChangeNotAllowed, Conversation } from "../../harness/conversation.ts";
import { buildContext } from "../../harness/context-builder.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { DEFAULT_RENDERER, builtinRenderers, chattreeEnglishV1, findRenderer, type Renderer } from "../../harness/renderer.ts";
import { prepareContext } from "../../harness/request.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const files = { changed: ["a.md"], added: ["b.md"], discarded: ["c.md"] };
const none = { changed: [], added: [], discarded: [] };

describe("chattree-english-v1 is frozen", () => {
  // Changing any of these strings changes what existing conversations mean to a model. Write a new renderer id instead.
  test("its output is pinned", () => {
    const r = chattreeEnglishV1;
    assert.equal(r.compaction("S"), "[Summary of the earlier conversation]\nS");
    assert.equal(r.forkMerge("S", files), "[A side conversation that branched from this one was merged back]\nS\n[Files: added: b.md; changed: a.md; not kept (conflicted): c.md]");
    assert.equal(r.forkMerge("S", none), "[A side conversation that branched from this one was merged back]\nS");
    assert.equal(r.subagentResult("S", files), "S\n[Files: added: b.md; changed: a.md; not kept (conflicted): c.md]");
    assert.equal(r.subagentResultUnattached("S", none), "[A subagent finished]\nS");
    assert.equal(r.cutOffCall("write"), "[A call to write was cut off before it finished and did not run]");
    assert.equal(r.toolDidNotRun(), "The tool did not run: the conversation was interrupted before it produced a result.");
    assert.equal(r.subagentBrief("B"), "B");
    assert.ok(Object.isFrozen(r));
    assert.equal(builtinRenderers[DEFAULT_RENDERER], r);
  });
});

describe("custom renderers", () => {
  const shout: Renderer = { ...chattreeEnglishV1, compaction: (s) => `RESUME: ${s}`, toolDidNotRun: () => "NOT RUN", cutOffCall: (n) => `CUT ${n}` };
  const entries: ChatEntry[] = [
    { $tag: "user", id: "01ARZ3NDEKTSV4RRFFQ69G0001", content: [{ $tag: "text", text: "a" }] },
    { $tag: "assistant", id: "01ARZ3NDEKTSV4RRFFQ69G0002", provider: "p", model: "m", stop_reason: "tool_use", blocks: [{ $tag: "tool_call", call_id: "c", name: "t", args: {} }] },
    { $tag: "compaction", id: "01ARZ3NDEKTSV4RRFFQ69G0003", replaces: { from: "01ARZ3NDEKTSV4RRFFQ69G0001", to: "01ARZ3NDEKTSV4RRFFQ69G0001" }, summary: "sum" },
    { $tag: "interrupted", id: "01ARZ3NDEKTSV4RRFFQ69G0004", by: "user", partial: [{ $tag: "tool_call", call_id: "d", name: "w", args: {} }] },
  ];

  test("every piece of wording comes from the renderer", async () => {
    const ctx = await buildContext(entries, { system: "s", target: { provider: "p", model: "m" }, renderer: shout });
    const text = JSON.stringify(ctx.turns);
    assert.match(text, /RESUME: sum/);
    assert.match(text, /NOT RUN/);
    assert.match(text, /CUT w/);
    assert.doesNotMatch(text, /Summary of the earlier|did not run|cut off/);
  });

  test("lookup: built-ins always resolve, extras are found, unknown ids say what is known", () => {
    assert.equal(findRenderer(DEFAULT_RENDERER), chattreeEnglishV1);
    assert.equal(findRenderer("shout", { shout }), shout);
    assert.equal(findRenderer(DEFAULT_RENDERER, { shout }), chattreeEnglishV1);
    assert.throws(() => findRenderer("nope", { shout }), /unknown renderer "nope".*shout.*chattree-english-v1/);
  });
});

describe("the renderer in the setup", () => {
  const sonnet = { provider: "main", id: "m" };
  const fresh = async () => Conversation.create(host, join(await tempDir(), "c"));

  test("an agent's first setup records the default explicitly; a later setup does not repeat it", async () => {
    const convo = await fresh();
    await convo.setupChange({ model: sonnet });
    assert.equal((await convo.setup()).renderer, DEFAULT_RENDERER);
    const first = (await convo.readEntries()).at(-1);
    assert.ok(first?.ok && first.value.$tag === "agent_setup" && first.value.renderer === DEFAULT_RENDERER);
    assert.equal(await convo.setupChange({ renderer: DEFAULT_RENDERER }), undefined);
    await convo.setupChange({ model: { ...sonnet, settings: { x: 1 } } });
    const last = (await convo.readEntries()).at(-1);
    assert.ok(last?.ok && last.value.$tag === "agent_setup" && last.value.renderer === undefined);
  });

  test("an explicit renderer on the first setup is kept", async () => {
    const convo = await fresh();
    await convo.setupChange({ model: sonnet, renderer: "shout" });
    assert.equal((await convo.setup()).renderer, "shout");
  });

  test("changing it needs renderer_changed", async () => {
    const convo = await fresh();
    await convo.setupChange({ model: sonnet });
    await assert.rejects(convo.setupChange({ renderer: "chattree-english-v2" }), (e) => e instanceof ChangeNotAllowed && e.allowWith.join() === "renderer_changed");
    await convo.setupChange({ renderer: "chattree-english-v2" }, { allow: ["renderer_changed"] });
    assert.equal((await convo.setup()).renderer, "chattree-english-v2");
  });

  test("prepareContext uses the setup's renderer, and refuses one it does not have", async () => {
    const convo = await fresh();
    await convo.setupChange({ model: sonnet, renderer: "shout" });
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "a" }] });
    await assert.rejects(prepareContext(convo, { system: "s" }), /unknown renderer "shout"/);
    const shout: Renderer = { ...chattreeEnglishV1, compaction: (s) => `RESUME: ${s}` };
    const { context } = await prepareContext(convo, { system: "s", renderers: { shout } });
    assert.equal(context.turns.length, 1);
  });
});
