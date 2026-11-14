import { formatOf, type Format } from "./formats.ts";

/**
 * What a sink takes, and what to do with a file that is not in a form it takes (docs/tools.md, media formats). A sink is a provider's
 * wire or a local server; it says, per kind, the formats it accepts in order of preference. A file already in an accepted format
 * passes untouched, however low it is in the list: the order only says what to convert *to* when a conversion is needed, and the first
 * accepted format that the converter can make is the one used.
 */

export type MediaKind = "image" | "audio" | "pdf";

export interface MediaTarget {
  mime: string;
  /** The largest file the sink takes in this format, in bytes. A larger one is refused: the converter does not shrink (yet). */
  maxBytes?: number;
}

export type MediaSpec = { [K in MediaKind]?: readonly MediaTarget[] };

export type MediaPlan =
  | { action: "pass" }
  | { action: "convert"; to: MediaTarget }
  | { action: "refuse"; reason: string };

const NOUN: Record<MediaKind, string> = { image: "pictures", audio: "sound", pdf: "PDFs" };

const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;

/**
 * What to do with a file of this format and size for a sink. `canConvert` says whether the converter can make `to` from `from` (the
 * default: anything in the same kind); when none of the accepted targets can be made, the file is refused with the reason, which says
 * what is accepted so that the message can tell the user what to do.
 */
export function planMedia(
  format: Format | undefined,
  size: number,
  spec: MediaSpec,
  canConvert: (from: Format, to: MediaTarget) => boolean = () => true,
): MediaPlan {
  if (format === undefined) return { action: "refuse", reason: "it is not a picture, sound or PDF that is known" };
  if (format.kind === "video") return { action: "refuse", reason: "video is not supported yet" };
  const targets = spec[format.kind];
  if (targets === undefined || targets.length === 0) return { action: "refuse", reason: `this model does not take ${NOUN[format.kind]}` };
  const same = targets.find((t) => formatOf(t.mime)?.mime === format.mime);
  if (same !== undefined) {
    if (same.maxBytes !== undefined && size > same.maxBytes) return { action: "refuse", reason: `at ${mb(size)} it is over the ${mb(same.maxBytes)} this model takes in ${format.mime}; make a smaller copy (lower resolution or a shorter clip)` };
    return { action: "pass" };
  }
  const accepted = targets.map((t) => formatOf(t.mime)?.label ?? t.mime).join(", ");
  if (format.kind === "pdf") return { action: "refuse", reason: `${format.label} cannot be converted; this model takes ${accepted}` };
  const to = targets.find((t) => canConvert(format, t));
  if (to === undefined) return { action: "refuse", reason: `${format.label} is not one this model takes (it takes ${accepted}) and cannot be converted to one of them` };
  return { action: "convert", to };
}
