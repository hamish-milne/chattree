import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ThinkSplitter, type Piece } from "../../providers/think-tags.ts";
import { Rng } from "../support/gen.ts";

/** Run the splitter over pieces of input and merge what comes out by kind, in order. */
function split(chunks: string[], opts?: ConstructorParameters<typeof ThinkSplitter>[0]): { reasoning: string; text: string; ended: number; order: string } {
  const s = new ThinkSplitter(opts);
  const all: Piece[] = [...chunks.flatMap((c) => s.push(c)), ...s.end()];
  let reasoning = "";
  let text = "";
  let ended = 0;
  let order = "";
  for (const p of all) {
    if (p.kind === "reasoning_end") ended++;
    else {
      if (p.text === "") continue;
      if (p.kind === "reasoning") reasoning += p.text;
      else text += p.text;
      if (!order.endsWith(p.kind[0] as string)) order += p.kind[0];
    }
  }
  return { reasoning, text, ended, order };
}
const whole = (s: string, opts?: ConstructorParameters<typeof ThinkSplitter>[0]) => split([s], opts);

describe("think tags", () => {
  test("a response that starts with the tag: reasoning, then the answer, with the whitespace around the tags dropped", () => {
    assert.deepEqual(whole("<think>Let me see.</think>\n\nThe answer."), { reasoning: "Let me see.", text: "The answer.", ended: 1, order: "rt" });
    assert.deepEqual(whole("  \n<think>\nhmm\n</think>Done"), { reasoning: "hmm\n", text: "Done", ended: 1, order: "rt" });
  });

  test("a response with no tag is untouched, and the splitter stops looking at the first character that is not the tag", () => {
    assert.deepEqual(whole("Hello <think>not a tag here</think> world"), { reasoning: "", text: "Hello <think>not a tag here</think> world", ended: 0, order: "t" });
    assert.deepEqual(whole("<thought>x</thought>"), { reasoning: "", text: "<thought>x</thought>", ended: 0, order: "t" });
    assert.equal(whole("  leading space kept").text, "  leading space kept");
  });

  test("a tag in the answer after the reasoning is just text", () => {
    assert.deepEqual(whole("<think>a</think>use <think> and </think> tags"), { reasoning: "a", text: "use <think> and </think> tags", ended: 1, order: "rt" });
  });

  test("what looks like the start of a tag at the very end is text; unfinished reasoning is reasoning", () => {
    assert.deepEqual(whole("<thi"), { reasoning: "", text: "<thi", ended: 0, order: "t" });
    assert.deepEqual(whole("<think>still thinking</th"), { reasoning: "still thinking</th", text: "", ended: 0, order: "r" });
    assert.deepEqual(whole("<think>only thoughts</think>"), { reasoning: "only thoughts", text: "", ended: 1, order: "r" });
  });

  test("custom tags, and implicit_open for templates that open the tag in the prompt", () => {
    assert.deepEqual(whole("<reasoning>why</reasoning>so", { open: "<reasoning>", close: "</reasoning>" }), { reasoning: "why", text: "so", ended: 1, order: "rt" });
    assert.deepEqual(whole("thought first</think>\nthen the answer", { open: "<think>", close: "</think>", implicitOpen: true }), { reasoning: "thought first", text: "then the answer", ended: 1, order: "rt" });
    assert.deepEqual(whole("no thinking at all", { open: "<think>", close: "</think>", implicitOpen: true }), { reasoning: "no thinking at all", text: "", ended: 0, order: "r" }, "the documented cost of implicit_open");
  });

  test("the result does not depend on how the text is cut, including inside the tags", () => {
    const rng = new Rng(11);
    const inputs = ["<think>Let me think.</think>\n\nFinal answer.", "  <think>a<b>c</think >d</think>e", "plain answer with </think> inside", "<think>x</think>", "<thi", "<think>", "<think>y</th"];
    for (const input of inputs) {
      const baseline = whole(input);
      for (let i = 0; i < 60; i++) {
        const cuts: string[] = [];
        for (let at = 0; at < input.length; ) {
          const n = 1 + rng.int(6);
          cuts.push(input.slice(at, at + n));
          at += n;
        }
        assert.deepEqual(split(cuts), baseline, JSON.stringify(cuts));
      }
    }
  });
});
