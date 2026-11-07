import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The record of what was fetched (docs/local-models.md, section 3): the SHA-256 and size of every program archive and model file the
 * first time it arrives, and which files a quantisation named. A recorded file is trusted without asking the network again, so the
 * host starts offline; a changed hash on a recorded program is refused, not replaced.
 */

export interface LockedFile {
  sha256: string;
  size: number;
}

interface LockData {
  version: 1;
  /** Keys are paths relative to the data directory, with `/`. */
  files: Record<string, LockedFile>;
  /** `repo@revision:quant` → the repository paths it named. */
  quants: Record<string, string[]>;
}

export class LockError extends Error {
  override name = "LockError";
}

export class Lock {
  readonly #path: string;
  readonly #data: LockData;

  private constructor(path: string, data: LockData) {
    this.#path = path;
    this.#data = data;
  }

  static async open(path: string): Promise<Lock> {
    let data: LockData = { version: 1, files: {}, quants: {} };
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) {
      try {
        const v = JSON.parse(text) as Partial<LockData>;
        if (v.version !== 1 || typeof v.files !== "object" || v.files === null) throw new Error("unknown format");
        data = { version: 1, files: v.files, quants: v.quants ?? {} };
      } catch (e) {
        throw new LockError(`${path} is not a lock file chattree wrote (${e instanceof Error ? e.message : String(e)}); move it away to start again`);
      }
    }
    return new Lock(path, data);
  }

  file(key: string): LockedFile | undefined {
    return this.#data.files[key];
  }

  setFile(key: string, f: LockedFile): void {
    this.#data.files[key] = f;
  }

  /** The recorded files whose key starts with this prefix. */
  filesUnder(prefix: string): [string, LockedFile][] {
    return Object.entries(this.#data.files).filter(([k]) => k.startsWith(prefix));
  }

  deleteFile(key: string): void {
    delete this.#data.files[key];
  }

  deleteQuant(key: string): void {
    delete this.#data.quants[key];
  }

  quant(key: string): string[] | undefined {
    return this.#data.quants[key];
  }

  setQuant(key: string, paths: string[]): void {
    this.#data.quants[key] = paths;
  }

  async save(): Promise<void> {
    const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const out = { version: 1, files: sorted(this.#data.files), quants: sorted(this.#data.quants) };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`);
    await rename(tmp, this.#path);
  }
}
