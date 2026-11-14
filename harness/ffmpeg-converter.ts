import { ConversionError, type Converter } from "./converter.ts";
import { formatOf, type Format } from "./formats.ts";
import type { MediaTarget } from "./media-spec.ts";
import type { Host } from "../src/host.ts";

/**
 * The converter that runs ffmpeg (`hosts/ffmpeg.ts` finds or fetches it). It asks the program once what it can decode and encode, so `can`
 * is true only for what this build does; it never guesses. Each conversion writes the input to a file in `workDir`, runs ffmpeg there
 * with relative names, reads the output file and removes both (files go through the host, which has no temporary directory of its own,
 * so `workDir` is given: the host's scratch place). Output is made bit-exact and without metadata, so the same input and ffmpeg give
 * the same bytes, which prompt caching on the providers depends on.
 */

/** What ffmpeg writes a target as: the encoder to ask for, the container, the file extension and any further arguments. */
interface Encoding {
  encoder: string;
  args: readonly string[];
  ext: string;
  kind: "image" | "audio";
}

const ENCODINGS: Readonly<Record<string, Encoding>> = {
  "image/png": { encoder: "png", args: ["-frames:v", "1", "-c:v", "png", "-f", "image2", "-update", "1"], ext: "png", kind: "image" },
  "image/jpeg": { encoder: "mjpeg", args: ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-f", "image2", "-update", "1"], ext: "jpg", kind: "image" },
  "image/gif": { encoder: "gif", args: ["-frames:v", "1", "-c:v", "gif", "-f", "image2", "-update", "1"], ext: "gif", kind: "image" },
  "image/bmp": { encoder: "bmp", args: ["-frames:v", "1", "-c:v", "bmp", "-f", "image2", "-update", "1"], ext: "bmp", kind: "image" },
  "image/webp": { encoder: "libwebp", args: ["-frames:v", "1", "-c:v", "libwebp", "-lossless", "1", "-f", "webp"], ext: "webp", kind: "image" },
  "audio/wav": { encoder: "pcm_s16le", args: ["-vn", "-c:a", "pcm_s16le", "-f", "wav"], ext: "wav", kind: "audio" },
  "audio/flac": { encoder: "flac", args: ["-vn", "-c:a", "flac", "-f", "flac"], ext: "flac", kind: "audio" },
  "audio/mpeg": { encoder: "libmp3lame", args: ["-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"], ext: "mp3", kind: "audio" },
};

/** The decoders (any one of them) that read each source format, by the name ffmpeg lists. */
const DECODERS: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["mjpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp", "libwebp"],
  "image/bmp": ["bmp"],
  "image/tiff": ["tiff"],
  "image/avif": ["libdav1d", "libaom-av1", "av1"],
  "image/heic": ["hevc"],
  "image/heif": ["hevc"],
  "image/jxl": ["libjxl", "jpegxl"],
  "audio/wav": ["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"],
  "audio/mpeg": ["mp3", "mp3float", "libmp3lame"],
  "audio/flac": ["flac"],
  "audio/ogg": ["vorbis", "libvorbis", "opus", "libopus"],
  "audio/mp4": ["aac", "alac"],
  "audio/aac": ["aac"],
  "audio/aiff": ["pcm_s16be", "pcm_s24be", "pcm_s32be"],
  "audio/amr": ["amrnb", "amrwb", "libopencore_amrnb", "libopencore_amrwb"],
  "audio/x-ms-asf": ["wmav2", "wmav1", "wmapro"],
};

const EXT: Readonly<Record<string, string>> = { "image/jpeg": "jpg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/aiff": "aiff", "audio/x-ms-asf": "wma", "image/tiff": "tiff" };

/** The names in the second column of `ffmpeg -decoders` / `-encoders`, plus the `(codec x)` aliases some carry. */
function names(listing: string): Set<string> {
  const out = new Set<string>();
  for (const line of listing.split("\n")) {
    const m = /^\s([VAS.][A-Za-z.]{5})\s+(\S+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    out.add(m[2] as string);
    const alias = /\(codec ([^)]+)\)/.exec(m[3] as string);
    if (alias !== null) out.add(alias[1] as string);
  }
  return out;
}

