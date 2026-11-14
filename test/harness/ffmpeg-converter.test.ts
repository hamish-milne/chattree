import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ConversionError } from "../../harness/converter.ts";
import { ffmpegConverter } from "../../harness/ffmpeg-converter.ts";
import { formatOf, sniffFormat } from "../../harness/formats.ts";
import { nodeHost } from "../../hosts/node.ts";
import { tempDir } from "../support/tmp.ts";

const have = spawnSync("ffmpeg", ["-version"]).status === 0;
const fmt = (mime: string) => {
  const f = formatOf(mime);
  assert.ok(f, mime);
  return f;
};

/** Makes a source clip with ffmpeg itself. */
function make(dir: string, name: string, args: string[]): Uint8Array {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, name], { cwd: dir });
  assert.equal(r.status, 0, String(r.stderr));
  return new Uint8Array(spawnSync("cat", [join(dir, name)]).stdout);
}

describe("ffmpeg converter", { skip: !have && "no ffmpeg" }, () => {
  test("pictures and sounds convert to what the sink takes", async () => {
    const dir = await tempDir();
    const conv = await ffmpegConverter({ host: nodeHost(), ffmpeg: "ffmpeg", workDir: join(dir, "work") });
    assert.match(conv.id, /^ffmpeg \d/);
    const src = await tempDir();
    const pic = ["-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1"];
    const snd = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3"];
    const cases: [string, string[], string, string][] = [
      ["a.bmp", pic, "image/bmp", "image/png"],
      ["a.png", pic, "image/png", "image/jpeg"],
      ["a.webp", pic, "image/webp", "image/png"],
      ["a.tiff", pic, "image/tiff", "image/png"],
      ["a.ogg", [...snd, "-c:a", "libvorbis"], "audio/ogg", "audio/flac"],
      ["a.ogg", [...snd, "-c:a", "libvorbis"], "audio/ogg", "audio/wav"],
      ["a.flac", snd, "audio/flac", "audio/mpeg"],
    ];
    for (const [name, args, from, to] of cases) {
      const bytes = make(src, name, args);
      assert.equal((await sniffFormat(bytes))?.mime, formatOf(from)?.mime, `${name} source`);
      assert.ok(conv.can(fmt(from), { mime: to }), `${from} -> ${to}`);
      const out = await conv.convert(bytes, fmt(from), { mime: to });
      assert.equal((await sniffFormat(out))?.mime, formatOf(to)?.mime, `${from} -> ${to}`);
      assert.deepEqual(await conv.convert(bytes, fmt(from), { mime: to }), out, "same bytes again");
    }
    assert.deepEqual(await nodeHost().fs.readdir(join(dir, "work")), [], "work files removed");
  });

  test("never across kinds, and honest about what it lacks", async () => {
    const dir = await tempDir();
    const conv = await ffmpegConverter({ host: nodeHost(), ffmpeg: "ffmpeg", workDir: join(dir, "w") });
    assert.equal(conv.can(fmt("audio/ogg"), { mime: "image/png" }), false);
    assert.equal(conv.can(fmt("image/bmp"), { mime: "audio/wav" }), false);
    assert.equal(conv.can(fmt("image/png"), { mime: "application/pdf" }), false);
    await assert.rejects(conv.convert(new Uint8Array([1]), fmt("audio/ogg"), { mime: "image/png" }), ConversionError);
  });

  test("a damaged file is a ConversionError saying what failed, and leaves nothing behind", async () => {
    const dir = await tempDir();
    const conv = await ffmpegConverter({ host: nodeHost(), ffmpeg: "ffmpeg", workDir: join(dir, "w") });
    await assert.rejects(conv.convert(new TextEncoder().encode("not a picture at all"), fmt("image/bmp"), { mime: "image/png" }), /ffmpeg could not turn/);
    assert.deepEqual(await nodeHost().fs.readdir(join(dir, "w")), []);
  });
});

describe("ffmpeg converter with a program that is not ffmpeg", () => {
  test("a program that will not start is a ConversionError", async () => {
    const dir = await tempDir();
    await assert.rejects(ffmpegConverter({ host: nodeHost(), ffmpeg: join(dir, "missing"), workDir: join(dir, "w") }), ConversionError);
  });
});
