import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { entrySpends } from "../../harness/ledger.ts";
import { runLoop, syncTools } from "../../harness/loop.ts";
import { ToolRegistry, type Tool } from "../../harness/tools.ts";
import { envSource } from "../../harness/secrets.ts";
import { AdapterRegistry, defineAdapter } from "../../providers/registry.ts";
import type { Completed } from "../../providers/types.ts";
import { strictObject } from "../../src/validate.ts";
import { mapEntries } from "../../ui/controller/map-chat.ts";
import { parseEvent } from "../../ui/model/protocol.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const queue: Completed[] = [];
const usage = { input_tokens: 10, output_tokens: 5 };
const adapters = new AdapterRegistry().register(
  defineAdapter({
    $tag: "fake",
    config: strictObject({ $tag: Type.Literal("fake") }),
    settings: strictObject({}),
    secrets: () => [],
    models: () => ({}),
    create: () => ({
      $tag: "fake",
      // oxlint-disable-next-line require-yield -- a reply is returned whole
      async *stream() {
        const next = queue.shift();
        if (next === undefined) throw new Error("the test queued no reply");
        return next;
      },
      retrieve: () => Promise.resolve(undefined),
    }),
  }),
);

const noArgs = { type: "object", additionalProperties: false, properties: {} };
const echo: Tool = {
  definition: { name: "echo", description: "echoes", input_schema: noArgs },
  execute: (_a, ctx) => Promise.resolve({ content: `echo ${ctx.callId}` }),
};

test("a real conversation, read back from git with its commits, maps to blocks the view accepts, each anchored on a commit that holds its entry", async () => {
  const dir = join(await tempDir(), "c");
  const convo = await Conversation.create(host, dir, {
    providers: { registry: adapters, secrets: envSource({}) },
    config: "providers:\n  f:\n    $tag: fake\n",
  });
  await convo.setupChange({ model: { provider: "f", id: "m1", settings: {} } });
  const registry = new ToolRegistry([echo]);
  await syncTools(convo, registry);
  await convo.append({ $tag: "user", content: [{ $tag: "text", text: "go" }] });
  queue.push(
    {
      blocks: [
        { type: "text", text: "Calling." },
        { type: "tool_call", call_id: "c1", name: "echo", args: {} },
      ],
      stop_reason: "tool_use",
      usage,
      observed: { model: "m1" },
      ext: {},
    },
    { blocks: [{ type: "text", text: "All done." }], stop_reason: "end_turn", usage, observed: { model: "m1" }, ext: {} },
  );
  const gen = runLoop(convo, { system: "s", cost: false, registry });
  while (!(await gen.next()).done) {
    /* drain */
  }

  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const refs = await convo.index();
  assert.equal(refs.length, entries.length);
  const items = entries.map((entry, i) => ({ entry, ref: refs[i]! }));
  const spends = await entrySpends(entries, convo.priceResolver());
  const blocks = await mapEntries(items, { blob: (s) => convo.store.get(s) }, { spends });

  const parsed = parseEvent({ type: "chat.append", blocks });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["notice", "notice", "user", "assistant", "tool", "assistant", "turn_end"],
  );
  const tool = blocks.find((b) => b.type === "tool");
  assert.ok(tool?.type === "tool" && tool.status === "ok" && tool.result?.text === "echo c1");
  // Without a price the turn says so, rather than showing zero.
  const end = blocks.at(-1);
  assert.ok(end?.type === "turn_end" && end.unpriced === true && end.usage?.input === 20);
  // Every anchor is a commit of this branch.
  const commits = new Set(refs.map((r) => r.commit));
  for (const b of blocks) assert.ok(b.commit !== undefined && commits.has(b.commit), `${b.type} ${b.id}`);
});
