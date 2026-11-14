import { decodeText, normalizeMime, TextAttachmentError } from "../harness/attachments.ts";
import { sniffFormat } from "../harness/formats.ts";

const BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
  md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", css: "text/css", csv: "text/csv", tsv: "text/tab-separated-values",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/plain", rs: "text/plain", go: "text/plain",
  java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain", hpp: "text/plain", cs: "text/plain", rb: "text/plain", php: "text/plain", swift: "text/plain",
  kt: "text/plain", sh: "text/plain", bash: "text/plain", zsh: "text/plain", sql: "application/sql", txt: "text/plain", log: "text/plain", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
};

export interface Detected {
  mime: string;
  charset?: string;
}

/**
 * The CLI's guess at a file's media type (the harness requires the host to say, and this is the CLI's way of saying):
 * the bytes' magic numbers first, because a `.png` that is not a PNG is a surprise, then the extension, then whether the
 * bytes are text. `override` (the user's `--mime`) wins. Throws with what to do when it cannot tell.
 */
export async function detectMime(name: string, bytes: Uint8Array, override?: { mime?: string; charset?: string }): Promise<Detected> {
  if (override?.mime !== undefined) {
    const m = normalizeMime(override.mime);
    if (m === undefined) throw new Error(`${JSON.stringify(override.mime)} is not a media type (type/subtype)`);
    return { mime: m, ...(override.charset === undefined ? {} : { charset: override.charset }) };
  }
  const sniffed = (await sniffFormat(bytes))?.mime;
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  const byExt = ext === undefined ? undefined : BY_EXTENSION[ext];
  const mime = sniffed ?? byExt;
  if (mime !== undefined && !mime.startsWith("text/") && !mime.startsWith("application/")) return { mime };
  if (sniffed !== undefined) return { mime: sniffed };
  // Text (by extension or by looking like it): it has to decode, in UTF-8 or the charset the user names.
  try {
    decodeText(bytes, override?.charset);
  } catch (e) {
    if (e instanceof TextAttachmentError && byExt === undefined && bytes.includes(0)) throw new Error(`cannot tell what ${name} is (it looks binary); pass --mime if a model can read it`);
    throw e instanceof Error ? e : new Error(String(e));
  }
  return { mime: byExt ?? "text/plain", ...(override?.charset === undefined ? {} : { charset: override.charset }) };
}
