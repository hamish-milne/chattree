import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import { pinDefinition } from "../../harness/definitions.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { canonicalInstructionPath, InstructionFileError } from "../../harness/instruction-files.ts";
import { prepareContext } from "../../harness/request.ts";
import { foldSetup, pendingAppends, prefixLags } from "../../harness/setup.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", settings: { max_output_tokens: 8000 } };
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });
const reply = (text: string): NewEntry => ({
  $tag: "assistant",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  blocks: [{ $tag: "text", text }],
  stop_reason: "end_turn",
});
const entries = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
const prep = (c: Conversation) => prepareContext(c, { system: "s", cost: false });
const put = async (c: Conversation, path: string, text: string) => {
  await mkdir(dirname(join(c.dir, path)), { recursive: true });
  await writeFile(join(c.dir, path), text);
};

async function fresh() {
  const convo = await Conversation.create(host, join(await tempDir(), "c"), {});
  await convo.setupChange({
    model: sonnet,
    instructions: await pinDefinition("instructions", "base", { store: "blob", blobs: convo.store }),
  });
  return convo;
}

describe("paths", () => {
  test("a relative path has one spelling and cannot leave the repository", () => {
    assert.equal(canonicalInstructionPath("./docs//a.md"), "docs/a.md");
    assert.equal(canonicalInstructionPath("docs\\a.md"), "docs/a.md");
    assert.throws(() => canonicalInstructionPath("../x.md"), InstructionFileError);
    assert.throws(() => canonicalInstructionPath("a/../../x.md"), InstructionFileError);
    assert.throws(() => canonicalInstructionPath("./"), InstructionFileError);
  });
  test("an absolute path is kept", () => {
    assert.equal(canonicalInstructionPath("/etc/team//rules.md"), "/etc/team/rules.md");
    assert.equal(canonicalInstructionPath("C:\\team\\rules.md"), "C:/team/rules.md");
  });
});

