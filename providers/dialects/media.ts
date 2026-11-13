import type { AttachmentPart, UserPart } from "../../harness/context-builder.ts";
import { ProviderError } from "../types.ts";

/**
 * How a user turn is written into a prompt that goes to llama-server's `/completion`: the text of its parts, and the server's media
 * marker where a picture is, one marker for each picture. The server swaps each marker for the picture's embedding (and writes the
 * tokens around it that its projector wants), so a dialect has nothing to say of pictures except where they stand.
 *
 * `marker` is undefined when the transport has not been told one (render is pure and the marker belongs to the server); a turn with a
 * picture then cannot be written.
 */
export function userContent(parts: readonly UserPart[], marker: string | undefined, media: AttachmentPart[], join = "\n\n"): string {
  const pieces: string[] = [];
  const isImage: boolean[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      pieces.push(p.text);
      isImage.push(false);
      continue;
    }
    if (p.kind === "pdf") throw new ProviderError({ kind: "invalid_request", message: `${p.name ?? "a PDF"} cannot be sent: only pictures and sound can be sent to a local model; send the text of a PDF instead` });
    if (marker === undefined) throw new ProviderError({ kind: "invalid_request", message: `this request has ${p.kind === "audio" ? "sound" : "a picture"}, and the server has not said how to mark it` });
    media.push(p);
    pieces.push(marker);
    isImage.push(true);
  }
  // A picture and its neighbours are only a line apart; text runs are `join` apart.
  return pieces.reduce((out, p, i) => (i === 0 ? p : `${out}${isImage[i] === true || isImage[i - 1] === true ? "\n" : join}${p}`), "").trim();
}
