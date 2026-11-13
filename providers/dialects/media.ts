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
/** The text of a tool result, and the server's marker after it for each picture or sound it shows (`media` gets them, in order). */
export function resultContent(r: { content: string; media?: AttachmentPart[] }, marker: string | undefined, media: AttachmentPart[], frame: AudioFrame = "none"): string {
  if (r.media === undefined) return r.content;
  const markers: string[] = [];
  for (const p of r.media) {
    if (p.kind === "pdf") throw new ProviderError({ kind: "invalid_request", message: `${p.name ?? "a PDF"} cannot be sent: only pictures and sound can be sent to a local model; send the text of a PDF instead` });
    if (marker === undefined) throw new ProviderError({ kind: "invalid_request", message: `this request has ${p.kind === "audio" ? "sound" : "a picture"} in a tool result, and the server has not said how to mark it` });
    media.push(p);
    markers.push(framed(p, marker, frame));
  }
  return `${r.content}\n${markers.join("\n")}`;
}

/**
 * How a sound is introduced in the prompt (`dialect_options.audio_frame`). A speech encoder gives the model embeddings that look like the
 * words themselves, so a bare marker reads as stray text and the model says no audio was attached (Gemma 4 12B, docs/local-models.md 9.11).
 * `label` says in words that a sound follows; `transcript` says what follows is what was heard; `none` leaves the marker bare.
 */
export type AudioFrame = "none" | "label" | "transcript";
export const AUDIO_FRAMES: readonly AudioFrame[] = ["none", "label", "transcript"];
export const audioFrameOf = (options: Record<string, unknown>): AudioFrame => (AUDIO_FRAMES.includes(options["audio_frame"] as AudioFrame) ? (options["audio_frame"] as AudioFrame) : "label");

/** The marker for a sound, with the lines around it that `frame` asks for. Only sound is framed. */
export function framed(p: AttachmentPart, marker: string, frame: AudioFrame): string {
  if (p.kind !== "audio" || frame === "none") return marker;
  const name = p.name === undefined || p.name.includes(marker) ? "" : ` ${JSON.stringify(p.name)}`;
  return frame === "label"
    ? `[Audio clip${name}, attached as sound. It is not text: you hear it.]\n${marker}\n[End of audio clip.]`
    : `[The audio clip${name} attached here is heard by you as follows:]\n${marker}\n[End of audio clip.]`;
}

export function userContent(parts: readonly UserPart[], marker: string | undefined, media: AttachmentPart[], join = "\n\n", frame: AudioFrame = "none"): string {
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
    pieces.push(framed(p, marker, frame));
    isImage.push(true);
  }
  // A picture and its neighbours are only a line apart; text runs are `join` apart.
  return pieces.reduce((out, p, i) => (i === 0 ? p : `${out}${isImage[i] === true || isImage[i - 1] === true ? "\n" : join}${p}`), "").trim();
}
