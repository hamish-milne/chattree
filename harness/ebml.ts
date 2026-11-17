/**
 * Which kinds of track a WebM or Matroska file holds, read from its track list. Both are the same container, and `file-type` names an
 * audio-only recording (what a browser's recorder makes) a video, so the format registry asks here before it settles on "video".
 *
 * Only as much of EBML as that takes: elements are an id, a size and a body; the few master elements on the way to a track's type
 * (Segment, Tracks, TrackEntry) are entered and everything else is skipped by its size. The walk stops at the first Cluster (the media
 * itself, which comes after the track list) or at anything it cannot step over, and says nothing rather than guess.
 */

const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_TYPE = 0x83;
const CLUSTER = 0x1f43b675;

const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;

/** An element's id (its marker bits kept, as they are written in the spec) and its length in bytes; undefined if it does not fit. */
function readId(b: Uint8Array, at: number): { id: number; length: number } | undefined {
  const first = b[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 24 + 1;
  if (length > 4 || at + length > b.length) return undefined;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + (b[at + i] ?? 0);
  return { id, length };
}

/** An element's body size and the length of the size field; `size` is undefined for the "unknown" size a live stream uses. */
function readSize(b: Uint8Array, at: number): { size: number | undefined; length: number } | undefined {
  const first = b[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 24 + 1;
  if (at + length > b.length) return undefined;
  let size = first & (0xff >> length);
  let allOnes = size === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = b[at + i] ?? 0;
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { size: allOnes ? undefined : size, length };
}

/** What the track list says is there; undefined when there is no track list in the bytes, or it names no track of a known type. */
export function trackKinds(bytes: Uint8Array): { video: boolean; audio: boolean } | undefined {
  const found = { video: false, audio: false };
  let sawTracks = false;

  // Walks the elements in [from, to) and returns false when the whole walk should stop.
  const walk = (from: number, to: number, inEntry: boolean): boolean => {
    let at = from;
    while (at < to) {
      const id = readId(bytes, at);
      if (id === undefined) return false;
      const sz = readSize(bytes, at + id.length);
      if (sz === undefined) return false;
      const body = at + id.length + sz.length;
      const end = sz.size === undefined ? to : body + sz.size;
      if (id.id === CLUSTER) return false; // the media: the track list is behind us
      if (id.id === SEGMENT || id.id === TRACKS || id.id === TRACK_ENTRY) {
        if (id.id === TRACKS) sawTracks = true;
        if (!walk(body, Math.min(end, to), inEntry || id.id === TRACK_ENTRY)) return false;
      } else if (id.id === TRACK_TYPE && inEntry && sz.size === 1) {
        const type = bytes[body];
        if (type === TYPE_VIDEO) found.video = true;
        else if (type === TYPE_AUDIO) found.audio = true;
      } else if (sz.size === undefined || end > bytes.length) {
        return false; // cannot step over it: unknown length, or beyond the bytes we were given
      }
      at = end;
    }
    return true;
  };

  walk(0, bytes.length, false);
  return sawTracks && (found.video || found.audio) ? found : undefined;
}
