import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BlobData,
  BlobError,
  BlobRef,
  EmitError,
  MemoryBlobStore,
  TEXT_MIME,
  emitEntry,
  externalize,
  fromPlain,
  parseEntry,
  resolve,
  sha256Hex,
  valueEquals,
  type Value,
} from "../../src/index.ts";
import { cp } from "../support/gen.ts";

const entry = (o: unknown) => fromPlain(o) as Map<string, Value>;
const externalizeMap = async (...args: Parameters<typeof externalize>) => (await externalize(...args)) as Map<string, Value>;

describe("sha256Hex", () => {
  test("known test vector", async () => {
    assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("externalize", () => {
  test("threshold is measured in UTF-8 bytes, inclusive", async () => {
    const store = new MemoryBlobStore();
    const at = "a".repeat(4096);
    const over = "a".repeat(4097);
    const out = await externalizeMap(entry({ at, over }), store);
    assert.equal(out.get("at"), at);
    const ref = out.get("over");
    assert.ok(ref instanceof BlobRef);
    assert.equal(ref.bytes, 4097);
    assert.equal(ref.mime, TEXT_MIME);
    assert.equal(store.blobs.size, 1);
  });

  test("multi-byte text is measured in bytes, not characters", async () => {
    const store = new MemoryBlobStore();
    const twoByte = cp(0xe9).repeat(2048); // 4096 bytes: stays inline
    const threeByte = cp(0x20ac).repeat(1400); // 1400 characters but 4200 bytes: externalized
    const astral = cp(0x1f600).repeat(1025); // 2050 UTF-16 units but 4100 bytes: externalized
    const out = await externalizeMap(entry({ twoByte, threeByte, astral }), store);
    assert.equal(out.get("twoByte"), twoByte);
    assert.ok(out.get("threeByte") instanceof BlobRef);
    assert.equal((out.get("threeByte") as BlobRef).bytes, 4200);
    assert.ok(out.get("astral") instanceof BlobRef);
    assert.equal((out.get("astral") as BlobRef).bytes, 4100);
  });

  test("custom threshold, nested values, and the input is not modified", async () => {
    const store = new MemoryBlobStore();
    const input = entry({ a: [{ big: "x".repeat(50) }, "small"], k: "y".repeat(20) });
    const snapshot = emitEntry(input);
    const out = await externalizeMap(input, store, { threshold: 30 });
    assert.equal(emitEntry(input), snapshot, "input must not change");
    const a = out.get("a") as Value[];
    assert.ok((a[0] as Map<string, Value>).get("big") instanceof BlobRef);
    assert.equal(a[1], "small");
    assert.equal(out.get("k"), "y".repeat(20));
  });

  test("binary data is always externalized, and identical content is stored once", async () => {
    const store = new MemoryBlobStore();
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 255);
    const out = await externalizeMap(entry({ a: new BlobData(png, "image/png"), b: new BlobData(png, "image/png"), c: "z".repeat(5000), d: "z".repeat(5000) }), store);
    const a = out.get("a") as BlobRef;
    assert.equal(a.mime, "image/png");
    assert.equal(a.bytes, 6);
    assert.equal(a.sha256, (out.get("b") as BlobRef).sha256);
    assert.equal((out.get("c") as BlobRef).sha256, (out.get("d") as BlobRef).sha256);
    assert.equal(store.blobs.size, 2);
  });

  test("an oversized string with a lone surrogate is rejected rather than silently altered", async () => {
    await assert.rejects(externalizeMap(entry({ a: "x".repeat(5000) + String.fromCharCode(0xd800) }), new MemoryBlobStore()), EmitError);
  });

  test("a megabyte-sized value leaves the transcript entry small", async () => {
    const store = new MemoryBlobStore();
    const out = await externalizeMap(entry({ type: "tool_result", content: "line of output\n".repeat(70000) }), store);
    const text = emitEntry(out);
    assert.ok(text.length < 400, `entry is ${text.length} bytes`);
    assert.ok(valueEquals(parseEntry(text), out));
  });
});

describe("resolve", () => {
  test("restores text and binary content through a full emit/parse cycle", async () => {
    const store = new MemoryBlobStore();
    const big = ("multi\nline " + cp(0x65e5, 0x672c, 0x1f600) + "\n").repeat(800);
    const bin = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const original = entry({ id: "x", text: big, nested: [{ data: new BlobData(bin, "application/octet-stream") }] });
    const stored = parseEntry(emitEntry(await externalizeMap(original, store)));
    const back = (await resolve(stored, store)) as Map<string, unknown>;
    assert.equal(back.get("text"), big);
    const data = ((back.get("nested") as Map<string, unknown>[])[0] as Map<string, unknown>).get("data") as Uint8Array;
    assert.deepEqual([...data], [...bin]);
  });

  test("a missing blob is a BlobError", async () => {
    const ref = new BlobRef("ab".repeat(32), 5, TEXT_MIME);
    await assert.rejects(resolve(entry({ a: ref }), new MemoryBlobStore()), BlobError);
  });

  test("a blob of the wrong size is a BlobError", async () => {
    const store = new MemoryBlobStore();
    const h = await store.put(new TextEncoder().encode("hello"));
    await assert.rejects(resolve(entry({ a: new BlobRef(h, 99, TEXT_MIME) }), store), BlobError);
  });

  test("tampered content of the right size is caught by hash verification", async () => {
    const store = new MemoryBlobStore();
    const h = await store.put(new TextEncoder().encode("hello"));
    store.blobs.set(h, new TextEncoder().encode("HELLO"));
    const e = entry({ a: new BlobRef(h, 5, TEXT_MIME) });
    await assert.rejects(resolve(e, store), BlobError);
    // verification can be skipped for trusted local stores
    assert.equal(((await resolve(e, store, { verify: false })) as Map<string, unknown>).get("a"), "HELLO");
  });

  test("invalid UTF-8 in a text blob is rejected", async () => {
    const store = new MemoryBlobStore();
    const bad = Uint8Array.of(0x68, 0xff, 0x69);
    const h = await store.put(bad);
    await assert.rejects(resolve(entry({ a: new BlobRef(h, 3, TEXT_MIME) }), store), /UTF-8/);
  });
});
