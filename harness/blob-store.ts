import { BlobError, sha256Hex, type BlobStore, type Host } from "../src/index.ts";

/** Where blobs live, relative to the repository root. */
export const BLOBS_DIR = "blobs";

/**
 * Content-addressed blobs as files in the working tree: `<root>/ab/cdef...` (first two hex digits as a
 * directory). Because they are plain files they are committed with the entry that references them, and they
 * travel with forks and subagent branches.
 */
export class HostBlobStore implements BlobStore {
  readonly #host: Host;
  readonly #root: string;

  constructor(host: Host, root: string) {
    this.#host = host;
    this.#root = root;
  }

  /** The blob's path relative to the repository root, with `/` separators (as git sees it). */
  static relativePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BlobError(`not a SHA-256: ${JSON.stringify(sha256)}`);
    return `${BLOBS_DIR}/${sha256.slice(0, 2)}/${sha256.slice(2)}`;
  }

  #pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BlobError(`not a SHA-256: ${JSON.stringify(sha256)}`);
    return this.#host.path.join(this.#root, sha256.slice(0, 2), sha256.slice(2));
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = await sha256Hex(data);
    const path = this.#pathFor(hash);
    // Content-addressed, so an existing file already has these bytes.
    if ((await this.#host.fs.stat(path)) === undefined) await this.#host.fs.writeAtomic(path, data);
    return hash;
  }

  async get(sha256: string): Promise<Uint8Array | undefined> {
    const path = this.#pathFor(sha256);
    if ((await this.#host.fs.stat(path)) === undefined) return undefined;
    return this.#host.fs.read(path);
  }
}

/** Every blob a decoded entry refers to: its hash and the size the reference claims. */
export function blobRefs(value: unknown, into: Map<string, number> = new Map()): Map<string, number> {
  if (Array.isArray(value)) for (const x of value) blobRefs(x, into);
  else if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    if (o["$tag"] === "blob" && typeof o["sha256"] === "string" && typeof o["bytes"] === "number") into.set(o["sha256"], o["bytes"]);
    else for (const x of Object.values(o)) blobRefs(x, into);
  }
  return into;
}

/**
 * Collects blobs in memory instead of writing them, falling back to a real store for reads. Used when an
 * entry is committed straight into git (a new branch, a merge) so its blobs can be added to that commit's tree
 * and not left as stray files in a worktree that does not have the entry.
 */
export class RecordingBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly #fallback: BlobStore | undefined;

  constructor(fallback?: BlobStore) {
    this.#fallback = fallback;
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = await sha256Hex(data);
    this.blobs.set(hash, data.slice());
    return hash;
  }

  async get(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256) ?? this.#fallback?.get(sha256);
  }
}
