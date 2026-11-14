import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { findFfmpeg } from "../../hosts/ffmpeg.ts";
import { FORMATS, canonicalMime, convertHint, formatOf, sniffFormat } from "../../harness/formats.ts";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const bytes = (...parts: (number[] | string)[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p)));
const pad = (b: Uint8Array, n = 600): Uint8Array => (b.length >= n ? b : Uint8Array.from([...b, ...new Array<number>(n - b.length).fill(0)]));

/** The start of a file in each format, as little as a detector needs: these are checked by content, not name. */
const SAMPLES: [string, Uint8Array, string][] = [
  ["PNG", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR"), "image/png"],
  ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF", [0]), "image/jpeg"],
  ["GIF", bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0]), "image/gif"],
  ["WebP", bytes("RIFF", le32(100), "WEBPVP8 "), "image/webp"],
  ["BMP", pad(bytes("BM", le32(600), [0, 0, 0, 0], le32(54), le32(40), le32(2), le32(2), [1, 0, 24, 0])), "image/bmp"],
  ["AVIF", bytes([0, 0, 0, 24], "ftypavif", [0, 0, 0, 0], "avifmif1"), "image/avif"],
  ["HEIC", bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0], "mif1heic"), "image/heic"],
  ["PDF", bytes("%PDF-1.7\n"), "application/pdf"],
  ["WAV", bytes("RIFF", le32(100), "WAVEfmt ", le32(16), [1, 0, 1, 0], le32(16000), le32(32000), [2, 0, 16, 0], "data", le32(0)), "audio/wav"],
  ["FLAC", bytes("fLaC", [0, 0, 0, 34]), "audio/flac"],
  ["MP3 with an ID3 tag", pad(bytes("ID3", [3, 0, 0, 0, 0, 0, 0], [0xff, 0xfb, 0x90, 0x00])), "audio/mpeg"],
  ["MP3 frames without a tag", pad(bytes([0xff, 0xfb, 0x90, 0x00])), "audio/mpeg"],
  ["AIFF", bytes("FORM", [0, 0, 1, 0], "AIFFCOMM"), "audio/aiff"],
  ["M4A", bytes([0, 0, 0, 24], "ftypM4A ", [0, 0, 0, 0], "M4A mp42"), "audio/mp4"],
  ["MP4 video", bytes([0, 0, 0, 24], "ftypisom", [0, 0, 2, 0], "isomiso2"), "video/mp4"],
  ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84], "webm"), "video/webm"],
];

describe("sniffing the format of bytes", () => {
  for (const [name, b, mime] of SAMPLES) test(`${name} is ${mime}`, async () => assert.equal((await sniffFormat(b))?.mime, mime));

  test("text, an unknown binary, an empty file and a truncated one are not formats", async () => {
    assert.equal(await sniffFormat(bytes("hello world, this is text\n")), undefined);
    assert.equal(await sniffFormat(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
    assert.equal(await sniffFormat(new Uint8Array(0)), undefined);
    assert.equal(await sniffFormat(bytes([0x89, 0x50])), undefined);
  });

  test("what the detector knows beyond the table never reaches the caller (a zip, an executable)", async () => {
    assert.equal(await sniffFormat(pad(bytes("PK", [3, 4, 20, 0, 0, 0, 8, 0]))), undefined);
    assert.equal(await sniffFormat(pad(bytes([0x7f], "ELF", [2, 1, 1, 0]))), undefined);
  });

  test("the name does not matter, only the content", async () => {
    // (there is no name to give: the point is that the same bytes are the same format wherever they came from)
    assert.equal((await sniffFormat(SAMPLES[0]![1]))?.kind, "image");
  });
});

describe("the table", () => {
  test("every format is canonical, once, and the aliases resolve to a format in it", () => {
    assert.equal(new Set(FORMATS.map((f) => f.mime)).size, FORMATS.length);
    for (const f of FORMATS) assert.equal(canonicalMime(f.mime), f.mime, f.mime);
    for (const alias of ["audio/x-wav", "audio/vnd.wave", "audio/mp3", "audio/x-flac", "audio/x-m4a", "audio/ogg; codecs=opus", "AUDIO/WAV; rate=16000", "image/jpg", "image/x-ms-bmp"]) assert.ok(formatOf(alias) !== undefined, alias);
    assert.equal(formatOf("audio/x-wav")?.mime, "audio/wav");
    assert.equal(formatOf("audio/ogg; codecs=opus")?.mime, "audio/ogg");
    assert.equal(formatOf("text/plain"), undefined);
  });

  test("the formats a provider takes as they are are the ones models were given before the table: png, jpeg, gif, webp, pdf, wav, mp3, flac", () => {
    assert.deepEqual(FORMATS.filter((f) => f.direct).map((f) => f.mime).sort(), ["application/pdf", "audio/flac", "audio/mpeg", "audio/wav", "image/gif", "image/jpeg", "image/png", "image/webp"]);
  });

  test("a refusal's remedy names what to convert to", () => {
    assert.match(convertHint(formatOf("image/bmp")!), /png/);
    assert.match(convertHint(formatOf("audio/ogg")!), /wav, mp3 or flac/);
  });
});

describe("real files made by ffmpeg", () => {
  test("each is recognised by content", async (t) => {
    const exe = await findFfmpeg();
    if (exe === undefined) return t.skip("no ffmpeg here");
    const dir = await mkdtemp(join(tmpdir(), "formats-"));
    const run = (args: string[]): boolean => spawnSync(exe, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dir }).status === 0;
    const sine = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.2"];
    const red = ["-f", "lavfi", "-i", "color=c=red:s=32x32:d=1", "-frames:v", "1"];
    const cases: [string[], string, string][] = [
      [[...sine, "-ar", "16000", "a.wav"], "a.wav", "audio/wav"],
      [[...sine, "a.mp3"], "a.mp3", "audio/mpeg"],
      [[...sine, "a.flac"], "a.flac", "audio/flac"],
      [[...sine, "-c:a", "libvorbis", "a.ogg"], "a.ogg", "audio/ogg"],
      [[...sine, "-c:a", "libopus", "a.opus"], "a.opus", "audio/ogg"],
      [[...sine, "-c:a", "aac", "a.m4a"], "a.m4a", "audio/mp4"],
      [[...sine, "a.aiff"], "a.aiff", "audio/aiff"],
      [[...sine, "-c:a", "aac", "a.aac"], "a.aac", "audio/aac"],
      [[...red, "i.png"], "i.png", "image/png"],
      [[...red, "i.jpg"], "i.jpg", "image/jpeg"],
      [[...red, "i.gif"], "i.gif", "image/gif"],
      [[...red, "i.bmp"], "i.bmp", "image/bmp"],
      [[...red, "i.tiff"], "i.tiff", "image/tiff"],
      [[...red, "i.webp"], "i.webp", "image/webp"],
    ];
    let checked = 0;
    for (const [args, file, mime] of cases) {
      if (!run(args)) continue; // this ffmpeg lacks an encoder for it
      assert.equal((await sniffFormat(await readFile(join(dir, file))))?.mime, mime, file);
      checked++;
    }
    assert.ok(checked >= 8, `only ${checked} could be made`);
  });
});
