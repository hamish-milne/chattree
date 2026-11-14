/**
 * Shared by the probes' `--as FORMAT`: make the made picture or sound into another format with ffmpeg, then send it through the same
 * step a request goes through (`prepareMedia`: the sink's spec, the converter), so a probe tests the conversion path and not only the model.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegFor } from "../cli/toolset.ts";
import type { Io } from "../cli/io.ts";
import type { ModelContext } from "../harness/context-builder.ts";
import { ffmpegConverter } from "../harness/ffmpeg-converter.ts";
import { prepareMedia, type PreparedMedia } from "../harness/prepare-media.ts";
import type { AgentSetup } from "../harness/setup.ts";
import type { ProviderAdapter } from "../providers/types.ts";

/** What a probe can re-encode its source as: the media type, the file extension and ffmpeg's output arguments. */
export const SOURCE_FORMATS: Readonly<Record<string, { mime: string; ext: string; args: readonly string[] }>> = {
  png: { mime: "image/png", ext: "png", args: ["-c:v", "png"] },
  jpeg: { mime: "image/jpeg", ext: "jpg", args: ["-c:v", "mjpeg", "-q:v", "2"] },
  gif: { mime: "image/gif", ext: "gif", args: ["-c:v", "gif"] },
  bmp: { mime: "image/bmp", ext: "bmp", args: ["-c:v", "bmp"] },
  webp: { mime: "image/webp", ext: "webp", args: ["-c:v", "libwebp", "-lossless", "1"] },
  tiff: { mime: "image/tiff", ext: "tiff", args: ["-c:v", "tiff"] },
  wav: { mime: "audio/wav", ext: "wav", args: ["-c:a", "pcm_s16le"] },
  mp3: { mime: "audio/mpeg", ext: "mp3", args: ["-c:a", "libmp3lame", "-q:a", "2"] },
  flac: { mime: "audio/flac", ext: "flac", args: ["-c:a", "flac"] },
  ogg: { mime: "audio/ogg", ext: "ogg", args: ["-c:a", "libvorbis"] },
  m4a: { mime: "audio/mp4", ext: "m4a", args: ["-c:a", "aac"] },
};

/** `bytes` (a file of type `inExt`) written as `as` by `ffmpeg`. */
export async function reencode(ffmpeg: string, bytes: Uint8Array, inExt: string, as: string): Promise<{ bytes: Uint8Array; mime: string; ext: string }> {
  const f = SOURCE_FORMATS[as];
  if (f === undefined) throw new Error(`--as: ${as} is not one of ${Object.keys(SOURCE_FORMATS).join(", ")}`);
  const dir = await mkdtemp(join(tmpdir(), "chattree-probe-"));
  try {
    await writeFile(join(dir, `in.${inExt}`), bytes);
    const r = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", `in.${inExt}`, "-map_metadata", "-1", ...f.args, `out.${f.ext}`], { cwd: dir });
    if (r.status !== 0) throw new Error(`ffmpeg could not write ${as}: ${String(r.stderr).trim().split("\n").slice(-2).join("; ")}`);
    return { bytes: new Uint8Array(await readFile(join(dir, `out.${f.ext}`))), mime: f.mime, ext: f.ext };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The ffmpeg this machine's settings name; a probe that needs one stops with the setting's own message when there is none. */
export async function probeFfmpeg(io: Io): Promise<string> {
  const f = await ffmpegFor(io);
  if (f === undefined) throw new Error("the ffmpeg setting is false: --as needs ffmpeg");
  return f;
}

/** The context as a request would send it to this adapter's model: its media spec, converted by ffmpeg. */
export async function throughSink(adapter: ProviderAdapter, setup: AgentSetup, context: ModelContext, ffmpeg: string, workDir: string): Promise<PreparedMedia> {
  if (adapter.mediaSpec === undefined) throw new Error("this adapter has no media spec");
  const spec = await adapter.mediaSpec(setup);
  const converter = await ffmpegConverter({ host: (await import("../hosts/node.ts")).nodeHost(), ffmpeg, workDir });
  return prepareMedia(context, { spec, converter: async () => converter });
}
