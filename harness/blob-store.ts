import { BlobError, sha256Hex, type BlobStore, type Host } from "../src/index.ts";

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
