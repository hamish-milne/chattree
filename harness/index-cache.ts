import type { Git, Host } from "../src/index.ts";

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
    const raw = JSON.parse(text) as { v?: unknown; tip?: unknown; refs?: unknown };
    if (raw.v !== 1 || typeof raw.tip !== "string" || !Array.isArray(raw.refs)) return undefined;
    const refs: CachedRef[] = [];
    let prev = 0;
    for (const row of raw.refs as unknown[]) {
      if (!Array.isArray(row) || row.length !== 4) return undefined;
      const [id, tag, commit, offset] = row as [unknown, unknown, unknown, unknown];
      if ((id !== null && typeof id !== "string") || typeof tag !== "string" || typeof commit !== "string" || !/^[0-9a-f]{40,64}$/.test(commit)) return undefined;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= prev) return undefined;
      prev = offset;
      refs.push({ id: id === null ? undefined : id, tag, commit, offset });
    }
    if (!/^[0-9a-f]{40,64}$/.test(raw.tip)) return undefined;
    return { tip: raw.tip, refs };
  } catch {
    return undefined;
  }
}
