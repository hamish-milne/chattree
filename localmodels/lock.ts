/**
 * The record of what was fetched: the SHA-256 and size of every program archive and model file the first time it arrives, and which
 * files a quantisation named. A recorded file is trusted without asking the network again, so the host starts offline; a changed hash on
 * a recorded program is refused by install.ts, not replaced. Written by replacing the whole file, so a crash leaves the old one.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { safeParse, withDefault } from "../src/validate.ts";

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

/** What a lock file says, read back as written (a missing `quants` is an older file's). */
const LOCK_FILE = Type.Object({
  version: Type.Literal(1),
  files: Type.Record(Type.String(), Type.Object({ sha256: Type.String(), size: Type.Number() })),
  quants: withDefault(Type.Record(Type.String(), Type.Array(Type.String())), {}),
});

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

  /** A missing file is an empty lock; a file that does not parse is a `LockError`, never silently replaced (its records would be lost). */
  static async open(path: string): Promise<Lock> {
    let data: LockData = { version: 1, files: {}, quants: {} };
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) {
      try {
        const v = safeParse(LOCK_FILE, JSON.parse(text));
        if (!v.ok) throw new Error("unknown format");
        data = v.value;
      } catch (e) {
        throw new LockError(
          `${path} is not a lock file chattree wrote (${e instanceof Error ? e.message : String(e)}); move it away to start again`,
        );
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

  /**
   * Written to a `.tmp` file and renamed over the lock, so a crash mid-write leaves the last good lock in place. Keys are sorted, so the
   * file diffs cleanly.
   */
  async save(): Promise<void> {
    const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const out = { version: 1, files: sorted(this.#data.files), quants: sorted(this.#data.quants) };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`);
    await rename(tmp, this.#path);
  }
}
