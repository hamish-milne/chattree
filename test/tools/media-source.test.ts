import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { sniffFormat } from "../../harness/formats.ts";
import { SOURCE_FORMATS, reencode, throughSink } from "../../tools/media-source.ts";
import { scenarios } from "../../tools/audio-scenarios.ts";
import type { ProviderAdapter } from "../../providers/types.ts";
import { emptySetup } from "../../harness/setup.ts";
import { tempDir } from "../support/tmp.ts";

const have = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("probe sources (--as)", { skip: !have && "no ffmpeg" }, () => {
  test("a made sound written as each format is that format, and goes through the sink's spec to something it takes", async () => {
    const [clip] = scenarios({ kinds: ["beeps"], count: 1, seed: 1, pad: 0 });
    assert.ok(clip);
    const adapter = { $tag: "t", mediaSpec: () => ({ audio: [{ mime: "audio/flac" }, { mime: "audio/wav" }] }), stream: () => { throw new Error("no"); } } as unknown as ProviderAdapter;
    const work = join(await tempDir(), "w");
    for (const as of ["ogg", "mp3", "flac", "wav", "m4a"]) {
      const made = await reencode("ffmpeg", clip.wav, "wav", as);
      assert.equal((await sniffFormat(made.bytes))?.mime, SOURCE_FORMATS[as]?.mime, as);
      const context = { system: "", instructions: undefined, turns: [{ role: "user" as const, parts: [{ type: "attachment" as const, kind: "audio" as const, name: `c.${made.ext}`, mime: made.mime, sha256: as, bytes: made.bytes }] }], tools: [], cacheHints: [] };
      const out = await throughSink(adapter, emptySetup(), context, "ffmpeg", work);
      assert.deepEqual(out.warnings, [], as);
      const part = (out.context.turns[0] as { parts: { mime: string; bytes: Uint8Array }[] }).parts[0];
      assert.ok(part && ["audio/flac", "audio/wav"].includes((await sniffFormat(part.bytes))?.mime ?? ""), as);
    }
  });
});
