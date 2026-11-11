import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { installWireLog } from "../../tools/wire-log.ts";
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