describe("instruction files", () => {
  test("the files follow the instructions in order of path, whatever order they were added in", async () => {
    const convo = await fresh();
    await put(convo, "b.md", "second");
    await put(convo, "a.md", "first");
    await convo.setInstructionFiles({ "b.md": {} });
    await convo.setInstructionFiles({ "a.md": {} });
    await convo.append(user("hi"));
    const { context } = await prep(convo);
    assert.equal(context.instructions, "base\n\n[Instructions from the file a.md]\nfirst\n\n[Instructions from the file b.md]\nsecond");
  });

  test("the transcript holds only hashes, null removes, and what is not mentioned stays", async () => {
    const convo = await fresh();
    await put(convo, "a.md", "A");
    await put(convo, "b.md", "B");
    await convo.setInstructionFiles({ "a.md": {}, "b.md": {} });
    await convo.setInstructionFiles({ "a.md": null });
    const es = await entries(convo);
    const files = es.flatMap((e) => (e.$tag === "agent_setup" && e.files !== undefined ? [e.files] : []));
    assert.equal(files.length, 2);
    assert.deepEqual(Object.keys(files[0] ?? {}).sort(), ["a.md", "b.md"]);
    assert.deepEqual(files[1], { "a.md": null });
    assert.deepEqual(Object.keys(foldSetup(es).files), ["b.md"]);
    // The same change again writes nothing.
    assert.equal(await convo.setInstructionFiles({ "a.md": null }), undefined);
    assert.equal(await convo.setInstructionFiles({ "b.md": {} }), undefined);
  });

  test("a file the host passes in is kept as a blob, and must come with its content", async () => {
    const convo = await fresh();
    await assert.rejects(convo.setInstructionFiles({ "/etc/team/rules.md": {} }), ConversationError);
    await convo.setInstructionFiles({ "/etc/team/rules.md": { bytes: new TextEncoder().encode("team rules") } });
    await convo.append(user("hi"));
    assert.match((await prep(convo)).context.instructions ?? "", /\[Instructions from the file \/etc\/team\/rules\.md\]\nteam rules$/);
    // It is not looked for in the repository, so nothing is recorded for it later.
    assert.equal((await convo.syncInstructionFiles()).entry, undefined);
  });

  test("a file that is missing, too large or not text is refused", async () => {
    const convo = await fresh();
    await assert.rejects(convo.setInstructionFiles({ "nope.md": {} }), /there is no file nope\.md/);
    await put(convo, "big.md", "x".repeat(300_000));
    await assert.rejects(convo.setInstructionFiles({ "big.md": {} }), /at most/);
    await writeFile(join(convo.dir, "bin.md"), new Uint8Array([0xff, 0xfe, 0x00, 0xc3]));
    await assert.rejects(convo.setInstructionFiles({ "bin.md": {} }), /not text/);
  });

  test("a change to a file in the repository is recorded once, and shown where it was made while the prefix keeps its text", async () => {
    const convo = await fresh();
    await put(convo, "a.md", "v1");
    await convo.setInstructionFiles({ "a.md": {} });
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    assert.equal((await convo.syncInstructionFiles()).entry, undefined);
    await put(convo, "a.md", "v2");
    const { entry } = await convo.syncInstructionFiles();
    assert.ok(entry !== undefined);
    assert.equal((await convo.syncInstructionFiles()).entry, undefined);
    const es = await entries(convo);
    const last = es.findLast((e) => e.$tag === "agent_setup");
    assert.equal(last?.$tag === "agent_setup" ? last.apply : undefined, "append");
    assert.equal(pendingAppends(es).length, 1);
    assert.ok(prefixLags(foldSetup(es)));
    await convo.append(user("again"));
    const { context } = await prep(convo);
    assert.match(context.instructions ?? "", /\[Instructions from the file a\.md\]\nv1$/);
    const shown = context.turns.flatMap((t) => (t.role === "user" ? t.parts : [])).flatMap((p) => (p.type === "text" ? [p.text] : []));
    assert.ok(
      shown.some((t) => /Updated instructions from the file a\.md\]\nv2/.test(t)),
      JSON.stringify(shown),
    );
  });

  test("before the first request a change goes straight into the prefix", async () => {
    const convo = await fresh();
    await put(convo, "a.md", "v1");
    await convo.setInstructionFiles({ "a.md": {} });
    await put(convo, "a.md", "v2");
    await convo.syncInstructionFiles();
    await convo.append(user("hi"));
    const es = await entries(convo);
    assert.equal(pendingAppends(es).length, 0);
    assert.match((await prep(convo)).context.instructions ?? "", /a\.md\]\nv2$/);
  });

  test("a file deleted from the repository is removed, and the model is told", async () => {
    const convo = await fresh();
    await put(convo, "a.md", "v1");
    await convo.setInstructionFiles({ "a.md": {} });
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await rm(join(convo.dir, "a.md"));
    await convo.syncInstructionFiles();
    assert.deepEqual(foldSetup(await entries(convo)).files, {});
    await convo.append(user("again"));
    const shown = (await prep(convo)).context.turns
      .flatMap((t) => (t.role === "user" ? t.parts : []))
      .flatMap((p) => (p.type === "text" ? [p.text] : []));
    assert.ok(shown.some((t) => /The file a\.md was removed/.test(t)));
  });

  test("rebuilding the prefix folds the change in, in order of path", async () => {
    const convo = await fresh();
    await put(convo, "a.md", "v1");
    await convo.setInstructionFiles({ "a.md": {} });
    await convo.append(user("hi"));
    await convo.append(reply("hello"));
    await put(convo, "a.md", "v2");
    await put(convo, "0.md", "zero");
    await convo.setInstructionFiles({ "0.md": {} });
    await convo.syncInstructionFiles();
    await convo.rebuildPrefix({ allow: ["cache_break", "instructions_changed"] });
    await convo.append(user("again"));
    assert.equal(
      (await prep(convo)).context.instructions,
      "base\n\n[Instructions from the file 0.md]\nzero\n\n[Instructions from the file a.md]\nv2",
    );
  });
});
