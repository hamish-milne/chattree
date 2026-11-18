import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ChatModel } from "../../ui/model/chat-model.ts";
import { chatFixture } from "../../ui/fixtures/chat.ts";
import { parseFileRef, refLabel } from "../../ui/model/file-ref.ts";
import { toolView } from "../../ui/model/tool-view.ts";
import type { UiIntent } from "../../ui/model/protocol.ts";

describe("file references in a model's text", () => {
  test("a relative path, with an optional line or range", () => {
    assert.deepEqual(parseFileRef("src/net/retry.ts"), { path: "src/net/retry.ts" });
    assert.deepEqual(parseFileRef("src/net/retry.ts#L42"), { path: "src/net/retry.ts", line: 42 });
    assert.deepEqual(parseFileRef("./src/a.ts#L42-L58"), { path: "src/a.ts", line: 42, endLine: 58 });
    assert.deepEqual(parseFileRef("a.ts#L5-9"), { path: "a.ts", line: 5, endLine: 9 });
    assert.deepEqual(parseFileRef("my%20file.md#L2"), { path: "my file.md", line: 2 });
    assert.deepEqual(parseFileRef("a.ts#L9-L3"), { path: "a.ts", line: 9 }, "a backwards range is only its first line");
    assert.deepEqual(parseFileRef("a.ts#section"), { path: "a.ts" }, "another kind of fragment is ignored");
  });

  test("a link to anything else is not a file reference", () => {
    for (const href of [
      "https://x.dev/a.ts",
      "mailto:a@b.c",
      "javascript:alert(1)",
      "#top",
      "//host/a",
      "/etc/passwd",
      "C:\\a.ts",
      "../a.ts",
      "a/../../b.ts",
      "",
      "%E0%A4%A",
    ])
      assert.equal(parseFileRef(href), undefined, href);
  });

  test("the label reads as editors show a place", () => {
    assert.equal(refLabel({ path: "a.ts" }), "a.ts");
    assert.equal(refLabel({ path: "a.ts", line: 4 }), "a.ts:4");
    assert.equal(refLabel({ path: "a.ts", line: 4, endLine: 9 }), "a.ts:4-9");
  });

  test("a tool call's path button opens at the first change", () => {
    const edit = chatFixture().blocks.find((b) => b.type === "tool" && b.name === "edit");
    assert.ok(edit?.type === "tool");
    const v = toolView(edit);
    assert.ok(v.kind === "edit" && v.line !== undefined && v.line >= 1);
  });
});

describe("opening a file from the chat", () => {
  const make = () => {
    const sent: UiIntent[] = [];
    const chat = new ChatModel((i) => sent.push(i));
    chat.apply({ type: "chat.open", state: chatFixture() });
    return { chat, sent };
  };

  test("a click does what the setting says: the current file, or the file after the change", () => {
    const { chat, sent } = make();
    chat.openFile({ path: "src/http.ts", line: 3 }, "abc1234");
    chat.fileClick.value = "after";
    chat.openFile({ path: "src/http.ts", line: 3 }, "abc1234");
    assert.deepEqual(sent, [
      { type: "file.open", thread: chat.thread.value?.name, path: "src/http.ts", line: 3 },
      { type: "file.open", thread: chat.thread.value?.name, path: "src/http.ts", line: 3, at: "abc1234" },
    ]);
  });

  test("a block with no commit yet can only be opened as it is now", () => {
    const { chat, sent } = make();
    chat.openFile({ path: "a.ts" }, undefined, "after");
    assert.equal(sent[0]?.type === "file.open" && sent[0].at, undefined);
  });

  test("the menu opens on a reference and closes when a choice is made", () => {
    const { chat } = make();
    chat.openFileMenu({ path: "a.ts" }, "abc1234", 10, 20);
    assert.deepEqual(chat.fileMenu.value?.ref, { path: "a.ts" });
    chat.openFile({ path: "a.ts" }, "abc1234", "current");
    assert.equal(chat.fileMenu.value, undefined);
  });
});
