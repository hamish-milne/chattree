import { fileTypeFromBuffer } from "file-type";

/**
 * The media formats chattree knows by name, and how to tell which one a file is. Detection is by content (magic numbers), done by the
 * `file-type` package, never by file name: a `.png` that is not a PNG is a surprise, not a PNG. This table is what the rest of the
 * harness reasons about: what kind a format is, whether any provider takes it as it is (`direct`), and what to convert it to when none
 * does (`convertTo`, the hint in a refusal). Which sink accepts which format is a separate question (docs/tools.md, media formats).
 */

export type FormatKind = "image" | "audio" | "pdf" | "video";

export interface Format {
  /** The canonical media type. */
  mime: string;
  kind: FormatKind;
  /** What to call it to a person. */
  label: string;
  /** True when some provider takes this format as it is, so a file in it needs no conversion for that provider. */
  direct: boolean;
}

const IMAGE_HINT = "png, jpeg, gif or webp";
const AUDIO_HINT = "wav, mp3 or flac";

/** The known formats. Video is known only so that it can be named in a refusal; no sink takes it yet. */
export const FORMATS: readonly Format[] = [
  { mime: "image/png", kind: "image", label: "a PNG picture", direct: true },
  { mime: "image/jpeg", kind: "image", label: "a JPEG picture", direct: true },
  { mime: "image/gif", kind: "image", label: "a GIF picture", direct: true },
  { mime: "image/webp", kind: "image", label: "a WebP picture", direct: true },
  { mime: "image/bmp", kind: "image", label: "a BMP picture", direct: false },
  { mime: "image/tiff", kind: "image", label: "a TIFF picture", direct: false },
  { mime: "image/avif", kind: "image", label: "an AVIF picture", direct: false },
  { mime: "image/heic", kind: "image", label: "a HEIC picture", direct: false },
  { mime: "image/heif", kind: "image", label: "a HEIF picture", direct: false },
  { mime: "image/jxl", kind: "image", label: "a JPEG XL picture", direct: false },
  { mime: "application/pdf", kind: "pdf", label: "a PDF", direct: true },
  { mime: "audio/wav", kind: "audio", label: "a WAV sound", direct: true },
  { mime: "audio/mpeg", kind: "audio", label: "an MP3 sound", direct: true },
  { mime: "audio/flac", kind: "audio", label: "a FLAC sound", direct: true },
  { mime: "audio/ogg", kind: "audio", label: "an Ogg sound (Vorbis or Opus)", direct: false },
  { mime: "audio/mp4", kind: "audio", label: "an M4A sound", direct: false },
  { mime: "audio/aac", kind: "audio", label: "an AAC sound", direct: false },
  { mime: "audio/aiff", kind: "audio", label: "an AIFF sound", direct: false },
  { mime: "audio/amr", kind: "audio", label: "an AMR sound", direct: false },
  { mime: "audio/x-ms-asf", kind: "audio", label: "a WMA/ASF sound", direct: false },
  { mime: "video/mp4", kind: "video", label: "an MP4 video", direct: false },
  { mime: "video/webm", kind: "video", label: "a WebM video", direct: false },
  { mime: "video/matroska", kind: "video", label: "a Matroska file", direct: false },
  { mime: "video/quicktime", kind: "video", label: "a QuickTime video", direct: false },
  { mime: "video/ogg", kind: "video", label: "an Ogg video", direct: false },
  { mime: "video/vnd.avi", kind: "video", label: "an AVI video", direct: false },
];

const BY_MIME = new Map(FORMATS.map((f) => [f.mime, f]));

/** Other names for the same format, as `file-type` or a host may say them. */
const ALIASES: Readonly<Record<string, string>> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/x-flac": "audio/flac",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aiff": "audio/aiff",
  "audio/aif": "audio/aiff",
  "audio/opus": "audio/ogg",
  "audio/vorbis": "audio/ogg",
  "audio/x-ogg": "audio/ogg",
  "audio/x-hx-aac-adts": "audio/aac",
  "audio/vnd.dlna.adts": "audio/aac",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-ms-bmp": "image/bmp",
  "image/x-bmp": "image/bmp",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
  "video/x-matroska": "video/matroska",
  "video/x-msvideo": "video/vnd.avi",
  "video/avi": "video/vnd.avi",
  "audio/x-matroska": "video/matroska",
  "audio/webm": "video/webm",
  "application/x-pdf": "application/pdf",
};

/** The canonical media type for a name: parameters dropped (`audio/ogg; codecs=opus`), case folded, aliases resolved. */
export function canonicalMime(mime: string): string {
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return ALIASES[base] ?? base;
}

/** The known format with this media type (any name for it), or undefined. */
export function formatOf(mime: string): Format | undefined {
  return BY_MIME.get(canonicalMime(mime));
}

/** What to say a refusal's remedy is for a format that no sink takes: what to convert it to. */
export function convertHint(f: Format): string {
  return f.kind === "image" ? IMAGE_HINT : f.kind === "audio" ? AUDIO_HINT : "a format that is accepted";
}

/**
 * The most bytes handed to the detector. Some formats keep what identifies them far into the file (a TIFF from ffmpeg puts its directory
 * at the end), so this is not the few kilobytes most formats need; beyond it a file is simply unrecognised.
 */
const SNIFF_BYTES = 8 * 1024 * 1024;

/**
 * Which known format these bytes are, by their content, or undefined for anything else (text, an archive, an unknown binary). The result
 * of `file-type` is kept only if it names a format in the table, so what it knows beyond this (documents, archives, executables) never
 * reaches the harness; and a type it names that is not here is "not known", not an error.
 */
export async function sniffFormat(bytes: Uint8Array): Promise<Format | undefined> {
  if (bytes.length === 0) return undefined;
  let found: { mime: string } | undefined;
  try {
    found = await fileTypeFromBuffer(bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes);
  } catch {
    return undefined; // a truncated or malformed file: the detector gives up, and so do we
  }
  return found === undefined ? undefined : formatOf(found.mime);
}
