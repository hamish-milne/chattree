/**
 * Cross-process file locks, used by the conversation and session code to guard a conversation's files.
 * A lock is a file created exclusively, so only one process can hold it. It is advisory: it only helps
 * where every writer takes it. Built on the host `Fs` interface.
 */
import { Type } from "typebox";
import type { Fs } from "./host.ts";
import { safeParse } from "./validate.ts";

/** Who holds a lock, as stored in the lock file. */
export interface LockInfo {
  token: string;
  owner: string;
  /** Milliseconds since the epoch, by the holder's clock. */
  createdAt: number;
}

export interface LockOptions {
  /** Label stored in the lock file, for diagnostics. */
  owner?: string;
  /** A lock older than this is presumed left behind by a crashed process and is taken over. Default 30 s. */
  staleAfterMs?: number;
  /** How long to wait for a held lock before giving up. Default 10 s; 0 fails immediately. */
  timeoutMs?: number;
  /** Delay between attempts. Default 25 ms. */
  retryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class LockHeldError extends Error {
  override name = "LockHeldError";
  holder: LockInfo | undefined;
  constructor(path: string, holder: LockInfo | undefined, now: number) {
    const who =
      holder === undefined ? "an unknown holder" : `${holder.owner} (${Math.max(0, Math.round((now - holder.createdAt) / 1000))} s ago)`;
    super(`${path} is locked by ${who}; if that process is gone the lock goes stale after the configured timeout`);
    this.holder = holder;
  }
}

export interface Lock {
  readonly info: LockInfo;
  /** Stamp the lock with the current time so it is not taken as stale; for a lock held a long time. Resolves false if it was no longer ours. */
  refresh(): Promise<boolean>;
  /** Release the lock. Resolves false if it was no longer ours (it had been taken over as stale). */
  release(): Promise<boolean>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a lock file holds (other fields a newer writer adds are not read). */
const lockInfo = Type.Object({ token: Type.String(), owner: Type.String(), createdAt: Type.Number() });

function parseInfo(bytes: Uint8Array): LockInfo | undefined {
  try {
    const r = safeParse(lockInfo, JSON.parse(dec.decode(bytes)));
    if (r.ok) return { token: r.value.token, owner: r.value.owner, createdAt: r.value.createdAt };
  } catch {
    /* unreadable */
  }
  return undefined;
}

async function readInfo(fs: Fs, path: string): Promise<{ present: boolean; info: LockInfo | undefined }> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.read(path);
  } catch {
    return { present: (await fs.stat(path)) !== undefined, info: undefined };
  }
  return { present: true, info: parseInfo(bytes) };
}

/**
 * Take an exclusive lock by creating `path`. The file holds a token, an owner label and a timestamp, so a
 * lock left by a crashed process can be recognised as stale and taken over (by renaming it aside first, so
 * only one taker wins). Two processes that judge the same stale lock at the same instant can, in a narrow
 * window, both proceed; the lock is a guard against interleaved writers, and the callers that use it also
 * verify the state they rely on (file size, tail) before and after writing.
 */
export async function acquireLock(fs: Fs, path: string, opts: LockOptions = {}): Promise<Lock> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const staleAfter = opts.staleAfterMs ?? 30_000;
  const deadline = now() + (opts.timeoutMs ?? 10_000);
  const retry = opts.retryMs ?? 25;
  const token = crypto.randomUUID();

  for (;;) {
    const info: LockInfo = { token, owner: opts.owner ?? `chattree-${token.slice(0, 8)}`, createdAt: now() };
    if (await fs.createExclusive(path, enc.encode(JSON.stringify(info)))) {
      return {
        info,
        async refresh() {
          const cur = await readInfo(fs, path);
          if (cur.info?.token !== token) return false;
          await fs.writeAtomic(path, enc.encode(JSON.stringify({ ...info, createdAt: now() })));
          return true;
        },
        async release() {
          const cur = await readInfo(fs, path);
          if (cur.info?.token !== token) return false;
          return fs.remove(path);
        },
      };
    }
    const held = await readInfo(fs, path);
    if (!held.present) continue; // released between our attempt and the read
    // A lock file we cannot parse was not written by us (content is published atomically), so it is stale too.
    // A stale lock is renamed aside, then removed. The rename moves whatever is at `path` at that moment,
    // which is the window the doc above describes.
    if (held.info === undefined || now() - held.info.createdAt > staleAfter) {
      const aside = `${path}.stale-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await fs.rename(path, aside);
        await fs.remove(aside);
      } catch {
        /* someone else took it over first */
      }
      continue;
    }
    if (now() >= deadline) throw new LockHeldError(path, held.info, now());
    await sleep(retry);
  }
}

/** Run `fn` while holding the lock, releasing it afterwards even if `fn` throws. */
export async function withLock<T>(fs: Fs, path: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(fs, path, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
