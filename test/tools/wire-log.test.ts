import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { installWireLog, tapFetch } from "../../tools/wire-log.ts";
import { HttpFixture } from "../support/http-fixture.ts";
import { tempDir } from "../support/tmp.ts";

test("records chat requests with the raw response, flags the failed ones, and leaves other requests alone", async () => {
  const server = await HttpFixture.start();
  const dir = await tempDir();
  const real = globalThis.fetch;
  try {
    server.on("/v1/chat/completions", { body: 'data: {"error":{"message":"The model produced output that does not match the expected peg-native format"}}\n\n' });
    server.on("/v1/models", { body: "{}" });
    const file = join(dir, "wire.jsonl");
    const flush = installWireLog(file);
    const ok = await fetch(`${server.base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.match(await ok.text(), /peg-native/, "the caller still reads the whole response");
    await fetch(`${server.base}/v1/models`);
    await flush();
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0]?.["n"], lines[0]?.["status"], lines[0]?.["failed"]], [0, 200, true]);
    assert.deepEqual(lines[0]?.["request"], { model: "m", messages: [] });
    assert.match(String(lines[0]?.["response"]), /does not match the expected peg-native format/);
    assert.doesNotMatch(JSON.stringify(lines[0]), /secret/);
  } finally {
    globalThis.fetch = real;
    await server.close();
  }
});

test("a response that is cut off is recorded as far as it came", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"content":"hello"}\n\n');
    setTimeout(() => res.destroy(), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const records: { response: string }[] = [];
  const tap = tapFetch((u) => u.endsWith("/completion"), (r) => void records.push(r));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/completion`, { method: "POST", body: "{}" });
    await res.text().catch(() => undefined);
    await tap.flush();
    assert.equal(records.length, 1);
    assert.match(records[0]!.response, /"content":"hello"/);
    assert.match(records[0]!.response, /the response was cut/);
  } finally {
    tap.restore();
    server.close();
  }
});
