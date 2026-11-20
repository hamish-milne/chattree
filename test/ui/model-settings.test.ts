import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatFixture } from "../../ui/fixtures/chat.ts";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { formFields, humanize } from "../../ui/model/form-model.ts";
import { activeLevel, withLevel, type Level } from "../../ui/model/levels.ts";
import type { UiIntent } from "../../ui/model/protocol.ts";

const levels: Level[] = [
  { name: "off", settings: { thinking: { type: "disabled" } } },
  { name: "low", settings: { thinking: { type: "adaptive" }, effort: "low" } },
  { name: "high", settings: { thinking: { type: "adaptive" }, effort: "high" } },
];

describe("thinking levels", () => {
  test("the level is the one whose values are all there", () => {
    assert.equal(activeLevel(levels, { max_output_tokens: 1, thinking: { type: "adaptive" }, effort: "high" }), "high");
    assert.equal(activeLevel(levels, { thinking: { type: "disabled" } }), "off");
    assert.equal(activeLevel(levels, { max_output_tokens: 1 }), undefined);
    assert.equal(activeLevel(levels, { effort: "max" }), "custom");
  });

  test("choosing a level replaces what levels set and keeps the rest; none leaves them out", () => {
    const now = { max_output_tokens: 100, temperature: 0.5, thinking: { type: "adaptive" }, effort: "low" };
    assert.deepEqual(withLevel(levels, now, "off"), { max_output_tokens: 100, temperature: 0.5, thinking: { type: "disabled" } });
    assert.deepEqual(withLevel(levels, now, undefined), { max_output_tokens: 100, temperature: 0.5 });
  });

  test("the chat model shows the level and applies one as a single edit", () => {
    const sent: UiIntent[] = [];
    const chat = new ChatModel((i) => sent.push(i));
    chat.apply({ type: "chat.open", state: chatFixture() });
    assert.equal(chat.thinking.value, "medium");
    chat.setThinking("off");
    assert.equal(chat.thinking.value, "off");
    const edit = sent.findLast((i) => i.type === "form.edit");
    assert.ok(edit?.type === "form.edit");
    assert.deepEqual(edit.value["thinking"], { type: "disabled" });
    assert.equal(edit.value["effort"], undefined);
    assert.equal(edit.value["temperature"], 0.7, "the other settings stay");
  });
});

describe("the fields of a settings schema", () => {
  const schema = {
    type: "object",
    required: ["max_output_tokens"],
    properties: {
      max_output_tokens: { type: "integer", minimum: 1, title: "Max output tokens" },
      temperature: { type: "number", minimum: 0, maximum: 1, "x-default": 1 },
      top_k: { type: "integer", "x-advanced": true },
    },
  };
  const spec = { id: "f", title: "t", schema, value: { max_output_tokens: 5, odd: 1 }, issues: [], dirty: false, saveLabel: "Save" };

  test("labels are words, defaults are carried, optional and advanced are known", () => {
    const [tokens, temperature, topK, odd] = formFields(spec).fields;
    assert.equal(tokens?.label, "Max output tokens");
    assert.equal(tokens?.optional, false);
    assert.equal(temperature?.label, "Temperature");
    assert.equal(temperature?.fallback, 1);
    assert.equal(temperature?.optional, true);
    assert.equal(topK?.label, "Top k");
    assert.equal(topK?.advanced, true);
    assert.ok(
      odd?.kind === "raw" && odd.advanced && odd.label === "odd",
      "a key the schema does not know stays as written, out of the way",
    );
  });

  test("humanize", () => {
    assert.equal(humanize("max_output_tokens"), "Max output tokens");
    assert.equal(humanize("reasoning-effort"), "Reasoning effort");
  });
});
