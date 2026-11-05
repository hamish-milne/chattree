import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { FetchError, fetchFollow, type FetchFn } from "./net.ts";

/**
 * One file, downloaded to `dest` (docs/local-models.md, section 3): written to `dest.part`, continued from where it stopped with a Range
 * request, checked against its size and SHA-256, and renamed into place only when it is right. Nothing half-written is ever at `dest`.
 */

export interface Progress {
  received: number;
  /** Undefined when the server did not say. */
  total: number | undefined;
}

export interface DownloadOptions {
  url: string;
  dest: string;
  /** The SHA-256 (hex) the file must have. A file that does not is deleted and is a `DownloadError`. */
  sha256?: string | undefined;
  /** The size the file must have, when it is known beforehand. */
  size?: number | undefined;
  token?: string | undefined;
  fetch?: FetchFn | undefined;
  onProgress?: ((p: Progress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export class DownloadError extends Error {
  override name = "DownloadError";
  readonly kind: "hash" | "size" | "network";
  constructor(message: string, kind: "hash" | "size" | "network") {
    super(message);
    this.kind = kind;
  }
}

export interface Downloaded {
  sha256: string;
  size: number;
  /** False when `dest` was already there and nothing was fetched. */
  fetched: boolean;
}

/** Feed a file, read in a stream, to a hash. */
function feed(path: string, h: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createReadStream(path);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve());
  });
}

/** SHA-256 (hex) of a file. */
export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  await feed(path, h);
  return h.digest("hex");
}

const sizeOf = async (path: string): Promise<number | undefined> => (await stat(path).catch(() => undefined))?.size;

/** `Content-Range: bytes 100-199/200` → the total. */
const totalFromRange = (v: string | null): number | undefined => {
  const m = v === null ? null : /\/(\d+)\s*$/.exec(v);
  return m === null ? undefined : Number(m[1]);
};

export async function downloadFile(o: DownloadOptions): Promise<Downloaded> {
  const want = o.sha256?.toLowerCase();
  const have = await sizeOf(o.dest);
  if (have !== undefined) {
    if (o.size === undefined || o.size === have) {
      const sha = await hashFile(o.dest);
      if (want === undefined || sha === want) return { sha256: sha, size: have, fetched: false };
    }
    await rm(o.dest); // present but not the file asked for (the settings changed): fetch it again
  }
  await mkdir(dirname(o.dest), { recursive: true });
  const part = `${o.dest}.part`;
  let restarted = false;
  for (;;) {
    const offset = (await sizeOf(part)) ?? 0;
    const hash = createHash("sha256");
    if (offset > 0) await feed(part, hash);
    const res = await fetchFollow(o.url, { fetch: o.fetch, token: o.token, signal: o.signal, headers: offset > 0 ? { range: `bytes=${offset}-` } : {} });

    const start = async (): Promise<boolean> => {
      // a part that cannot be continued is thrown away, once
      await res.body?.cancel();
      await rm(part, { force: true });
      if (restarted) throw new FetchError(`${o.url} would not give the file from the start`);
      restarted = true;
      return true;
    };
    if (res.status === 416) {
      if (totalFromRange(res.headers.get("content-range")) === offset && offset > 0) await res.body?.cancel();
      else {
        await start();
        continue;
      }
    } else if (res.status === 200 && offset > 0) {
      await start(); // the server ignored the range
      continue;
    } else {
      const len = res.headers.get("content-length");
      const total = res.status === 206 ? totalFromRange(res.headers.get("content-range")) : len === null ? undefined : Number(len);
      const expected = total ?? o.size;
      const fh = await open(part, offset > 0 ? "a" : "w");
      let received = offset;
      try {
        if (res.body === null) throw new FetchError(`${o.url} sent no data`);
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          await fh.write(chunk);
          received += chunk.byteLength;
          o.onProgress?.({ received, total: expected });
        }
      } catch (e) {
        await fh.close();
        if (o.signal?.aborted === true) throw e;
        throw new DownloadError(`the download of ${o.url} stopped after ${received} bytes (${e instanceof Error ? e.message : String(e)}); running it again continues from there`, "network");
      }
      await fh.close();
      if (expected !== undefined && received < expected) throw new DownloadError(`the download of ${o.url} ended early (${received} of ${expected} bytes); running it again continues from there`, "network");
    }

    const size = (await sizeOf(part)) ?? 0;
    if (o.size !== undefined && size !== o.size) {
      await rm(part, { force: true });
      throw new DownloadError(`${o.url} is ${size} bytes, expected ${o.size}`, "size");
    }
    const sha = hash.digest("hex");
    if (want !== undefined && sha !== want) {
      await rm(part, { force: true });
      throw new DownloadError(`${o.url} is not the expected file (sha256 ${sha}, expected ${want}), so it was not kept`, "hash");
    }
    await rename(part, o.dest);
    return { sha256: sha, size, fetched: true };
  }
}
