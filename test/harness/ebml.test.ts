import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trackKinds } from "../../harness/ebml.ts";

/** An EBML element: its id bytes, a size, and its body. `unknown` writes the one-byte "unknown size" a live stream uses. */
const el = (id: number[], body: number[] | Uint8Array, opts: { unknown?: boolean } = {}): number[] => {
  const size = opts.unknown === true ? [0xff] : body.length < 127 ? [0x80 | body.length] : [0x40 | (body.length >> 8), body.length & 0xff];
  return [...id, ...size, ...body];
};
const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...new TextEncoder().encode("webm")]));
const type = (t: number): number[] => el([0xae], [...el([0xd7], [1]), ...el([0x83], [t])]);
const tracks = (...types: number[]): number[] => el([0x16, 0x54, 0xae, 0x6b], types.flatMap(type));
const segment = (body: number[], opts: { unknown?: boolean } = {}): number[] => el([0x18, 0x53, 0x80, 0x67], body, opts);
const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);
const file = (...parts: number[][]): Uint8Array => Uint8Array.from([...EBML_HEADER, ...parts.flat()]);

describe("the track kinds of a WebM or Matroska file", () => {
  test("a sound only, a picture only, and both", () => {
    assert.deepEqual(trackKinds(file(segment(tracks(2)))), { video: false, audio: true });
    assert.deepEqual(trackKinds(file(segment(tracks(1)))), { video: true, audio: false });
    assert.deepEqual(trackKinds(file(segment(tracks(1, 2)))), { video: true, audio: true });
  });

  test("a segment of unknown length (a live recording) is read the same", () => {
    assert.deepEqual(trackKinds(file(segment([...tracks(2), ...cluster], { unknown: true }))), { video: false, audio: true });
  });

  test("elements before the track list are stepped over", () => {
    const seekHead = el([0x11, 0x4d, 0x9b, 0x74], [1, 2, 3, 4, 5]);
    const info = el([0x15, 0x49, 0xa9, 0x66], [9, 9, 9]);
    assert.deepEqual(trackKinds(file(segment([...seekHead, ...info, ...tracks(2)]))), { video: false, audio: true });
  });

  test("the media is not read: a track list that comes after a cluster is not looked for", () => {
    assert.equal(trackKinds(file(segment([...cluster, ...tracks(2)]))), undefined);
  });

  test("no track list, no known type, truncation and plain bytes say nothing", () => {
    assert.equal(trackKinds(file()), undefined);
    assert.equal(trackKinds(file(segment(tracks(17)))), undefined);
    assert.equal(trackKinds(file(segment(tracks(2))).subarray(0, 26)), undefined);
    assert.equal(trackKinds(new Uint8Array(0)), undefined);
    assert.equal(trackKinds(Uint8Array.from([0, 0, 0, 0, 0, 0])), undefined);
    assert.equal(trackKinds(new TextEncoder().encode("hello, this is not a media file")), undefined);
  });
});
