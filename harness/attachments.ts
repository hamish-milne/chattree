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
