/**
 * Attachments: files a user adds to a message. The harness never guesses what a file is. The host (a browser, a CLI
 * wrapper using whatever detection suits it) says the MIME type, `Conversation.attach` stores the bytes as a blob and
 * records the type in the blob reference, and everything after reads the type from there.
 */

export type AttachmentKind = "text" | "image" | "pdf";

/** Image types every provider that takes images accepts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The media type without parameters, lowercased; undefined if it is not `type/subtype`. */
export function normalizeMime(mime: string): string | undefined {
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : undefined;
}

/** How a model is given a file of this type, or undefined if there is no way (the file is refused when attached). */
export function attachmentKind(mime: string): AttachmentKind | undefined {
  const m = normalizeMime(mime);
  if (m === undefined) return undefined;
  if (IMAGE_TYPES.has(m)) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript", "application/sql"].includes(m) || /\+(json|xml|yaml)$/.test(m)) return "text";
  return undefined;
}

/** The `charset` parameter of a media type, lowercased, if there is one. */
export function mimeCharset(mime: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(mime);
  return m?.[1]?.toLowerCase();
}

export class TextAttachmentError extends Error {
  override name = "TextAttachmentError";
}

/**
 * The text of a text attachment, as UTF-8 text for the model. The file's bytes are never changed; this is a strict view of
 * them. A UTF-8 BOM is dropped and a UTF-16 BOM selects UTF-16; otherwise the declared `charset` (from the host, or a media type's parameter) is used (any label the
 * runtime knows, such as windows-1252), else UTF-8. Bytes that are not valid in that encoding are an error, never
 * replaced and never guessed at (detection is the host's job: it can pass a charset). NUL bytes in an 8-bit
 * encoding mean the file is binary. Line endings are left exactly as they are.
 */
export function decodeText(bytes: Uint8Array, charset?: string): string {
  let label = charset ?? "utf-8";
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    throw new TextAttachmentError(`the charset ${JSON.stringify(label)} is not one this runtime can read`);
  }
  const wide = /^utf-16/.test(decoder.encoding);
  if (!wide && bytes.includes(0)) throw new TextAttachmentError("the file contains NUL bytes, so it is not text; attach it with its real media type or not at all");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TextAttachmentError(`the file is not valid ${decoder.encoding}${charset === undefined ? "; if it is in another encoding, pass its charset (for example charset: \"windows-1252\")" : ""}`);
  }
}

export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64(bytes)}`;
}

/**
 * Token guesses for the pre-flight estimate, deliberately high (it guards a spending limit): an image costs up to about
 * 1600 to 2000 tokens however large; a PDF is guessed at one token per 25 bytes plus a page's worth. Near a limit the
 * adapter's counting endpoint replaces these with the provider's own figure.
 */
export const IMAGE_TOKEN_GUESS = 2000;
export const pdfTokenGuess = (bytes: number): number => 1500 + Math.ceil(bytes / 25);
