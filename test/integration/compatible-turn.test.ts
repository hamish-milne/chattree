import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { envSource } from "../../harness/secrets.ts";
import { runRequest } from "../../harness/turn.ts";
import { defaultRegistry } from "../../providers/index.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { assertHistoryInvariants } from "../support/history.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ id: "c1", model: "qwen3:4b", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = (p: number, c: number): string => `data: ${JSON.stringify({ id: "c1", model: "qwen3:4b", choices: [], usage: { prompt_tokens: p, completion_tokens: c } })}\n\n`;

test("a conversation drives the Chat Completions adapter through a tool call and back, with costs on and a free local provider", async () => {
  const replies: Reply[] = [
    { acts: [chunk({ reasoning_content: "I should look." }), chunk({ content: "Checking. " }), chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }), chunk({}, "tool_calls"), usage(30, 12), "data: [DONE]\n\n"] },
    { acts: [chunk({ content: "It is 18C." }), chunk({}, "stop"), usage(60, 5), "data: [DONE]\n\n"] },
  ];
  const server = await FakeServer.start(replies);
  try {
    const dir = join(await tempDir(), "c");
    const convo = await Conversation.create(host, dir, {
      providers: { registry: defaultRegistry(), secrets: envSource({}) },
      config: `providers:\n  local:\n    $tag: openai-compatible\n    base_url: ${server.url}/v1\n    pricing: { free: true }\nlimits:\n  max_conversation_usd: 1\n`,
    });
    await convo.setupChange({ model: { provider: "local", id: "qwen3:4b", settings: { max_output_tokens: 256 } } });
    await convo.pinPricing();
    await convo.append({ $tag: "user", content: [{ $tag: "text", text: "Weather in Paris?" }] });

    const first = await runRequest(convo, { system: "You are terse." });
    assert.equal(first.status, "completed");
    const entries = async () => (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const a1 = (await entries()).at(-1);
    assert.equal(a1?.$tag, "assistant");
    if (a1?.$tag !== "assistant") return;
    assert.equal(a1.stop_reason, "tool_use");
    assert.deepEqual(a1.blocks.map((b) => b.$tag), ["reasoning", "text", "tool_call"]);
    assert.deepEqual(a1.usage, { input_tokens: 30, output_tokens: 12 });
    const call = a1.blocks.find((b) => b.$tag === "tool_call");
    assert.equal(call?.$tag === "tool_call" && call.name, "get_weather");

    await convo.append({ $tag: "tool_result", call_id: "call_1", is_error: false, content: "18C and cloudy" });
    const second = await runRequest(convo, { system: "You are terse." });
    assert.equal(second.status, "completed");

    // The second request carried the whole conversation, the assistant's call, and the tool's answer, as Chat Completions messages.
    const sent = JSON.parse(server.seen[1]?.body ?? "") as { messages: { role: string; content?: string | null; tool_calls?: { id: string }[]; tool_call_id?: string }[] };
    assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(sent.messages[2]?.tool_calls?.[0]?.id, "call_1");
    assert.equal(sent.messages[3]?.tool_call_id, "call_1");
    assert.ok(!server.seen[1]?.body.includes("I should look"), "reasoning is not sent back unless asked");

    const ledger = await convo.ledger();
    assert.equal(ledger.conversation.requests, 2);
    assert.equal(ledger.conversation.usd, 0, "a free provider costs nothing");
    assert.equal(ledger.conversation.unpriced, 0);
    await assertHistoryInvariants(convo);
  } finally {
    await server.close();
  }
});
