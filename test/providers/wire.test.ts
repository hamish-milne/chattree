import assert from "node:assert/strict";
import { test } from "node:test";
import { messageText, optString, thrownText, wireString } from "../../providers/wire.ts";

test("optString: absent is empty, a string is itself, anything else throws", () => {
  assert.equal(optString(undefined, "x"), "");
  assert.equal(optString(null, "x"), "");
  assert.equal(optString("a", "x"), "a");
  assert.throws(() => optString({}, "item.id"), /item\.id should be a string, not object/);
  assert.throws(() => optString(3, "n"), /not number/);
});

test("wireString: must be a string", () => {
  assert.equal(wireString("a", "x"), "a");
  assert.throws(() => wireString(null, "x"), /not null/);
  assert.throws(() => wireString(undefined, "x"), /not undefined/);
});

test("messageText and thrownText never throw", () => {
  assert.equal(messageText(undefined), "");
  assert.equal(messageText("m"), "m");
  assert.equal(messageText({ a: 1 }), '{"a":1}');
  assert.equal(thrownText(new Error("boom")), "boom");
  assert.equal(thrownText("s"), "s");
  assert.equal(thrownText({ a: 1 }), '{"a":1}');
  assert.equal(thrownText(undefined), "undefined");
});
