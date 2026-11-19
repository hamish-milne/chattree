import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Bridge } from "../../ui/host/bridge.ts";
import type { UiEvent, UiIntent } from "../../ui/model/protocol.ts";

function rig() {
  const handled: UiIntent[] = [];
  const seen: UiEvent[] = [];
  let emit: (e: UiEvent) => void = () => {};
  const bridge = new Bridge(
    (e) => {
      emit = e;
      return {
        handle: (i) => {
          if (i.type === "chat.stop") throw new Error("boom");
          handled.push(i);
        },
      };
    },
    (e) => seen.push(e),
  );
  const a: UiEvent[] = [];
  const b: UiEvent[] = [];
  return { bridge, handled, seen, a, b, emit: (e: UiEvent) => emit(e) };
}

describe("the bridge between the controller and the webviews", () => {
  test("every open webview gets the events, until it is gone", () => {
    const { bridge, a, b, seen, emit } = rig();
    const detachA = bridge.attach({ post: (e) => a.push(e) });
    bridge.attach({ post: (e) => b.push(e) });
    emit({ type: "settings.open", page: "providers" });
    detachA();
    emit({ type: "chat.banner" });
    assert.deepEqual(
      a.map((e) => e.type),
      ["settings.open"],
    );
    assert.deepEqual(
      b.map((e) => e.type),
      ["settings.open", "chat.banner"],
    );
    assert.equal(seen.length, 2, "the host sees them all");
  });

  test("an intent a webview posted is checked: a good one reaches the controller, a bad one is answered with an error notice", () => {
    const { bridge, handled, b } = rig();
    bridge.attach({ post: (e) => b.push(e) });
    bridge.receive({ type: "ready", view: "chat" });
    bridge.receive({ type: "thread.open" });
    bridge.receive("rm -rf");
    assert.deepEqual(handled, [{ type: "ready", view: "chat" }]);
    assert.deepEqual(
      b.map((e) => e.type),
      ["notice", "notice"],
    );
    assert.ok(b[0]?.type === "notice" && b[0].level === "error" && b[0].message.includes("does not understand"));
  });

  test("a controller that throws is reported, not left to take the host down", () => {
    const { bridge, b } = rig();
    bridge.attach({ post: (e) => b.push(e) });
    bridge.receive({ type: "chat.stop" });
    assert.ok(b[0]?.type === "notice" && b[0].message.includes("chat.stop failed: boom"));
  });
});
