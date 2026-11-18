import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startWebHost } from "../../ui/host/web-host.ts";
import type { UiEvent, UiIntent } from "../../ui/model/protocol.ts";

test("the web host checks intents from the page, sends events as they happen and serves only plain files of its directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-host-"));
  await writeFile(join(dir, "index.html"), "<p>hi</p>");
  const handled: UiIntent[] = [];
  let emit: ((e: UiEvent) => void) | undefined;
  const host = await startWebHost({
    dir,
    controller: (e) => {
      emit = e;
      return { handle: (i) => handled.push(i) };
    },
  });
  try {
    const ws = new WebSocket(host.url.replace("http", "ws") + "ws", { headers: { origin: host.url.slice(0, -1) } });
    const received: UiEvent[] = [];
    ws.on("message", (d) => received.push(JSON.parse(String(d)) as UiEvent));
    await once(ws, "open");
    const sendAndWait = async (text: string, count: number): Promise<void> => {
      ws.send(text);
      for (let i = 0; i < 100 && received.length < count; i++) await new Promise((r) => setTimeout(r, 10));
    };
    await sendAndWait("not json", 1);
    await sendAndWait(JSON.stringify({ type: "chat.send" }), 2);
    await sendAndWait(JSON.stringify({ type: "chat.stop", extra: 1 }), 3);
    assert.deepEqual(
      received.map((e) => e.type === "notice" && e.level),
      ["error", "error", "error"],
      "each is refused with a notice",
    );
    assert.deepEqual(handled, [], "the controller saw none of them");
    ws.send(JSON.stringify({ type: "chat.stop" }));
    for (let i = 0; i < 100 && handled.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(handled, [{ type: "chat.stop" }]);

    emit?.({ type: "notice", level: "info", message: "hello" });
    for (let i = 0; i < 100 && received.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(received.at(-1), { type: "notice", level: "info", message: "hello" });
    ws.close();

    // Another origin (a web page the person happens to have open) is turned away.
    const stranger = new WebSocket(host.url.replace("http", "ws") + "ws", { headers: { origin: "http://evil.example" } });
    const refused: unknown[] = await once(stranger, "error");
    assert.match(String(refused[0]), /403/);

    assert.equal(await (await fetch(host.url)).text(), "<p>hi</p>");
    assert.equal((await fetch(`${host.url}..%2Fsecret`)).status, 404);
    assert.equal((await fetch(`${host.url}a/b`)).status, 404);
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
