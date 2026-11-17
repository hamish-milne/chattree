import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { streamChunks } from "../../src/stream.ts";

/** A stream of the given chunks that says when it was cancelled. */
function source(chunks: Uint8Array[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

describe("streamChunks", () => {
  test("yields every chunk, and does not cancel a stream that ended", async () => {
    const s = source([Uint8Array.of(1), Uint8Array.of(2, 3)]);
    const got: number[][] = [];
    for await (const c of streamChunks(s.stream)) got.push([...c]);
    assert.deepEqual(got, [[1], [2, 3]]);
    assert.equal(s.cancelled(), false);
  });

  test("a consumer that stops early cancels the stream, so the body is not left unread", async () => {
    const s = source([Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)]);
    for await (const c of streamChunks(s.stream)) {
      assert.deepEqual([...c], [1]);
      break;
    }
    assert.equal(s.cancelled(), true);
  });

  test("a consumer that throws cancels the stream and its own error is the one that comes out", async () => {
    const s = source([Uint8Array.of(1), Uint8Array.of(2)]);
    await assert.rejects(
      (async () => {
        for await (const _ of streamChunks(s.stream)) throw new Error("consumer failed");
      })(),
      /consumer failed/,
    );
    assert.equal(s.cancelled(), true);
  });

  test("a stream that fails is reported as it failed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    await assert.rejects(
      (async () => {
        for await (const _ of streamChunks(stream)) void _;
      })(),
      /connection reset/,
    );
  });
});
