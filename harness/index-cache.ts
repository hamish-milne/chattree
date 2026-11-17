import type { Git, Host } from "../src/index.ts";
import { jsonOr } from "../src/json.ts";

/** The part of an entry reference the cache keeps. Matches `EntryRef` in conversation.ts. */
export interface CachedRef {
  id: string | undefined;
  tag: string;
  commit: string;
  offset: number;
}

export interface CachedIndex {
  /** The commit the list was complete as of. */
  tip: string;
  refs: CachedRef[];
}

/**
 * Where a branch's entry index is kept between runs. The index is derived data (it can always be rebuilt
 * from the commit trailers with `git log`), so a cache may lose entries or be wrong about the tip; the
 * conversation checks what it gets back and rebuilds when it does not fit the branch.
 */
export interface IndexCache {
  load(branch: string): Promise<CachedIndex | undefined>;
  save(branch: string, index: CachedIndex): Promise<void>;
}

/** Keeps each branch's index as a small JSON file under the repository's common git directory (never committed). */
export class FileIndexCache implements IndexCache {
  readonly #host: Host;
  readonly #dir: string;

  constructor(host: Host, dir: string) {
    this.#host = host;
    this.#dir = dir;
  }

  static async forRepository(host: Host, git: Git): Promise<FileIndexCache> {
    return new FileIndexCache(host, host.path.join(await git.commonDir(), "chattree", "index"));
  }

  #path(branch: string): string {
    return this.#host.path.join(this.#dir, `${encodeURIComponent(branch)}.json`);
  }

  async load(branch: string): Promise<CachedIndex | undefined> {
    let text: string;
    try {
      text = new TextDecoder().decode(await this.#host.fs.read(this.#path(branch)));
    } catch {
      return undefined;
    }
    return parseCachedIndex(text);
  }

  async save(branch: string, index: CachedIndex): Promise<void> {
    const rows = index.refs.map((r) => [r.id ?? null, r.tag, r.commit, r.offset]);
    await this.#host.fs.writeAtomic(this.#path(branch), new TextEncoder().encode(JSON.stringify({ v: 1, tip: index.tip, refs: rows })));
  }
}

/** Parse and sanity-check a cache file; anything unexpected yields undefined (rebuild instead). */
export function parseCachedIndex(text: string): CachedIndex | undefined {
  try {
    const raw = jsonOr(JSON.parse(text));
    const { v, tip, refs: rows } = raw;
    if (v !== 1 || typeof tip !== "string" || !Array.isArray(rows)) return undefined;
    const refs: CachedRef[] = [];
    let prev = 0;
    const list: unknown[] = rows;
    for (const row of list) {
      if (!Array.isArray(row) || row.length !== 4) return undefined;
      const id: unknown = row[0];
      const tag: unknown = row[1];
      const commit: unknown = row[2];
      const offset: unknown = row[3];
      if (
        (id !== null && typeof id !== "string") ||
        typeof tag !== "string" ||
        typeof commit !== "string" ||
        !/^[0-9a-f]{40,64}$/.test(commit)
      )
        return undefined;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= prev) return undefined;
      prev = offset;
      refs.push({ id: id === null ? undefined : id, tag, commit, offset });
    }
    if (!/^[0-9a-f]{40,64}$/.test(tip)) return undefined;
    return { tip, refs };
  } catch {
    return undefined;
  }
}
