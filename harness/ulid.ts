const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encode(n: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ENC[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/**
 * A monotonic ULID generator: ids sort by creation time, and ids created within the same millisecond
 * still sort in creation order (the random part is incremented instead of redrawn).
 */
export function createUlid(now: () => number = Date.now): () => string {
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    let time = now();
    let random: bigint;
    if (time <= lastTime) {
      time = lastTime;
      random = lastRandom + 1n;
      if (random >= 1n << 80n) throw new Error("ULID random part overflowed within one millisecond");
    } else {
      random = 0n;
      for (const b of crypto.getRandomValues(new Uint8Array(10))) random = (random << 8n) | BigInt(b);
    }
    lastTime = time;
    lastRandom = random;
    return encode(BigInt(time), 10) + encode(random, 16);
  };
}

/** Milliseconds since the epoch encoded in a ULID. */
export function ulidTime(id: string): number {
  let n = 0;
  for (const c of id.slice(0, 10)) n = n * 32 + ENC.indexOf(c);
  return n;
}
