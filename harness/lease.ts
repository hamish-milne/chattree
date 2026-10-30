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
 * started share one lease. It could later be kept as a ref to make it atomic across clones; the interface would not change.
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

type Mine = { owner: LeaseOwner; since: number; holds: Record<string, number>; follows: Record<string, string> };

export class LeaseStore {
  /** One per process and repository, for the life of the process: the lease file says whose it is by this. */
  readonly id = crypto.randomUUID();
  readonly #fs: Fs;
  readonly #file: (branch: string) => string;
  readonly #mine = new Map<string, Mine>();
  readonly #chain = new Map<string, Promise<unknown>>();

  /** `file` is where a thread's lease lives (a path under the repository's shared git directory). */
  constructor(fs: Fs, file: (branch: string) => string) {
    this.#fs = fs;
    this.#file = file;
  }

  /** Run `fn` after the earlier operations on the same thread, so this process never interleaves its own writes. */
  #serial<T>(branch: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#chain.get(branch) ?? Promise.resolve()).then(fn, fn);
    this.#chain.set(branch, run.catch(() => undefined));
    return run;
  }

  async #read(branch: string): Promise<LeaseFile | "unreadable" | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#fs.read(this.#file(branch));
    } catch {
      return (await this.#fs.stat(this.#file(branch))) === undefined ? undefined : "unreadable";
    }
    return parse(bytes) ?? "unreadable";
  }

  /** The state of a thread's lease. A followed thread that is live keeps this one live. */
  async inspect(branch: string, env: LeaseEnv, seen: Set<string> = new Set([branch])): Promise<LeaseState> {
    const f = await this.#read(branch);
    if (f === undefined) return { state: "free" };
    if (f === "unreadable") return { state: "stale", owner: {}, until: 0 };
    const now = env.now();
    const until = Math.max(0, ...Object.values(f.holds));
    const dead = f.id !== this.id && env.isDead?.(f.owner) === true;
    if (!dead) {
      if (until > now) return { state: "live", owner: f.owner, until, holding: [...Object.keys(f.holds).filter((k) => (f.holds[k] as number) > now), ...Object.values(f.follows).map((b) => `thread ${b}`)] };
      for (const followed of Object.values(f.follows)) {
        if (seen.has(followed)) continue;
        seen.add(followed);
        const s = await this.inspect(followed, env, seen);
        if (s.state === "live") return { state: "live", owner: f.owner, until: s.until, holding: [`thread ${followed}`] };
      }
    }
    return { state: "stale", owner: f.owner, until };
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
        const disk = await this.#read(branch);
        if (disk !== undefined && disk !== "unreadable" && disk.id === this.id) {
          change(have);
          await this.#write(branch, have);
          return "ours";
        }
        this.#mine.delete(branch); // the file was lost or taken over: start again, as for a lease we never had
      }
      let before: LeaseBefore = "free";
      for (;;) {
        const m: Mine = { owner, since: env.now(), holds: {}, follows: {} };
        change(m);
        if (await this.#fs.createExclusive(this.#file(branch), enc.encode(JSON.stringify(this.#json(m))))) {
          this.#mine.set(branch, m);
          return before;
        }
        const state = await this.inspect(branch, env);
        if (state.state === "live") {
          const disk = await this.#read(branch);
          if (disk === undefined || disk === "unreadable" || disk.id !== this.id) throw new ThreadBusy(branch, state);
        }
        if (state.state !== "free") {
          if (state.state === "stale") before = "stale";
          const aside = `${this.#file(branch)}.stale-${crypto.randomUUID().slice(0, 8)}`;
          try {
            await this.#fs.rename(this.#file(branch), aside);
            await this.#fs.remove(aside);
          } catch {
            /* someone else took it over first */
          }
        }
      }
    });
  }

  /** Let go of what `key` held. The lease is released (the file removed) when nothing holds it. */
  drop(branch: string, key: string): Promise<void> {
    return this.#serial(branch, async () => {
      const m = this.#mine.get(branch);
      if (m === undefined) return;
      delete m.holds[key];
      delete m.follows[key];
      if (Object.keys(m.holds).length === 0 && Object.keys(m.follows).length === 0) {
        this.#mine.delete(branch);
        const disk = await this.#read(branch);
        if (disk !== undefined && disk !== "unreadable" && disk.id === this.id) await this.#fs.remove(this.#file(branch));
        return;
      }
      const disk = await this.#read(branch);
      if (disk !== undefined && disk !== "unreadable" && disk.id === this.id) await this.#write(branch, m);
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
        const disk = await this.#read(branch);
        if (disk !== undefined && disk !== "unreadable" && disk.id === this.id) await this.#fs.remove(this.#file(branch));
      });
    }
  }

  #json(m: Mine): LeaseFile {
    return { v: 1, id: this.id, owner: m.owner, since: m.since, holds: { ...m.holds }, follows: { ...m.follows } };
  }

  async #write(branch: string, m: Mine): Promise<void> {
    await this.#fs.writeAtomic(this.#file(branch), enc.encode(JSON.stringify(this.#json(m))));
  }
}

const shared = new WeakMap<Fs, Map<string, LeaseStore>>();

/** The store a process uses for one repository's leases: every handle on the repository gets the same one, so a loop and its jobs share a lease. */
export function sharedLeaseStore(fs: Fs, dir: string, file: (branch: string) => string): LeaseStore {
  let byDir = shared.get(fs);
  if (byDir === undefined) shared.set(fs, (byDir = new Map()));
  let store = byDir.get(dir);
  if (store === undefined) byDir.set(dir, (store = new LeaseStore(fs, file)));
  return store;
}
