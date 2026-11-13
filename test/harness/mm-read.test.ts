import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { MemoryBlobStore } from "../../src/index.ts";
import { MM_READ_MAX_BYTES, leafTools, sniffMedia } from "../../harness/starter/index.ts";
import type { Tool, ToolContext, ToolOutput } from "../../harness/tools.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WAV = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVEfmt ")]);

async function setup(files: Record<string, Uint8Array | string>, mmRead = true) {
  const dir = await tempDir();
  for (const [n, c] of Object.entries(files)) {
    await mkdir(join(dir, n, ".."), { recursive: true });
    await writeFile(join(dir, n), c);
  }
  const tools = leafTools({ mmRead });
  const tool = (name: string): Tool => tools.find((t) => t.definition.name === name) as Tool;
  const run = async (name: string, args: Record<string, unknown>): Promise<ToolOutput> =>
    (await tool(name).execute(args, { signal: new AbortController().signal, callId: "c", workspace: dir, host, blobs: new MemoryBlobStore() } as ToolContext)) as ToolOutput;
  return { run };
}

describe("mm_read", () => {
  test("sniffs by content, not by name", () => {
    assert.deepEqual(sniffMedia(PNG), { mime: "image/png", kind: "picture" });
    assert.deepEqual(sniffMedia(WAV), { mime: "audio/wav", kind: "sound" });
    assert.deepEqual(sniffMedia(Buffer.from("%PDF-1.7")), { mime: "application/pdf", kind: "document" });
    assert.ok("unsupported" in (sniffMedia(Buffer.from("OggS....")) as object));
    assert.equal(sniffMedia(Buffer.from("hello world")), undefined);
  });

  test("returns the file as media with a one-line note", async () => {
    const { run } = await setup({ "a.dat": PNG });
    const r = await run("mm_read", { path: "a.dat" });
    assert.notEqual(r.is_error, true);
    assert.equal(r.media?.length, 1);
    assert.equal(r.media?.[0]?.mime, "image/png");
    assert.match(r.content, /picture \(image\/png, 12 bytes\)/);
  });

  test("refuses empty, oversized, unknown and missing files", async () => {
    const { run } = await setup({ "e.png": "", "big.png": Buffer.concat([PNG, Buffer.alloc(MM_READ_MAX_BYTES)]), "t.txt": "hi", "o.ogg": "OggS....." });
    assert.match((await run("mm_read", { path: "e.png" })).content, /empty \(0 bytes\)/);
    assert.match((await run("mm_read", { path: "big.png" })).content, /over the \d+ byte limit/);
    assert.match((await run("mm_read", { path: "t.txt" })).content, /use read/);
    assert.match((await run("mm_read", { path: "o.ogg" })).content, /Ogg/);
    assert.match((await run("mm_read", { path: "nope.png" })).content, /no such file/);
    for (const p of ["e.png", "big.png", "t.txt", "o.ogg", "nope.png"]) assert.equal((await run("mm_read", { path: p })).media, undefined);
  });

  test("read points a binary file to mm_read only when it is offered", async () => {
    const on = await setup({ "a.png": PNG }, true);
    assert.match((await on.run("read", { path: "a.png" })).content, /use mm_read/);
    const off = await setup({ "a.png": PNG }, false);
    const r = await off.run("read", { path: "a.png" });
    assert.match(r.content, /a binary file/);
    assert.doesNotMatch(r.content, /mm_read/);
  });

  test("run refuses binary output and says what to do", async () => {
    const { run } = await setup({});
    const r = await run("run", { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([137,80,0,255,254]))"` });
    assert.match(r.content, /output is binary/);
    assert.match(r.content, /mm_read/);
    const ok = await run("run", { command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('héllo')"` });
    assert.match(ok.content, /héllo/);
  });
});
