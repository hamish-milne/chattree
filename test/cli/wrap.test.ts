import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatEntry } from "../../harness/entries.ts";
import { ansiStyle, formatEntry, wrapText } from "../../cli/output.ts";

const convo = { store: { get: async () => undefined } } as never;
const ULID = "01M5ZQZBAT4KWQGAR3HEVKD8MA";

describe("wrapping to the terminal width", () => {
  test("long lines break at spaces and keep their indentation; short lines, fences and long words are left alone", () => {
    assert.equal(wrapText("one two three four five six", 20), "one two three four\nfive six");
    assert.equal(wrapText("  indented words that are long", 20), "  indented words\n  that are long");
    assert.equal(wrapText("```\nsome code that is far too long for the width\n```", 20), "```\nsome code that is far too long for the width\n```");
    assert.equal(wrapText("short\nlines stay", 20), "short\nlines stay");
    assert.equal(wrapText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b", 20), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nb");
    assert.equal(wrapText("a very long line indeed here", undefined), "a very long line indeed here");
    assert.equal(wrapText("a very long line indeed here", 10), "a very long line indeed here", "a width too narrow to be real is ignored");
  });

  test("an entry wraps inside its indent, and colour is added only when asked for", async () => {
    const user: ChatEntry = { $tag: "user", id: ULID, content: [{ $tag: "text", text: "the quick brown fox jumps over the lazy dog again and again" }] };
    const plain = (await formatEntry(convo, user, { width: 30 })) ?? "";
    assert.equal(plain, "you:\n  the quick brown fox jumps\n  over the lazy dog again and\n  again");
    assert.doesNotMatch(plain, /\x1b/);
    const coloured = (await formatEntry(convo, user, { width: 30, style: ansiStyle })) ?? "";
    assert.match(coloured, /^\x1b\[1m\x1b\[36myou:/);
    assert.ok(coloured.split("\n").slice(1).every((l) => l.length <= 30), "no line is wider than the terminal");
  });

  test("tool lines are dim, and an error result is red, in the history as in the live display", async () => {
    const call: ChatEntry = { $tag: "assistant", id: ULID, provider: "p", model: "m", stop_reason: "tool_use", blocks: [{ $tag: "tool_call", call_id: "c1", name: "read", args: { path: "a.txt" } }] };
    const res: ChatEntry = { $tag: "tool_result", id: ULID, call_id: "c1", is_error: true, content: "no such file" };
    const c = (await formatEntry(convo, call, { style: ansiStyle })) ?? "";
    assert.match(c, /\x1b\[2m→ read a\.txt\x1b\[22m/);
    const r = (await formatEntry(convo, res, { style: ansiStyle })) ?? "";
    assert.match(r, /^\x1b\[31m {2}← failed/);
  });
});
