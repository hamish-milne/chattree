import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  const ac = new AbortController();
  try {
    const post = (body: string) => fetch(`${host.url}intent`, { method: "POST", body });
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post(JSON.stringify({ type: "chat.send" }))).status, 400, "a field is missing");
    assert.equal((await post(JSON.stringify({ type: "chat.stop", extra: 1 }))).status, 400, "a field it does not know");
    assert.deepEqual(handled, [], "the controller saw none of them");
    assert.equal((await post(JSON.stringify({ type: "chat.stop" }))).status, 204);
    assert.deepEqual(handled, [{ type: "chat.stop" }]);

    const events = await fetch(`${host.url}events`, { signal: ac.signal });
    const reader = events.body?.getReader();
    assert.ok(reader);
    await reader.read(); // the comment that opens the stream
    emit?.({ type: "notice", level: "info", message: "hello" });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /^data: \{"type":"notice","level":"info","message":"hello"\}\n\n$/);

    assert.equal(await (await fetch(host.url)).text(), "<p>hi</p>");
    assert.equal((await fetch(`${host.url}..%2Fsecret`)).status, 404);
    assert.equal((await fetch(`${host.url}a/b`)).status, 404);
  } finally {
    ac.abort();
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
