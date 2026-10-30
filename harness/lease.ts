import type { Fs } from "../src/host.ts";

/**
 * The run lease (docs/tools.md, 5.3): who is running a thread, and until when. It is separate from the append lock (`lock.ts`), which is
 * taken for the length of one write: the lease is held for as long as a loop executes in the foreground or a background job runs, and
 * while it is held other sessions can still append (a user message, an approval).
 *
 * The lease is a small file in the repository's shared git directory, one per thread, written by the host that runs it and never
 * committed. It says what holds it, each with a deadline: `loop` while the loop is working (set from the timeout of each request and tool
 * call, so a live host never needs to refresh anything), `job:j1` for a background job (until its timeout), and a followed thread
 * (a subagent's branch: the parent is live while the child is). The lease is live until the latest deadline; a lease that has passed
 * its deadline, or whose owner is known to be dead, is stale and is taken over. When the last hold goes the file is removed.
 *
 * What the file tells a reader that the transcript cannot: a call without a result while the lease is `live` is running; while it is
 * `stale` the host died with the call in flight, so it may have started; with no lease the last loop ended cleanly, and a call without
 * a result was never started (it was waiting for a decision).
 *
 * The id is one per `LeaseStore`, which a process shares across every handle on the same repository, so a loop and the background jobs it
 * started share one lease. Where it is kept is a `LeaseBackend`: a file here, or a ref on a shared remote to make it atomic across clones (`lease-ref.ts`).
 */

export interface LeaseOwner {
  pid?: number;
  host?: string;
  session?: string;
}

/** The clock and the way to tell a dead owner, as the caller sees them. `isDead` is only asked about owners that are not this store. */
export interface LeaseEnv {
  now: () => number;
  isDead?: (owner: LeaseOwner) => boolean;
}

export type LeaseState =
  /** No lease: nothing is running, and the last run ended cleanly. */
  | { state: "free" }
  | { state: "live"; owner: LeaseOwner; until: number; holding: string[] }
  /** A lease whose holder is gone or past its deadline: whatever it was running may have been cut off. */
  | { state: "stale"; owner: LeaseOwner; until: number };

/** What `hold` and `follow` say about the lease as they found it. */
export type LeaseBefore = "free" | "stale" | "ours";

export class ThreadBusy extends Error {
  override name = "ThreadBusy";
  readonly branch: string;
  readonly holder: Extract<LeaseState, { state: "live" }>;
  constructor(branch: string, holder: Extract<LeaseState, { state: "live" }>) {
    const o = holder.owner;
    const who = o.session !== undefined ? `session ${o.session}` : o.pid !== undefined ? `process ${o.pid}` : "another process";
    super(`${branch} is being run by ${who} (${holder.holding.join(", ") || "busy"})`);
    this.branch = branch;
    this.holder = holder;
  }
}

