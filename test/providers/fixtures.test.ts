import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup } from "../../harness/setup.ts";
import { collectStream, conformanceProblems } from "../../providers/conformance.ts";
import { recordingFetch, replayFetch, scrubText, splitBytes, type Fixture } from "../../providers/fixtures.ts";
import { expand, record } from "../../tools/record-fixture.ts";
import { FakeServer } from "../support/fake-server.ts";
import { HELLO, toyAdapter } from "../support/toy-adapter.ts";
import { Rng } from "../support/gen.ts";

const KEY = "sk-live-VERYSECRET";
const req = () => ({ context: { system: "", instructions: undefined, turns: [], tools: [], cacheHints: [] }, setup: emptySetup(), signal: new AbortController().signal });

describe("recording", () => {
  test("a recorded exchange has no secrets and no account headers, and replays to the same result", async () => {
    const server = await FakeServer.start([{ headers: { "x-request-id": "req_123", "set-cookie": "a=b", "x-custom": `echo ${KEY}` }, acts: HELLO.map((s) => s.replace("toy-1-2026", `toy-${KEY}`)) }]);
    try {
      const fixture = await record({ url: `${server.url}/v1/stream`, headers: { "x-api-key": "${TEST_KEY}", "content-type": "application/json" }, body: { hello: "${TEST_KEY}" } }, { TEST_KEY: KEY });
      const text = JSON.stringify(fixture);
      assert.ok(!text.includes(KEY), "secret scrubbed everywhere");
      assert.deepEqual(Object.keys(fixture.request?.headers ?? {}), ["content-type"]);
      assert.ok(!("x-request-id" in fixture.response.headers) && !("set-cookie" in fixture.response.headers));
      assert.equal(fixture.response.headers["x-custom"], "echo [redacted]");
      assert.equal(fixture.response.status, 200);
      assert.equal(fixture.request?.body, '{"hello":"[redacted]"}');

      const live = await collectStream(toyAdapter(server.url, { retry: { maxAttempts: 1 } }).stream(req()));
      const replayed = await collectStream(toyAdapter("http://none.invalid", { fetch: replayFetch(fixture, [3]) }).stream(req()));
      assert.deepEqual(conformanceProblems(replayed), []);
      assert.equal(replayed.completed?.stop_reason, live.completed?.stop_reason);
      assert.equal(replayed.completed?.blocks.length, live.completed?.blocks.length);
    } finally {
      await server.close();
    }
  });

  test("a fixture replays identically however the bytes are cut", async () => {
    const fixture: Fixture = { version: 1, response: { status: 200, headers: {}, body: HELLO.join("").replace("Hel", "Hé日😀") } };
    const baseline = await collectStream(toyAdapter("http://none.invalid", { fetch: replayFetch(fixture) }).stream(req()));
    assert.deepEqual(conformanceProblems(baseline), []);
    const r = new Rng(11);
    for (let i = 0; i < 60; i++) {
      const sizes = Array.from({ length: 1 + r.int(5) }, () => 1 + r.int(20));
      const run = await collectStream(toyAdapter("http://none.invalid", { fetch: replayFetch(fixture, sizes) }).stream(req()));
      assert.deepEqual(run, baseline, `sizes ${sizes.join(",")}`);
    }
  });

  test("an error status is recorded and replayed like any response", async () => {
    const fixture: Fixture = { version: 1, response: { status: 401, headers: { "content-type": "application/json" }, body: '{"error":"bad key"}' } };
    const run = await collectStream(toyAdapter("http://none.invalid", { fetch: replayFetch(fixture), retry: { maxAttempts: 1 } }).stream(req()));
    assert.deepEqual(conformanceProblems(run), []);
    assert.match(String((run.error as Error).message), /401.*bad key/);
  });

  test("recordingFetch passes the response through untouched while recording", async () => {
    const got: Fixture[] = [];
    const f = recordingFetch(async () => new Response("hello", { status: 202, headers: { "x-a": "1" } }), (x) => void got.push(x));
    const res = await f("http://x.invalid/", { method: "POST", body: "b" });
    assert.equal(await res.text(), "hello");
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(got[0]?.response.body, "hello");
    assert.equal(got[0]?.response.status, 202);
  });
});

describe("helpers", () => {
  test("expand substitutes and reports secrets; a missing variable is an error", () => {
    assert.deepEqual(expand('{"k":"${A}","u":"x${B}"}', { A: "1", B: "2" }), { text: '{"k":"1","u":"x2"}', secrets: ["1", "2"] });
    assert.throws(() => expand("${NOPE}", {}), /NOPE/);
    assert.throws(() => expand("${EMPTY}", { EMPTY: "" }), /EMPTY/);
  });
  test("scrubText and splitBytes", () => {
    assert.equal(scrubText("a SECRET b SECRET", ["SECRET", ""]), "a [redacted] b [redacted]");
    const bytes = new TextEncoder().encode("abcdefghij");
    assert.deepEqual(splitBytes(bytes, [3, 0, 4]).map((c) => new TextDecoder().decode(c)), ["abc", "d", "efgh", "ijk".slice(0, 2)]);
    assert.deepEqual(splitBytes(new Uint8Array(0), [1]), []);
  });
});
