import { createHash } from "node:crypto";
import type { Host } from "../src/host.ts";

/**
 * Which `harness.yml` each thread has been approved to run with (docs/tools.md, section 6). The file decides which providers get which
 * keys, what runs without asking, which programs start and which files are read, and a cloned repository (or a model that can write files)
 * can change it. So the harness keeps, outside the repository, a map from branch name to the hash of the file the user approved, in
 * `<git dir>/chattree/config-trust.json`, and uses the file only while it matches. Anything the harness itself does for the user (a grant,
 * an undo, a fork, a merge of approved files) moves the entry with it; anything else needs `approveConfig`.
 *
 * Not locked: two processes writing at once can lose an entry, and a lost entry only means one more approval.
 */

/** The hash a thread without a `harness.yml` has. Nothing to approve, so it is always trusted. */
export const NO_CONFIG = "none";

export const configHash = (bytes: Uint8Array | undefined): string => (bytes === undefined ? NO_CONFIG : createHash("sha256").update(bytes).digest("hex"));

/** `trusted`: the file is the one approved (or there is none). `unknown`: this thread has never been approved. `changed`: it was, and the file is another now. */
export interface ConfigTrust {
  state: "trusted" | "unknown" | "changed";
  /** The hash of the file now. */
  hash: string;
  /** The hash that was approved, if any. */
  approved?: string;
}

export function judge(approved: string | undefined, hash: string): ConfigTrust {
  if (hash === NO_CONFIG || approved === hash) return { state: "trusted", hash, ...(approved === undefined ? {} : { approved }) };
  return { state: approved === undefined ? "unknown" : "changed", hash, ...(approved === undefined ? {} : { approved }) };
}

/** A thread's `harness.yml` is not the one the user approved. */
export class ConfigNotTrusted extends Error {
  override name = "ConfigNotTrusted";
  readonly branch: string;
  readonly trust: ConfigTrust;
  constructor(branch: string, trust: ConfigTrust) {
    super(
      trust.state === "unknown"
        ? `harness.yml has not been approved for thread ${branch}: it came from outside chattree, so nothing in it is used until you approve it`
        : `harness.yml has changed outside chattree since you approved it for thread ${branch}: nothing in it is used until you approve it again`,
    );
    this.branch = branch;
    this.trust = trust;
  }
}

const dec = new TextDecoder();
const enc = new TextEncoder();

export class TrustStore {
  readonly #host: Host;
  readonly #path: string;

  constructor(host: Host, gitCommonDir: string) {
    this.#host = host;
    this.#path = host.path.join(gitCommonDir, "chattree", "config-trust.json");
  }

  async #read(): Promise<Record<string, string>> {
    if ((await this.#host.fs.stat(this.#path)) === undefined) return {};
    try {
      const v: unknown = JSON.parse(dec.decode(await this.#host.fs.read(this.#path)));
      const branches = typeof v === "object" && v !== null ? (v as { branches?: unknown }).branches : undefined;
      if (typeof branches !== "object" || branches === null) return {};
      return Object.fromEntries(Object.entries(branches).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {}; // a damaged file approves nothing
    }
  }

  async get(branch: string): Promise<string | undefined> {
    return (await this.#read())[branch];
  }

  async set(branch: string, hash: string): Promise<void> {
    const all = await this.#read();
    if (all[branch] === hash) return;
    all[branch] = hash;
    await this.#write(all);
  }

  async forget(branch: string): Promise<void> {
    const all = await this.#read();
    if (!(branch in all)) return;
    delete all[branch];
    await this.#write(all);
  }

  async #write(branches: Record<string, string>): Promise<void> {
    await this.#host.fs.mkdir(this.#host.path.dirname(this.#path));
    const sorted = Object.fromEntries(Object.entries(branches).sort(([a], [b]) => (a < b ? -1 : 1)));
    await this.#host.fs.writeAtomic(this.#path, enc.encode(`${JSON.stringify({ version: 1, branches: sorted }, null, 2)}\n`));
  }
}
