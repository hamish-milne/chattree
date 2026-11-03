import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { ChangeNotAllowed, Conversation, type NewEntry } from "../../harness/conversation.ts";
import { pinDefinition } from "../../harness/definitions.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { prepareContext } from "../../harness/request.ts";
import { skillTool } from "../../harness/skill-tool.ts";
import { coreClassify, foldSetup, pendingAppends, prefixLags } from "../../harness/setup.ts";
import { pinSkill, syncSkills, type SkillScan, type SkillValue } from "../../harness/skills.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", settings: { max_output_tokens: 8000 } };
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({ $tag: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", blocks: [{ $tag: "text", text }], stop_reason: "end_turn" });
const texts = (turns: { role: string; parts?: { type: string; text?: string }[] }[]): string[] => turns.map((t) => `${t.role}:${(t.parts ?? []).map((p) => p.text ?? "").join("|")}`);
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const sk = (name: string, description: string, body = `${name} body`, dir = `.agents/skills/${name}`): SkillValue => ({ name, description, body, dir });
const scanOf = (...skills: SkillValue[]): SkillScan => ({ skills: Object.fromEntries(skills.map((s) => [s.name, s])), problems: [], unreadable: new Set() });

/** A thread with the skill tool pinned (the catalog is shown only to a model that has it), instructions v1 and the given skills in its first setup. */
async function fresh(initial: SkillValue[] = [], opts: { tool?: boolean } = {}) {
  const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
  const pin = async (v: SkillValue) => pinSkill(v, convo.store);
  const skills = Object.fromEntries(await Promise.all(initial.map(async (v) => [v.name, await pin(v)] as const)));
  await convo.setupChange({
    model: sonnet,
    instructions: await pinDefinition("instructions", "v1", { store: "blob", blobs: convo.store }),
    ...(opts.tool === false ? {} : { tools: { set: { skill: await pinDefinition("tool", skillTool().definition, { store: "blob", blobs: convo.store }) } } }),
    ...(initial.length > 0 ? { skills: { set: skills } } : {}),
  });
  return { convo, pin };
}
const talk = async (convo: Conversation): Promise<void> => {
  await convo.append(user("hi"));
  await convo.append(reply("hello"));
};
const prep = (convo: Conversation) => prepareContext(convo, { system: "s", cost: false });
const callSkill = async (convo: Conversation, name: string) => {
  const out = await skillTool().execute({ name }, { signal: new AbortController().signal, callId: "c", workspace: convo.dir, host, blobs: convo.store, setup: () => convo.setup() });
  assert.ok(!("started" in out));
  return out;
};

describe("the catalog", () => {
  test("a catalog line per skill follows the instructions in the prefix", async () => {
    const { convo } = await fresh([sk("pdf", "Work with PDFs"), sk("alpha", "Does\n  alpha things")]);
    await convo.append(user("hi"));
    const { context } = await prep(convo);
    assert.match(context.instructions ?? "", /^v1\n\n\[Skills\]\nA skill is a set of instructions for one kind of task\..*\n- alpha: Does alpha things\n- pdf: Work with PDFs$/s);
  });

  test("no catalog without the skill tool, and none when there are no skills", async () => {
    const without = await fresh([sk("pdf", "d")], { tool: false });
    await without.convo.append(user("hi"));
    assert.equal((await prep(without.convo)).context.instructions, "v1");
    const none = await fresh([]);
    await none.convo.append(user("hi"));
    assert.equal((await prep(none.convo)).context.instructions, "v1");
  });

  test("skills and no instructions: the catalog stands alone", async () => {
    const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
    await convo.setupChange({ model: sonnet, tools: { set: { skill: await pinDefinition("tool", skillTool().definition, { store: "blob", blobs: convo.store }) } }, skills: { set: { a: await pinSkill(sk("a", "d"), convo.store) } } });
    await convo.append(user("hi"));
    assert.match((await prep(convo)).context.instructions ?? "", /^\[Skills\]/);
  });
});

describe("skills are appendable", () => {
  test("before the first request a change goes straight into the prefix", async () => {
    const { convo, pin } = await fresh([sk("a", "first")]);
    await convo.setupChange({ skills: { set: { a: await pin(sk("a", "second")), b: await pin(sk("b", "new")) } } });
    assert.equal(((await entries(convo)).at(-1) as { apply?: string }).apply, "rebuild");
    await convo.append(user("hi"));
    const { context, setup } = await prep(convo);
    assert.match(context.instructions ?? "", /- a: second\n- b: new/);
    assert.equal(prefixLags(setup), false);
    assert.deepEqual(texts(context.turns as never), ["user:hi"]);
  });

  test("after the first request an added skill is appended: no flags, the prefix keeps its catalog, the model is told where", async () => {
    const { convo, pin } = await fresh([sk("a", "first skill")]);
    await talk(convo);
    const entry = await convo.setupChange({ skills: { set: { b: await pin(sk("b", "second\nskill")) } } }); // no allow flags
    assert.equal(entry?.tag, "agent_setup");
    assert.equal(((await entries(convo)).at(-1) as { apply?: string }).apply, "append");
    await convo.append(user("again"));
    const { context, setup } = await prep(convo);
    assert.ok(!(context.instructions ?? "").includes("second"), "the catalog in the prefix is untouched");
    assert.match(context.instructions ?? "", /- a: first skill$/);
    assert.equal(prefixLags(setup), true);
    assert.deepEqual(texts(context.turns as never), ["user:hi", "assistant:", "user:[The skills changed; this overrides the skill list you were given earlier where they differ]\nAdded:\n- b: second skill|again"]);
  });

  test("a changed skill is announced as changed, a removed one as removed; the tool serves the new text and refuses the removed", async () => {
    const { convo, pin } = await fresh([sk("a", "alpha"), sk("b", "beta")]);
    await talk(convo);
    await convo.setupChange({ skills: { set: { a: await pin(sk("a", "alpha v2", "new alpha body")) }, remove: ["b"] } });
    await convo.append(user("again"));
    const { context } = await prep(convo);
    assert.match(context.instructions ?? "", /- a: alpha\n- b: beta/, "the catalog lines stay until a rebuild");
    const notice = texts(context.turns as never).at(-1) ?? "";
    assert.match(notice, /Changed \(call the skill tool again.*\):\n- a: alpha v2\nRemoved \(the skill tool no longer serves these\):\n- b/);
    assert.ok(!notice.includes("Added"));
    const served = await callSkill(convo, "a");
    assert.equal(served.is_error, undefined);
    assert.match(served.content, /^Skill: a\nDirectory: \.agents\/skills\/a \(relative to the workspace\)\..*\n\nnew alpha body$/s);
    const refused = await callSkill(convo, "b");
    assert.equal(refused.is_error, true);
    assert.equal(refused.content, 'there is no skill called "b"; the skills are: a');
  });

  test("an update made while a tool call is open waits for its result", async () => {
    const { convo, pin } = await fresh();
    await convo.append(user("go"));
    await convo.append({ $tag: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stop_reason: "tool_use", blocks: [{ $tag: "tool_call", call_id: "c1", name: "run", args: {} }] });
    await convo.setupChange({ skills: { set: { a: await pin(sk("a", "d")) } } }); // no mid_loop flag: nothing is lost
    await convo.append({ $tag: "tool_result", call_id: "c1", is_error: false, content: "done" });
    const { context } = await prep(convo);
    assert.deepEqual(context.turns.map((t) => t.role), ["user", "assistant", "tool_results", "user"]);
  });

  test("one entry that changes instructions and skills is one append, and both are shown", async () => {
    const { convo, pin } = await fresh([sk("a", "d")]);
    await talk(convo);
    await convo.setupChange({ instructions: await pinDefinition("instructions", "v2", { store: "blob", blobs: convo.store }), skills: { set: { b: await pin(sk("b", "new")) } } });
    assert.equal(((await entries(convo)).at(-1) as { apply?: string }).apply, "append");
    await convo.append(user("x"));
    const { context } = await prep(convo);
    assert.equal((context.instructions ?? "").startsWith("v1"), true);
    const last = (context.turns.at(-1) as { parts: { text: string }[] }).parts.map((p) => p.text);
    assert.match(last[0] ?? "", /^\[Your instructions were updated.*\nv2$/s);
    assert.match(last[1] ?? "", /^\[The skills changed.*\nAdded:\n- b: new$/s);
    assert.equal(last[2], "x");
  });

  test("two updates are shown in order; a skill added and then changed is announced as changed the second time", async () => {
    const { convo, pin } = await fresh([sk("a", "d")]);
    await talk(convo);
    await convo.setupChange({ skills: { set: { b: await pin(sk("b", "v1")) } } });
    await convo.append(user("x"));
    await convo.append(reply("y"));
    await convo.setupChange({ skills: { set: { b: await pin(sk("b", "v2")) } } });
    await convo.append(user("z"));
    const flat = JSON.stringify((await prep(convo)).context.turns);
    assert.ok(flat.indexOf("Added:\\n- b: v1") >= 0 && flat.indexOf("Changed (call the skill tool again") > flat.indexOf("Added:"));
    assert.equal(pendingAppends(await entries(convo)).length, 2);
  });

  test("a rebuild folds the skills into the catalog and drops the notices; it needs cache_break", async () => {
    const { convo, pin } = await fresh([sk("a", "alpha")]);
    await talk(convo);
    await convo.setupChange({ skills: { set: { b: await pin(sk("b", "beta")) }, remove: ["a"] } });
    await assert.rejects(convo.rebuildPrefix(), (e) => e instanceof ChangeNotAllowed && e.allowWith.includes("cache_break") && e.allowWith.includes("instructions_changed"));
    assert.equal(prefixLags(await convo.setup()), true, "a refused rebuild changes nothing");
    await convo.rebuildPrefix({ allow: ["cache_break", "instructions_changed"] });
    const { context, setup } = await prep(convo);
    assert.match(context.instructions ?? "", /- b: beta$/);
    assert.ok(!(context.instructions ?? "").includes("alpha"));
    assert.equal(prefixLags(setup), false);
    assert.deepEqual(texts(context.turns as never), ["user:hi", "assistant:"]);
  });

  test("a compaction folds appended skills into the catalog", async () => {
    const { convo, pin } = await fresh();
    const a = await convo.append(user("one"));
    await convo.append(reply("two"));
    const b = await convo.append(user("three"));
    await convo.setupChange({ skills: { set: { late: await pin(sk("late", "arrived late")) } } });
    await convo.append(reply("four"));
    await convo.setupChange({ skills: { set: { later: await pin(sk("later", "arrived later")) } } });
    assert.equal(pendingAppends(await entries(convo)).length, 2);
    await convo.append({ $tag: "compaction", replaces: { from: a.id, to: b.id }, summary: "we talked" });
    const { context, setup } = await prep(convo);
    assert.match(context.instructions ?? "", /- late: arrived late\n- later: arrived later$/);
    assert.equal(prefixLags(setup), false);
    assert.ok(!JSON.stringify(context.turns).includes("skills changed"));
    assert.deepEqual(pendingAppends(await entries(convo)), []);
  });

  test("a change that loses the cache anyway folds the lagging skills in; one that keeps it leaves them", async () => {
    const { convo, pin } = await fresh([sk("a", "alpha")]);
    await talk(convo);
    await convo.setupChange({ skills: { set: { b: await pin(sk("b", "beta")) } } });
    await convo.setupChange({ model: { provider: "anthropic", id: "claude-haiku-5-5" } }, { allow: ["model_changed", "cache_break"] });
    assert.match((await prep(convo)).context.instructions ?? "", /- b: beta$/);
    const other = await fresh([sk("a", "alpha")]);
    await talk(other.convo);
    await other.convo.setupChange({ skills: { set: { b: await other.pin(sk("b", "beta")) } } });
    await other.convo.setupChange({ model: { ...sonnet, settings: { max_output_tokens: 9000 } } });
    assert.equal(prefixLags(await other.convo.setup()), true);
  });

  test("a skills difference counts as an instructions change to the cache, and MCP stays a tools change", () => {
    const from = foldSetup([{ $tag: "agent_setup", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", reason: "user", model: sonnet } as ChatEntry]);
    const withSkill = { ...from, skills: { a: { hash: "a1".repeat(32), store: "blob" as const } } };
    assert.deepEqual(coreClassify(from, withSkill, { midLoop: false }).map((c) => c.kind), ["instructions_changed"]);
    assert.deepEqual(coreClassify(from, { ...from, mcp: withSkill.skills }, { midLoop: false }).map((c) => c.kind), ["tools_changed"]);
  });

  test("a fork inherits the lag; a subagent's first setup lists the parent's current skills in its own prefix", async () => {
    const { convo, pin } = await fresh([sk("a", "alpha")]);
    await talk(convo);
    await convo.setupChange({ skills: { set: { b: await pin(sk("b", "beta")) } } });
    const fork = await convo.fork();
    assert.equal(prefixLags((await fork.conversation?.setup()) as never), true);
    const sub = await convo.spawnSubagent({ brief: "do it", callId: "c1" });
    const child = sub.conversation as Conversation;
    await convo.copySetupTo(child, "subagent");
    const childSetup = await child.setup();
    assert.deepEqual(Object.keys(childSetup.skills).sort(), ["a", "b"]);
    assert.equal(prefixLags(childSetup), false, "a fresh context starts from a complete first setup");
    // The subagent tool then pins the child's own registry (syncTools); with the skill tool in it the child sees the catalog.
    await child.setupChange({ tools: { set: { skill: await pinDefinition("tool", skillTool().definition, { store: "blob", blobs: child.store }) } } }, { allow: ["tools_changed", "cache_break"] });
    const { context } = await prep(child);
    assert.match(context.instructions ?? "", /- a: alpha\n- b: beta$/);
    assert.ok(!JSON.stringify(context.turns).includes("skills changed"));
    const served = await callSkill(child, "b");
    assert.match(served.content, /b body$/);
  });
});

describe("the skill tool", () => {
  test("an unknown name is an error that lists what exists; no skills says so", async () => {
    const { convo } = await fresh([sk("b", "d"), sk("a", "d")]);
    const r = await callSkill(convo, "nope");
    assert.equal(r.is_error, true);
    assert.equal(r.content, 'there is no skill called "nope"; the skills are: a, b');
    const empty = await fresh();
    assert.equal((await callSkill(empty.convo, "x")).content, 'there is no skill called "x"; no skills are available');
  });

  test("a skill with no directory is served without one; the definition is a plain required-name schema", async () => {
    const { convo } = await fresh([{ name: "inline", description: "d", body: "just text" }]);
    assert.equal((await callSkill(convo, " inline ")).content, "Skill: inline\n\njust text");
    const def = skillTool().definition;
    assert.deepEqual(def.input_schema["required"], ["name"]);
  });

  test("it refuses to run without the setup it serves from", async () => {
    const r = await skillTool().execute({ name: "a" }, { signal: new AbortController().signal, callId: "c", workspace: "/", host });
    assert.ok(!("started" in r) && r.is_error === true);
  });
});

describe("syncSkills", () => {
  test("records added, changed and removed skills as one append, and nothing when the disk matches", async () => {
    const { convo } = await fresh([sk("keep", "k"), sk("edit", "e"), sk("drop", "x")]);
    await talk(convo);
    assert.equal(await syncSkills(convo, scanOf(sk("keep", "k"), sk("edit", "e", "edited body"), sk("new", "n"))).then((d) => JSON.stringify(d)), JSON.stringify({ added: ["new"], changed: ["edit"], removed: ["drop"] }));
    const last = (await entries(convo)).at(-1) as { apply?: string; skills?: { set?: object; remove?: string[] } };
    assert.equal(last.apply, "append");
    assert.deepEqual(last.skills?.remove, ["drop"]);
    assert.deepEqual(Object.keys(last.skills?.set ?? {}).sort(), ["edit", "new"]);
    assert.equal(await syncSkills(convo, scanOf(sk("keep", "k"), sk("edit", "e", "edited body"), sk("new", "n"))), undefined);
  });
});
