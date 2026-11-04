import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { runLoop, syncTools } from "../../harness/loop.ts";
import { envSource } from "../../harness/secrets.ts";
import { ConfigNotTrusted } from "../../harness/trust.ts";
import { ToolRegistry, type Tool } from "../../harness/tools.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import type { Completed } from "../../providers/types.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const usage = { input_tokens: 1, output_tokens: 1 };
let queue: Completed[] = [];
const adapters = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: z.strictObject({ $tag: z.literal("fake") }),
    settings: z.strictObject({}),
    jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
    secrets: () => [],
    models: () => ({}),
    create: () => ({
      $tag: "fake",
      async *stream() {
        const next = queue.shift();
        if (next === undefined) throw new Error("no reply queued");
        return next;
      },
    }),
  }),
);
const providers = { registry: adapters, secrets: envSource({}) };
const CFG = "providers:\n  f:\n    $tag: fake\ntools:\n  echo:\n    allow: {}\n";
const FUTURE = "2999-01-01";

async function make(config = CFG) {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, { providers, config });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  return { dir, convo };
}
const reopen = (dir: string) => Conversation.open(host, dir, { providers });
const edit = async (dir: string, f: (t: string) => string) => writeFile(join(dir, "harness.yml"), f(await readFile(join(dir, "harness.yml"), "utf8")));
const reply = (blocks: Completed["blocks"], stop: Completed["stop_reason"]): Completed => ({ blocks, stop_reason: stop, usage, observed: { model: "m1" }, ext: {} });

