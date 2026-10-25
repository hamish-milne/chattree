import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SseParser, parseSse, type SseEvent } from "../../providers/sse.ts";
import { splitBytes } from "../../providers/fixtures.ts";
import { Rng } from "../support/gen.ts";

const enc = new TextEncoder();
const parse = (chunks: Uint8Array[]): SseEvent[] => {
  const p = new SseParser();
  const out = chunks.flatMap((c) => p.push(c));
  return [...out, ...p.end()];
};
const whole = (text: string): SseEvent[] => parse([enc.encode(text)]);
const ev = (event: string, data: string, id?: string): SseEvent => ({ event, data, id });

describe("SSE parsing", () => {
  test("events, default type, named type, ids", () => {
    assert.deepEqual(whole("data: a\n\nevent: x\nid: 7\ndata: b\n\n"), [ev("message", "a"), ev("x", "b", "7")]);
  });
  test("multi-line data joins with LF; one leading space is dropped; no colon means empty value", () => {
    assert.deepEqual(whole("data: a\ndata:  b\ndata\ndata:c\n\n"), [ev("message", "a\n b\n\nc")]);
  });
  test("comments and unknown fields are ignored; an event without data is not dispatched", () => {
    assert.deepEqual(whole(": ping\n\nretry: 100\nfoo: bar\nevent: x\n\ndata: ok\n\n"), [ev("message", "ok")]);
  });
  test("an empty data line still dispatches", () => {
    assert.deepEqual(whole("data:\n\n"), [ev("message", "")]);
  });
  test("LF, CRLF and CR line endings, mixed", () => {
    assert.deepEqual(whole("data: a\r\n\r\ndata: b\r\rdata: c\n\n"), [ev("message", "a"), ev("message", "b"), ev("message", "c")]);
  });
  test("a BOM at the start is ignored", () => {
    assert.deepEqual(whole("﻿data: a\n\n"), [ev("message", "a")]);
  });
  test("an event cut off by the end of the stream is dropped; a final line without a newline still counts as a line", () => {
    assert.deepEqual(whole("data: a\n\ndata: b"), [ev("message", "a")]);
    assert.deepEqual(whole("data: a\n\ndata: b\n"), [ev("message", "a")]);
  });
  test("the last id persists across events (as the standard's last event id does); an id containing NUL is ignored", () => {
    assert.deepEqual(whole("id: a\ndata: 1\n\ndata: 2\n\n"), [ev("message", "1", "a"), ev("message", "2", "a")]);
    assert.deepEqual(whole("id: a\u0000b\ndata: 1\n\n"), [ev("message", "1", undefined)]);
  });
  test("multi-byte characters survive being split anywhere", () => {
    const text = "data: héllo 日本語 😀\n\n";
    const bytes = enc.encode(text);
    for (let cut = 1; cut < bytes.length; cut++) assert.deepEqual(parse([bytes.subarray(0, cut), bytes.subarray(cut)]), [ev("message", "héllo 日本語 😀")], `cut at ${cut}`);
  });
  test("a CRLF split between its CR and its LF is one line ending", () => {
    assert.deepEqual(parse([enc.encode("data: a\r"), enc.encode("\n\r"), enc.encode("\ndata: b\n\n")]), [ev("message", "a"), ev("message", "b")]);
  });
  test("parseSse reads a byte stream", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield enc.encode("data: a\n");
      yield enc.encode("\ndata: b\n\n");
    }
    const out: SseEvent[] = [];
    for await (const e of parseSse(body())) out.push(e);
    assert.deepEqual(out.map((e) => e.data), ["a", "b"]);
  });
});

describe("chunking property", () => {
  const stream = [
    "﻿: hello\n\n",
    "event: a\r\ndata: one\r\n\r\n",
    "data: 日本\n",
    "data: 😀 two\r\r",
    "id: 9\nevent: b\ndata: x\n\n",
    "data\n\n",
    ": c\n",
    "data: last\n\n",
  ].join("");
  const bytes = enc.encode(stream);
  const expected = whole(stream);

  test("every split into two chunks gives the same events", () => {
    for (let cut = 0; cut <= bytes.length; cut++) assert.deepEqual(parse([bytes.subarray(0, cut), bytes.subarray(cut)]), expected, `cut at ${cut}`);
  });
  test("random chunk sizes, down to single bytes", () => {
    const r = new Rng(7);
    assert.deepEqual(parse(splitBytes(bytes, [1])), expected);
    for (let i = 0; i < 300; i++) {
      const sizes = Array.from({ length: 1 + r.int(8) }, () => 1 + r.int(12));
      assert.deepEqual(parse(splitBytes(bytes, sizes)), expected, `sizes ${sizes.join(",")}`);
    }
  });
});
