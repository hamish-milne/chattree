import assert from "node:assert/strict";
import { test } from "node:test";
import { diffBlocks } from "../../ui/controller/diff-blocks.ts";
import type { Block } from "../../ui/model/transcript.ts";

const say = (id: string, markdown = id): Block => ({ type: "assistant", id, markdown, model: "m" });

test("nothing changed is nothing to send", () => {
  assert.deepEqual(diffBlocks([say("a"), say("b")], [say("a"), say("b")]), []);
});

test("new blocks at the end are appended", () => {
  assert.deepEqual(diffBlocks([say("a")], [say("a"), say("b"), say("c")]), [{ type: "chat.append", blocks: [say("b"), say("c")] }]);
  assert.deepEqual(diffBlocks([], [say("a")]), [{ type: "chat.append", blocks: [say("a")] }]);
});

test("a block that kept its id and changed is updated in place", () => {
  assert.deepEqual(diffBlocks([say("a", "one"), say("b")], [say("a", "two"), say("b")]), [{ type: "chat.update", block: say("a", "two") }]);
});

test("what the stream showed is swapped for what was committed, from the first block that differs", () => {
  const live = [say("a"), say("live.text", "par")];
  const done = [say("a"), say("e1.0", "partial"), say("e1.1")];
  assert.deepEqual(diffBlocks(live, done), [{ type: "chat.replace", from: "live.text", blocks: [say("e1.0", "partial"), say("e1.1")] }]);
});

test("blocks that went away are replaced by none", () => {
  assert.deepEqual(diffBlocks([say("a"), say("b")], [say("a")]), [{ type: "chat.replace", from: "b", blocks: [] }]);
});