describe("the harness.yml a thread has been approved to use", () => {
  test("a conversation made with a file is approved for it; an edit from outside is not used until it is approved", async () => {
    const { dir, convo } = await make();
    assert.equal((await convo.configTrust()).state, "trusted");
    await convo.close();
    await edit(dir, (t) => t.replace("allow: {}", `allow: {all: ${FUTURE}}`));

    const c = await reopen(dir);
    assert.equal((await c.configTrust()).state, "changed");
    assert.equal(c.providers.size, 0, "no provider is built, so no key is read for a file nobody approved");
    const read = await c.readConfig();
    assert.ok(read !== undefined && !read.ok && /changed outside chattree/.test(read.issues[0]?.message ?? ""));
    assert.equal(await c.grantStore().allow("echo"), undefined, "its grants count for nothing");
    await assert.rejects(c.assertConfigTrusted(), (e: unknown) => e instanceof ConfigNotTrusted && e.trust.state === "changed");
    await assert.rejects(c.grantStore().grant("echo", ["all"], FUTURE, { commit: false }), ConfigNotTrusted);
    await c.close();

    // The same file, approved: it is used.
    const approver = await Conversation.open(host, dir);
    assert.equal((await approver.approveConfig()).state, "trusted");
    await approver.close();
    const again = await reopen(dir);
    assert.equal(again.providers.size, 1);
    assert.deepEqual(await again.grantStore().allow("echo"), { all: FUTURE });
    await again.close();
  });

  test("a clone has approved nothing, and a thread with no harness.yml has nothing to approve", async () => {
    const { dir, convo } = await make();
    await convo.close();
    const copy = join(await tempDir(), "clone");
    execFileSync("git", ["clone", "-q", dir, copy]);
    const c = await Conversation.open(host, copy, { providers });
    assert.equal((await c.configTrust()).state, "unknown");
    assert.equal(c.providers.size, 0);
    await c.close();

    const bare = await Conversation.create(host, join(await tempDir(), "bare"), { providers });
    assert.equal((await bare.configTrust()).state, "trusted");
    await writeFile(join(bare.dir, "harness.yml"), CFG);
    assert.equal((await bare.configTrust()).state, "unknown", "a file that appears later is not approved");
    await bare.close();
  });

  test("what the harness does for the user keeps an approved file approved: grants, undo; an unapproved file stays unapproved", async () => {
    const { dir, convo } = await make();
    await convo.grantStore().grant("echo", ["all"], FUTURE, { commit: true });
    assert.equal((await convo.configTrust()).state, "trusted");
    assert.deepEqual(await convo.grantStore().allow("echo"), { all: FUTURE });
    const before = (await convo.append({ $tag: "user", content: [{ $tag: "text", text: "one" }] })).commit;
    await convo.revokeGrant("echo", undefined, { commit: true });
    assert.equal((await convo.configTrust()).state, "trusted");
    assert.deepEqual(await convo.grantStore().allow("echo"), {});
    // Undo goes back to a file with the grant in it, and that file is approved because the one before it was.
    await convo.rewind(before);
    assert.deepEqual(await convo.grantStore().allow("echo"), { all: FUTURE });
    assert.equal((await convo.configTrust()).state, "trusted");
    // A hand edit, then a revoke: the revoke is not an approval of the hand edit.
    await edit(dir, (t) => `${t}limits:\n  max_turn_usd: 100\n`);
    assert.equal((await convo.configTrust()).state, "changed");
    await convo.revokeGrant("echo", undefined, { commit: false });
    assert.equal((await convo.configTrust()).state, "changed");
    await convo.close();
  });

  test("a new thread, a fork and a subagent start approved when their parent is, and not when the file they start with is not the approved one", async () => {
    const { dir, convo } = await make();
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
    const thread = await convo.newThread("side");
    assert.equal((await thread.configTrust()).state, "trusted");
    assert.equal(thread.providers.size, 1);
    const sub = await convo.spawnSubagent({ brief: "b", callId: "c", name: "sub/one" });
    assert.equal((await (sub.conversation as Conversation).configTrust()).state, "trusted");

    await edit(dir, (t) => `${t}limits:\n  max_turn_usd: 100\n`);
    const fork = await convo.fork(undefined, { name: "fork/hand" });
    assert.equal((await (fork.conversation as Conversation).configTrust()).state, "unknown", "the parent's file is not approved, so neither is the fork's");
    await Promise.all([thread.close(), (sub.conversation as Conversation).close(), (fork.conversation as Conversation).close(), convo.close()]);
  });

  test("a merge keeps the parent approved when the file it ends with is one that was approved, and not otherwise", async () => {
    const { convo } = await make();
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
    const a = (await convo.spawnSubagent({ brief: "a", callId: "a", name: "sub/a" })).conversation as Conversation;
    // The user approves a tool in the child: its file is approved there, and the merge brings it across.
    await a.grantStore().grant("echo", ["all"], FUTURE, { commit: true });
    await convo.finishSubagent(a, { callId: "a", summary: "ok" });
    assert.equal((await convo.configTrust()).state, "trusted");
    assert.deepEqual(await convo.grantStore().allow("echo"), { all: FUTURE });

    const b = (await convo.spawnSubagent({ brief: "b", callId: "b", name: "sub/b" })).conversation as Conversation;
    // A model wrote the file in the child; nobody approved it.
    await writeFile(join(b.dir, "harness.yml"), `${await readFile(join(b.dir, "harness.yml"), "utf8")}limits:\n  max_turn_usd: 1000\n`);
    await convo.finishSubagent(b, { callId: "b", summary: "ok" });
    assert.equal((await convo.configTrust()).state, "changed");
    await Promise.all([a.close(), b.close(), convo.close()]);
  });

  test("a tool that writes harness.yml stops the loop at the next call or request until the user approves", async () => {
    const { dir, convo } = await make();
    const writer: Tool = {
      definition: { name: "echo", description: "writes the config", input_schema: { type: "object", additionalProperties: false, properties: {} } },
      execute: async () => {
        await edit(dir, (t) => t.replace("allow: {}", `allow: {all: ${FUTURE}}`));
        return { content: "done" };
      },
    };
    const registry = new ToolRegistry([writer]);
    await syncTools(convo, registry);
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
    queue = [reply([{ type: "tool_call", call_id: "c1", name: "echo", args: {} }], "tool_use"), reply([{ type: "text", text: "never" }], "end_turn")];
    const events: string[] = [];
    const run = async () => {
      const gen = runLoop(convo, { system: "s", cost: false, registry, approve: async () => ({ allow: true }) });
      for (;;) {
        const n = await gen.next();
        if (n.done) return;
        events.push(n.value.type);
      }
    };
    await assert.rejects(run(), ConfigNotTrusted);
    assert.ok(events.includes("tool.result"), "the call ran; the request after it did not");
    assert.equal(queue.length, 1, "no second request was made");
    await convo.close();
  });
});
