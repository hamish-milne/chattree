import type { Format } from "./formats.ts";
import type { MediaTarget } from "./media-spec.ts";

/**
 * Turns a picture or sound into another format, so that a sink that does not take what the user has can be given something it does
 * (harness/media-spec.ts decides *when*; this does it). Stateless: bytes in, bytes out, nothing remembered between calls, so any number of
 * conversions may run at once and a result depends only on the input, the target and the converter's own identity (`id`), which is what
 * lets the result be cached by those three (docs/tools.md, media formats).
 */
export interface Converter {
  /** Names the converter and its version (`ffmpeg 6.1.1`): part of a cache key, since another encoder may give other bytes. */
  readonly id: string;
  /** Whether `from` can be turned into `to`: the same kind of thing (picture to picture, sound to sound), and a decoder and an encoder for them. */
  can(from: Format, to: MediaTarget): boolean;
  /** The converted bytes. Throws `ConversionError` when the converter cannot do it (it says why, for the person to act on). */
  convert(bytes: Uint8Array, from: Format, to: MediaTarget, signal?: AbortSignal): Promise<Uint8Array>;
}

export class ConversionError extends Error {
  override name = "ConversionError";
}
