import type { MediaSpec } from "../harness/media-spec.ts";

/**
 * What each wire carries (harness/media-spec.ts). This is the endpoint, not the model: whether a particular model takes pictures or
 * sound is separate (the catalog's `images`, the local server's `/props`). Preference order is for conversion only.
 */

const MiB = 1024 * 1024;
const PNG = { mime: "image/png" };
const JPEG = { mime: "image/jpeg" };
const GIF = { mime: "image/gif" };
const WEBP = { mime: "image/webp" };

/** Anthropic Messages: image blocks of png, jpeg, gif and webp (5 MiB each) and document blocks of PDF (32 MiB); no sound. */
export const ANTHROPIC_MEDIA: MediaSpec = {
  image: [{ ...PNG, maxBytes: 5 * MiB }, { ...JPEG, maxBytes: 5 * MiB }, { ...GIF, maxBytes: 5 * MiB }, { ...WEBP, maxBytes: 5 * MiB }],
  pdf: [{ mime: "application/pdf", maxBytes: 32 * MiB }],
};

/** OpenAI Responses: input_image of png, jpeg, gif and webp and input_file of PDF; no sound. */
export const RESPONSES_MEDIA: MediaSpec = {
  image: [PNG, JPEG, GIF, WEBP],
  pdf: [{ mime: "application/pdf" }],
};

/**
 * Chat Completions: image_url and input_audio, no PDF. Audio is listed as wav and mp3 (what the API documents) and flac (what
 * llama-server also takes); mp3 first because it is the smallest to send.
 */
export const CHAT_MEDIA: MediaSpec = {
  image: [PNG, JPEG, GIF, WEBP],
  audio: [{ mime: "audio/mpeg" }, { mime: "audio/flac" }, { mime: "audio/wav" }],
};

/**
 * A local llama-server's multimodal projector (tools/mtmd): pictures through stb_image (png, jpeg, gif, bmp; webp only in a build with
 * its video support, so not offered) and sound through miniaudio (wav, mp3, flac), which it mixes to mono and resamples to the model's
 * rate itself, so rate and channels do not matter. No PDF. Lossless first, since the file does not cross a network. What the projector
 * has (`vision`, `audio` from `/props`) decides which kinds are present at all.
 */
export function localMedia(props: { vision?: boolean | undefined; audio?: boolean | undefined }): MediaSpec {
  return {
    ...(props.vision === false ? {} : { image: [PNG, JPEG, GIF, { mime: "image/bmp" }] }),
    ...(props.audio === false ? {} : { audio: [{ mime: "audio/flac" }, { mime: "audio/wav" }, { mime: "audio/mpeg" }] }),
  };
}