const dec = new TextDecoder();
let counter = 0;

export interface FfmpegConverterOptions {
  host: Host;
  /** The ffmpeg program (a path). */
  ffmpeg: string;
  /** A directory for the files of a conversion in progress; made if it is not there. */
  workDir: string;
  /** Make the id deterministic in tests. */
  newId?: () => string;
}

/** The converter for this ffmpeg. Asks the program what it can do (three quick runs), and fails if it does not run. */
export async function ffmpegConverter(o: FfmpegConverterOptions): Promise<Converter> {
  const run = async (args: string[], signal?: AbortSignal) => o.host.exec(o.ffmpeg, args, { cwd: o.workDir, ...(signal === undefined ? {} : { signal }), maxOutput: 16 * 1024 * 1024 });
  await o.host.fs.mkdir(o.workDir);
  const version = await run(["-hide_banner", "-version"]).catch((e: unknown) => {
    throw new ConversionError(`ffmpeg (${o.ffmpeg}) could not be started: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (version.exitCode !== 0) throw new ConversionError(`${o.ffmpeg} does not run as ffmpeg (exit ${version.exitCode})`);
  const id = `ffmpeg ${/ffmpeg version (\S+)/.exec(dec.decode(version.stdout))?.[1] ?? "unknown"}`;
  const decoders = names(dec.decode((await run(["-hide_banner", "-decoders"])).stdout));
  const encoders = names(dec.decode((await run(["-hide_banner", "-encoders"])).stdout));
  const newId = o.newId ?? (() => `${process.pid}-${Date.now().toString(36)}-${(counter++).toString(36)}`);

  const can = (from: Format, to: MediaTarget): boolean => {
    const enc = ENCODINGS[formatOf(to.mime)?.mime ?? to.mime];
    if (enc === undefined || from.kind !== enc.kind || !encoders.has(enc.encoder)) return false;
    return (DECODERS[from.mime] ?? []).some((d) => decoders.has(d));
  };

  return {
    id,
    can,
    async convert(bytes, from, to, signal) {
      const target = formatOf(to.mime);
      const enc = target === undefined ? undefined : ENCODINGS[target.mime];
      if (target === undefined || enc === undefined) throw new ConversionError(`ffmpeg here cannot make ${to.mime}`);
      if (!can(from, to)) throw new ConversionError(`this ffmpeg (${id}) cannot turn ${from.label} into ${target.label}: it lacks the ${from.kind === "image" ? "picture" : "sound"} ${decoders.size === 0 ? "decoders" : "decoder or encoder"} for it`);
      const stem = newId();
      const inName = `${stem}-in.${EXT[from.mime] ?? from.mime.split("/")[1] ?? "bin"}`;
      const outName = `${stem}-out.${enc.ext}`;
      const inPath = o.host.path.join(o.workDir, inName);
      const outPath = o.host.path.join(o.workDir, outName);
      await o.host.fs.writeAtomic(inPath, bytes);
      try {
        const r = await run(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inName, "-map_metadata", "-1", "-fflags", "+bitexact", "-flags", "+bitexact", ...enc.args, outName], signal);
        if (r.exitCode !== 0) throw new ConversionError(`ffmpeg could not turn ${from.label} into ${target.label}: ${dec.decode(r.stderr).trim().split("\n").slice(-3).join("; ") || `exit ${r.exitCode}`}`);
        const out = await o.host.fs.read(outPath).catch(() => undefined);
        if (out === undefined || out.length === 0) throw new ConversionError(`ffmpeg made nothing when turning ${from.label} into ${target.label}`);
        return out;
      } finally {
        await o.host.fs.remove(inPath).catch(() => false);
        await o.host.fs.remove(outPath).catch(() => false);
      }
    },
  };
}
