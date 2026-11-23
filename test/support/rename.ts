import { rename } from "node:fs/promises";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Rename a folder, retrying on Windows while something still holds a handle inside it (Defender's scan of files just written, the
 * indexer, a git process shutting down). Backoff from 100 ms, up to about 5 s in all; elsewhere it is a plain rename.
 */
export async function renameRetrying(from: string, to: string): Promise<void> {
  const budget = process.platform === "win32" ? 5000 : 0;
  let waited = 0;
  for (let delay = 100; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (waited >= budget || !TRANSIENT.has(code)) throw e;
      await new Promise((r) => setTimeout(r, delay));
      waited += delay;
    }
  }
}
