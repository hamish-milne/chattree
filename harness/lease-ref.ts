import type { Git } from "../src/git/git.ts";
import type { LeaseBackend } from "./lease.ts";

/**
 * Run leases kept as refs on a shared remote (docs/tools.md, 5.3), for clones of one conversation that do not share a git directory.
 * The lease is a ref, `refs/chattree/leases/<thread>`, that points at a commit with an empty tree whose message is the lease (the
 * same JSON the file holds). The remote serializes ref updates, so `git push --force-with-lease=<ref>:<expected>` is the
 * compare-and-swap: creating a lease says "expected: absent", renewing or taking one over says which commit it was, and of two clones that
 * try at once one is refused. Nothing is added to the transcript, and no branch moves.
 *
 * Cost and limits. Every change to a lease is a push and every look is an `ls-remote` (reads are kept for `cacheMs`, default 1 s, and
 * one's own writes are known at once), so this is for the few hosts that need to coordinate, not a default. Deadlines are compared with
 * each reader's own clock: hosts whose clocks differ by more than the headroom of a lease (30 s) can take a live lease for stale.
 * A remote that cannot be reached makes the call fail rather than guess.
 */
export interface RefLeaseOptions {
  /** The remote (a name from `git remote`, or a URL) that every clone pushes to and fetches from. */
  remote: string;
  /** How long what was read from the remote is trusted. Default 1000 ms. */
  cacheMs?: number;
  now?: () => number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const WHO = { name: "chattree", email: "chattree@localhost" };

/** The ref a thread's lease is in: the thread name with everything a ref name may not contain written as %XX. */
export function leaseRef(branch: string): string {
  return `refs/chattree/leases/${encodeURIComponent(branch).replace(/[*'()!~.]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}`;
}

export function refLeaseBackend(git: Git, o: RefLeaseOptions): LeaseBackend {
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 1000;
  /** What a lease commit says, by commit id (commits never change). */
  const bodies = new Map<string, Uint8Array>();
  const looked = new Map<string, { rev: string | undefined; at: number }>();
  let emptyTree: Promise<string> | undefined;

  const commit = async (bytes: Uint8Array): Promise<string> => {
    emptyTree ??= git.text(["mktree"], { stdin: new Uint8Array() });
    const id = await git.commitTree(await emptyTree, [], { message: dec.decode(bytes), author: WHO, committer: WHO });
    bodies.set(id, bytes);
    return id;
  };

  const body = async (rev: string, branch: string): Promise<Uint8Array> => {
    const known = bodies.get(rev);
    if (known !== undefined) return known;
    const ref = leaseRef(branch);
    await git.run(["fetch", "--quiet", "--no-tags", o.remote, ref]);
    const raw = dec.decode((await git.run(["cat-file", "commit", rev], { readOnly: true })).stdout);
    const bytes = enc.encode(raw.slice(raw.indexOf("\n\n") + 2));
    bodies.set(rev, bytes);
    return bytes;
  };

  /** The commit the remote's ref points at, or undefined if there is none. */
  const remoteRev = async (branch: string): Promise<string | undefined> => {
    const ref = leaseRef(branch);
    const c = looked.get(ref);
    if (c !== undefined && now() - c.at < cacheMs) return c.rev;
    const out = (await git.run(["ls-remote", o.remote, ref], { readOnly: true })).stdout;
    const line = dec.decode(out).split("\n").find((l) => l.endsWith(`\t${ref}`));
    const rev = line === undefined ? undefined : (line.split("\t")[0] as string);
    looked.set(ref, { rev, at: now() });
    return rev;
  };

  /** One compare-and-swap push: true if the remote took it, false if the ref was not what was expected. */
  const push = async (branch: string, source: string, expected: string): Promise<boolean> => {
    const ref = leaseRef(branch);
    looked.delete(ref);
    const r = await git.run(["push", "--porcelain", "--quiet", o.remote, `${source}:${ref}`, `--force-with-lease=${ref}:${expected}`], { ok: [1] });
    return r.exitCode === 0;
  };

  return {
    async read(branch) {
      const rev = await remoteRev(branch);
      if (rev === undefined) return undefined;
      try {
        return { bytes: await body(rev, branch), rev };
      } catch {
        return { bytes: new Uint8Array(), rev }; // a lease that cannot be read is stale, and can be taken over by its rev
      }
    },
    async create(branch, bytes) {
      const id = await commit(bytes);
      if (!(await push(branch, id, ""))) return undefined;
      looked.set(leaseRef(branch), { rev: id, at: now() });
      return { rev: id };
    },
    async update(branch, bytes, rev) {
      const id = await commit(bytes);
      if (!(await push(branch, id, rev))) return undefined;
      looked.set(leaseRef(branch), { rev: id, at: now() });
      return { rev: id };
    },
    async remove(branch, rev) {
      return push(branch, "", rev);
    },
  };
}
