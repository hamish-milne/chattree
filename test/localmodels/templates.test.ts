import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the gpt-oss template writes past tool calls in harmony's form, once, and not the stock form", async () => {
  const t = await readFile(new URL("../../templates/gpt-oss.jinja", import.meta.url), "utf8");
  assert.equal(t.split('"<|start|>assistant<|channel|>commentary to="').length - 1, 1);
  assert.ok(t.includes('" <|constrain|>"'));
  assert.ok(!t.includes('"<|start|>assistant to="'));
  assert.ok(!t.includes('"<|channel|>commentary "'), "the stock rendering `commentary json` is gone");
  // the rest of the stock template is untouched: results still go back as `functions.x to=assistant`
  assert.ok(t.includes('" to=assistant<|channel|>commentary<|message|>"'));
});
