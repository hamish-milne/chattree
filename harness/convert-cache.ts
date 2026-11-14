import { createHash } from "node:crypto";
import type { Host } from "../src/host.ts";

/**
 * Converted pictures and sounds, kept so that the same file is not converted again on every request. Lives in the git directory
 * (`<common dir>/chattree/convert/`), so it is never committed and never part of the history: it only saves time, and anything in it can
 * be deleted. A file is named for the source's hash, the target format and the converter that made it (`ffmpeg 6.1.1`), because another
 * converter may give other bytes. When the directory cannot be written the cache simply misses and conversion happens on the fly.
 */
export interface ConvertCache {
  get(key: ConvertKey): Promise<Uint8Array | undefined>;
  put(key: ConvertKey, bytes: Uint8Array): Promise<void>;
}

export interface ConvertKey {
  /** sha256 of the source bytes, hex. */
  source: string;
  /** The target format's mime. */
  to: string;
  /** The converter's `id`. */
  converter: string;
}

export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const fileName = (k: ConvertKey): string => `${k.source}.${slug(k.to)}.${createHash("sha256").update(k.converter).digest("hex").slice(0, 10)}`;

/** The cache in `dir`, kept to about `maxBytes` by removing the least recently written files first. */
export function hostConvertCache(host: Host, dir: string, maxBytes: number = DEFAULT_CACHE_BYTES): ConvertCache {
  return {
    async get(key) {
      try {
        return await host.fs.read(host.path.join(dir, fileName(key)));
      } catch {
        return undefined;
      }
    },
    async put(key, bytes) {
      try {
        await host.fs.mkdir(dir);
        await host.fs.writeAtomic(host.path.join(dir, fileName(key)), bytes);
        const files: { path: string; size: number; at: number }[] = [];
        for (const name of await host.fs.readdir(dir)) {
          const path = host.path.join(dir, name);
          const st = await host.fs.stat(path);
          if (st !== undefined) files.push({ path, size: st.size, at: st.mtimeMs ?? 0 });
        }
        let total = files.reduce((n, f) => n + f.size, 0);
        for (const f of files.sort((a, b) => a.at - b.at)) {
          if (total <= maxBytes || f.path.endsWith(fileName(key))) break;
          await host.fs.remove(f.path);
          total -= f.size;
        }
      } catch {
        // an unwritable cache is only a slower request
      }
    },
  };
}