interface LeaseFile {
  v: 1;
  /** The store that wrote it. */
  id: string;
  owner: LeaseOwner;
  since: number;
  /** What holds the lease, and until when (ms since the epoch, by the holder's clock). */
  holds: Record<string, number>;
  /** Threads whose lease keeps this one live, by what follows them. */
  follows: Record<string, string>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function parse(bytes: Uint8Array): LeaseFile | undefined {
  try {
    const v = JSON.parse(dec.decode(bytes)) as Partial<LeaseFile>;
    if (v.v === 1 && typeof v.id === "string" && typeof v.since === "number" && typeof v.holds === "object" && v.holds !== null && typeof v.follows === "object" && v.follows !== null) {
      return { v: 1, id: v.id, owner: v.owner ?? {}, since: v.since, holds: v.holds, follows: v.follows };
    }
  } catch {
    /* unreadable */
  }
  return undefined;
}

/**
 * Where a lease is kept. The store's rules (holds, follows, deadlines, takeover) do not depend on it; what they need is create-if-absent
 * and compare-and-swap, which a file in the git directory gives within one machine and a ref on a shared remote gives across clones
 * (`lease-ref.ts`). `rev` is an opaque version of what was read: an update or removal that names it applies only if that is still what is there.
 */
export interface LeaseBackend {
  read(branch: string): Promise<{ bytes: Uint8Array; rev: string } | undefined>;
  /** Make the lease if there is none. False if there is one. */
  create(branch: string, bytes: Uint8Array): Promise<{ rev: string } | undefined>;
  /** Replace the lease if it is still at `rev`. The new rev, or undefined if it has changed (it was taken over). */
  update(branch: string, bytes: Uint8Array, rev: string): Promise<{ rev: string } | undefined>;
  /** Remove the lease if it is still at `rev`. False if it has changed (someone else took it over first). */
  remove(branch: string, rev: string): Promise<boolean>;
}

/** Leases as files, one per thread, under the repository's git directory (one machine). */
export function fileLeaseBackend(fs: Fs, file: (branch: string) => string): LeaseBackend {
  const revOf = (bytes: Uint8Array): string => dec.decode(bytes);
  return {
    async read(branch) {
      try {
        const bytes = await fs.read(file(branch));
        return { bytes, rev: revOf(bytes) };
      } catch {
        // A file that is there but cannot be read is a lease nobody can vouch for: stale.
        return (await fs.stat(file(branch))) === undefined ? undefined : { bytes: new Uint8Array(), rev: "" };
      }
    },
    async create(branch, bytes) {
      return (await fs.createExclusive(file(branch), bytes)) ? { rev: revOf(bytes) } : undefined;
    },
    async update(branch, bytes, rev) {
      const now = await this.read(branch);
      if (now === undefined || now.rev !== rev) return undefined;
      await fs.writeAtomic(file(branch), bytes);
      return { rev: revOf(bytes) };
    },
    async remove(branch) {
      // Taking a stale lease over: moved aside first, so that of two processes only one succeeds.
      const aside = `${file(branch)}.stale-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await fs.rename(file(branch), aside);
        await fs.remove(aside);
        return true;
      } catch {
        return false;
      }
    },
  };
}

type Mine = { owner: LeaseOwner; since: number; holds: Record<string, number>; follows: Record<string, string>; rev: string };

export class LeaseStore {
  /** One per process and repository, for the life of the process: the lease says whose it is by this. */
  readonly id = crypto.randomUUID();
  readonly #backend: LeaseBackend;
  readonly #mine = new Map<string, Mine>();
  readonly #chain = new Map<string, Promise<unknown>>();

  /** A backend, or (the usual case) `fs` and `file`: where a thread's lease file lives, under the repository's shared git directory. */
  constructor(backend: LeaseBackend);
  constructor(fs: Fs, file: (branch: string) => string);
  constructor(a: LeaseBackend | Fs, file?: (branch: string) => string) {
    this.#backend = file === undefined ? (a as LeaseBackend) : fileLeaseBackend(a as Fs, file);
  }

  /** Run `fn` after the earlier operations on the same thread, so this process never interleaves its own writes. */
  #serial<T>(branch: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#chain.get(branch) ?? Promise.resolve()).then(fn, fn);
    this.#chain.set(branch, run.catch(() => undefined));
    return run;
  }

  async #read(branch: string): Promise<{ file: LeaseFile | "unreadable"; rev: string } | undefined> {
    const r = await this.#backend.read(branch);
    if (r === undefined) return undefined;
    return { file: parse(r.bytes) ?? "unreadable", rev: r.rev };
  }

  /** The state of a thread's lease. A followed thread that is live keeps this one live. */
  async inspect(branch: string, env: LeaseEnv, seen: Set<string> = new Set([branch])): Promise<LeaseState> {
    return (await this.#look(branch, env, seen)).state;
  }

  async #look(branch: string, env: LeaseEnv, seen: Set<string>): Promise<{ state: LeaseState; rev?: string; mine?: boolean }> {
    const r = await this.#read(branch);
    if (r === undefined) return { state: { state: "free" } };
    const f = r.file;
    if (f === "unreadable") return { state: { state: "stale", owner: {}, until: 0 }, rev: r.rev };
    const now = env.now();
    const until = Math.max(0, ...Object.values(f.holds));
    const mine = f.id === this.id;
    const dead = !mine && env.isDead?.(f.owner) === true;
    if (!dead) {
      if (until > now) return { state: { state: "live", owner: f.owner, until, holding: [...Object.keys(f.holds).filter((k) => (f.holds[k] as number) > now), ...Object.values(f.follows).map((b) => `thread ${b}`)] }, rev: r.rev, mine };
      for (const followed of Object.values(f.follows)) {
        if (seen.has(followed)) continue;
        seen.add(followed);
        const s = await this.inspect(followed, env, seen);
        if (s.state === "live") return { state: { state: "live", owner: f.owner, until: s.until, holding: [`thread ${followed}`] }, rev: r.rev, mine };
      }
    }
    return { state: { state: "stale", owner: f.owner, until }, rev: r.rev, mine };
  }

  /** Hold the thread's lease for `key` until `until`, taking the lease if nobody holds it. Throws `ThreadBusy` if a live holder in another process has it. */
  hold(branch: string, owner: LeaseOwner, env: LeaseEnv, key: string, until: number): Promise<LeaseBefore> {
    return this.#add(branch, owner, env, (m) => void (m.holds[key] = until));
  }

  /**
   * The lease of `followed` keeps this thread's lease live for as long as it is, until `drop(branch, key)`. The thread is also held for
   * `graceMs` (default 30 s), the time the followed thread may take to take its own lease.
   */
  follow(branch: string, owner: LeaseOwner, env: LeaseEnv, key: string, followed: string, graceMs = 30_000): Promise<LeaseBefore> {
    return this.#add(branch, owner, env, (m) => {
      m.follows[key] = followed;
      m.holds[key] = env.now() + graceMs;
    });
  }

  #add(branch: string, owner: LeaseOwner, env: LeaseEnv, change: (m: Mine) => void): Promise<LeaseBefore> {
    return this.#serial(branch, async () => {
      const have = this.#mine.get(branch);
      if (have !== undefined) {
        const next: Mine = { ...have, holds: { ...have.holds }, follows: { ...have.follows } };
        change(next);
        const done = await this.#backend.update(branch, this.#bytes(next), have.rev);
        if (done !== undefined) {
          this.#mine.set(branch, { ...next, rev: done.rev });
          return "ours";
        }
        this.#mine.delete(branch); // the lease was lost or taken over: start again, as for one we never had
      }
      let before: LeaseBefore = "free";
      for (;;) {
        const m: Mine = { owner, since: env.now(), holds: {}, follows: {}, rev: "" };
        change(m);
        const made = await this.#backend.create(branch, this.#bytes(m));
        if (made !== undefined) {
          this.#mine.set(branch, { ...m, rev: made.rev });
          return before;
        }
        const look = await this.#look(branch, env, new Set([branch]));
        const state = look.state;
        if (state.state === "live" && look.mine !== true) throw new ThreadBusy(branch, state);
        if (state.state !== "free") {
          if (state.state === "stale") before = "stale";
          if (look.rev !== undefined) await this.#backend.remove(branch, look.rev).catch(() => false); // someone else may take it over first: the loop starts again
        }
      }
    });
  }

  /** Let go of what `key` held. The lease is released (removed) when nothing holds it. */
  drop(branch: string, key: string): Promise<void> {
    return this.#serial(branch, async () => {
      const have = this.#mine.get(branch);
      if (have === undefined) return;
      const next: Mine = { ...have, holds: { ...have.holds }, follows: { ...have.follows } };
      delete next.holds[key];
      delete next.follows[key];
      if (Object.keys(next.holds).length === 0 && Object.keys(next.follows).length === 0) {
        this.#mine.delete(branch);
        await this.#backend.remove(branch, have.rev).catch(() => false);
        return;
      }
      const done = await this.#backend.update(branch, this.#bytes(next), have.rev);
      if (done === undefined) this.#mine.delete(branch);
      else this.#mine.set(branch, { ...next, rev: done.rev });
    });
  }

  /** What this process holds now: the thread and what holds it. */
  held(): { branch: string; holding: string[] }[] {
    return [...this.#mine].map(([branch, m]) => ({ branch, holding: [...Object.keys(m.holds), ...Object.keys(m.follows)] }));
  }

  /** Release everything this process holds (it is leaving). */
  async releaseAll(): Promise<void> {
    for (const branch of [...this.#mine.keys()]) {
      await this.#serial(branch, async () => {
        const m = this.#mine.get(branch);
        if (m === undefined) return;
        this.#mine.delete(branch);
        await this.#backend.remove(branch, m.rev).catch(() => false);
      });
    }
  }

  #bytes(m: Mine): Uint8Array {
    const f: LeaseFile = { v: 1, id: this.id, owner: m.owner, since: m.since, holds: { ...m.holds }, follows: { ...m.follows } };
    return enc.encode(JSON.stringify(f));
  }
}

const shared = new WeakMap<Fs, Map<string, LeaseStore>>();

/** The store a process uses for one repository's leases (`key` names the repository and where leases are kept): every handle on it gets the same one, so a loop and its jobs share a lease. */
export function sharedLeaseStore(fs: Fs, key: string, make: () => LeaseStore): LeaseStore {
  let byKey = shared.get(fs);
  if (byKey === undefined) shared.set(fs, (byKey = new Map()));
  let store = byKey.get(key);
  if (store === undefined) byKey.set(key, (store = make()));
  return store;
}
