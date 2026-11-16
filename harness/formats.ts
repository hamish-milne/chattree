import { fileTypeFromBuffer } from "file-type";

/**
 * The media formats chattree knows by name, and how to tell which one a file is. Detection is by content (magic numbers), done by the
 * `file-type` package, never by file name: a `.png` that is not a PNG is a surprise, not a PNG. This table is what the rest of the
 * harness reasons about: what kind a format is, and what to call it to a person. Which sink accepts which format is a separate question
 * (harness/media-spec.ts; docs/tools.md, media formats).
 */

export type FormatKind = "image" | "audio" | "pdf" | "video";

export interface Format {
  /** The canonical media type. */
  mime: string;
  kind: FormatKind;
  /** What to call it to a person. */
  label: string;
}

/** The known formats. Video is known only so that it can be named in a refusal; no sink takes it yet. */
export const FORMATS: readonly Format[] = [
  { mime: "image/png", kind: "image", label: "a PNG picture" },
  { mime: "image/jpeg", kind: "image", label: "a JPEG picture" },
  { mime: "image/gif", kind: "image", label: "a GIF picture" },
  { mime: "image/webp", kind: "image", label: "a WebP picture" },
  { mime: "image/bmp", kind: "image", label: "a BMP picture" },
  { mime: "image/tiff", kind: "image", label: "a TIFF picture" },
  { mime: "image/avif", kind: "image", label: "an AVIF picture" },
  { mime: "image/heic", kind: "image", label: "a HEIC picture" },
  { mime: "image/heif", kind: "image", label: "a HEIF picture" },
  { mime: "image/jxl", kind: "image", label: "a JPEG XL picture" },
  { mime: "application/pdf", kind: "pdf", label: "a PDF" },
  { mime: "audio/wav", kind: "audio", label: "a WAV sound" },
  { mime: "audio/mpeg", kind: "audio", label: "an MP3 sound" },
  { mime: "audio/flac", kind: "audio", label: "a FLAC sound" },
  { mime: "audio/ogg", kind: "audio", label: "an Ogg sound (Vorbis or Opus)" },
  { mime: "audio/mp4", kind: "audio", label: "an M4A sound" },
  { mime: "audio/aac", kind: "audio", label: "an AAC sound" },
  { mime: "audio/aiff", kind: "audio", label: "an AIFF sound" },
  { mime: "audio/amr", kind: "audio", label: "an AMR sound" },
  { mime: "audio/x-ms-asf", kind: "audio", label: "a WMA/ASF sound" },
  { mime: "video/mp4", kind: "video", label: "an MP4 video" },
  { mime: "video/webm", kind: "video", label: "a WebM video" },
  { mime: "video/matroska", kind: "video", label: "a Matroska file" },
  { mime: "video/quicktime", kind: "video", label: "a QuickTime video" },
  { mime: "video/ogg", kind: "video", label: "an Ogg video" },
  { mime: "video/vnd.avi", kind: "video", label: "an AVI video" },
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
