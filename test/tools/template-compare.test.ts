import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { compare, scenarios } from "../../tools/template-compare.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

test("every scenario is a well-formed conversation: calls have JSON arguments and each call has its result before the next turn", () => {
  for (const s of scenarios()) {
    const open = new Set<string>();
    for (const m of s.messages) {
      const calls = (m["tool_calls"] as { id: string; function: { arguments: string } }[] | undefined) ?? [];
      for (const c of calls) {
        assert.doesNotThrow(() => JSON.parse(c.function.arguments), `${s.name}: arguments are JSON`);
        open.add(c.id);
      }
      if (m["role"] === "tool") assert.ok(open.delete(String(m["tool_call_id"])), `${s.name}: a result for a call that was made`);
      if (m["role"] === "user") assert.equal(open.size, 0, `${s.name}: no call is left without a result`);
    }
    assert.equal(open.size, 0, `${s.name}: every call has its result`);
    assert.ok(s.tools.length > 0);
  }
  assert.deepEqual(scenarios().map((s) => s.name), ["one-call", "reasoning-between-calls", "after-final-answer", "nested-schema", "multiline-argument", "error-result", "two-calls-at-once"]);
});

test("saves the template, the prompts and, live, what the model writes; says which reasoning reached the prompt", async () => {
  const server = await HttpFixture.start();
  const out = await tempDir();
  const lines: string[] = [];
  try {
    server.on("/props", { body: JSON.stringify({ chat_template: "{{ messages }}", chat_template_caps: { supports_tools: true } }) });
    // a template that keeps the first reasoning mark only
    server.on("/apply-template", { body: JSON.stringify({ prompt: "<system>MARK-ALPHA record_items(items: {sku: string}[])<assistant>" }) });
    server.on("/completion", { body: JSON.stringify({ content: "<|channel|>analysis<|message|>hm", stop_type: "eos", tokens_predicted: 7, completion_probabilities: [{ token: "<|channel|>" }, { token: "analysis" }] }) });
    await compare(server.base, ["m"], { out, live: true, log: (l) => lines.push(l) });
    const files = await readdir(join(out, "m"));
    for (const f of ["props.json", "chat-template.jinja", "one-call.prompt.txt", "one-call.raw.txt", "one-call.probs.json", "nested-schema.request.json"]) assert.ok(files.includes(f), f);
    assert.equal(await readFile(join(out, "m", "chat-template.jinja"), "utf8"), "{{ messages }}");
    const text = lines.join("\n");
    assert.match(text, /reasoning MARK-ALPHA in the prompt: yes/);
    assert.match(text, /reasoning MARK-BETA in the prompt: NO, dropped/);
    assert.match(text, /the model writes \(greedy, eos, 7 tokens\)/);
    assert.match(text, /its first tokens: "<\|channel\|>" "analysis"/);
    assert.match(text, /record_items\(items: \{sku: string\}\[\]\)/);
  } finally {
    await server.close();
  }
});

test("a template that refuses a scenario is reported, with its error saved, and the rest go on", async () => {
  const server = await HttpFixture.start();
  const out = await tempDir();
  const lines: string[] = [];
  try {
    server.on("/props", { body: "{}" });
    server.on("/apply-template", { status: 500, body: JSON.stringify({ error: { message: "Conversation roles must alternate" } }) });
    await compare(server.base, ["m"], { out, live: false, log: (l) => lines.push(l) });
    assert.equal(lines.filter((l) => /the template refused it \(HTTP 500\).*must alternate/.test(l)).length, scenarios().length);
    assert.ok((await readdir(join(out, "m"))).includes("one-call.error.txt"));
  } finally {
    await server.close();
  }
});
