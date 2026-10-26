import { z } from "zod";
import { Pipeline, acquireLock, defineEntry, emitEntry, parseEntry, LockHeldError, type Lock, type Git, type Host } from "../src/index.ts";
import { createUlid, ULID_RE } from "../harness/ulid.ts";
import { hasPendingState, type SessionState, type StagedAttachment } from "./engine.ts";
import { CliError, type Io } from "./io.ts";

/**
 * Session files (docs/cli.md, section 3): everything a CLI process holds that is not in the transcript, one YAML file per
 * session under `<git-common-dir>/chattree/cli/sessions/`, written with the repository's canonical emitter and read back
 * through a strict schema. A session is held by a lock with a heartbeat; resuming takes the earliest unlocked session that
 * points at the wanted thread.
 */

const attachment = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  charset: z.string().min(1).optional(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
});

const sessionFile = z.object({
  $tag: z.literal("session"),
  format: z.literal(1),
  id: z.string().regex(ULID_RE),
  thread: z.string().min(1),
  created: z.string().min(1),
  updated: z.string().min(1),
  draft: z.string(),
  drafts: z.array(z.object({ name: z.string().min(1), text: z.string() })).default([]),
  history: z.array(z.string()),
  thinking: z.enum(["off", "brief", "on"]),
  attachments: z.array(attachment),
});
type SessionFile = z.infer<typeof sessionFile>;

const pipeline = new Pipeline<SessionFile>({ types: [defineEntry("session", sessionFile as never)] });

const enc = new TextEncoder();
const dec = new TextDecoder();
export const HISTORY_LIMIT = 500;

export interface SessionInfo {
  id: string;
  /** Absent when the file could not be read. */
  thread?: string;
  created?: string;
  updated?: string;
  /** Something holds the session's lock right now. */
  locked: boolean;
  draft?: boolean;
  attachments?: number;
  /** Why the file could not be read. */
  error?: string;
}

export interface SessionOptions {
  /** Delay between a change and the write. Default 1000 ms; 0 writes at the next opportunity. */
  debounceMs?: number;
  /** Interval for stamping the lock. Default 10 s (it goes stale after 30 s); 0 turns it off. */
  heartbeatMs?: number;
  staleAfterMs?: number;
}

function toFile(s: Session): SessionFile {
  return {
    $tag: "session",
    format: 1,
    id: s.id,
    thread: s.thread,
    created: s.created,
    updated: s.updated,
    draft: s.state.draft,
    drafts: s.state.drafts.map((d) => ({ name: d.name, text: d.text })),
    history: s.state.history.slice(-HISTORY_LIMIT),
    thinking: s.state.thinking,
    attachments: s.state.attachments.map((a) => ({ path: a.path, name: a.name, mime: a.mime, ...(a.charset === undefined ? {} : { charset: a.charset }), size: a.size, mtimeMs: a.mtimeMs })),
  };
}

function toState(f: SessionFile): SessionState {
  return {
    draft: f.draft,
    drafts: f.drafts.map((d) => ({ name: d.name, text: d.text })),
    history: f.history,
    thinking: f.thinking,
    attachments: f.attachments.map((a): StagedAttachment => ({ path: a.path, name: a.name, mime: a.mime, ...(a.charset === undefined ? {} : { charset: a.charset }), size: a.size, mtimeMs: a.mtimeMs })),
  };
}

/** A held session. `state` is the object the engine and the terminal layer change; call `touch()` after changing it. */
export class Session {
  readonly id: string;
  readonly created: string;
  updated: string;
  thread: string;
  readonly state: SessionState;
  /** The lock was taken over by another process (this one stalled for too long); the session is still written. */
  lockLost = false;
  readonly #store: SessionStore;
  readonly #lock: Lock;
  readonly #opts: Required<SessionOptions>;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  /** @internal use `SessionStore.create` or `SessionStore.open`. */
  constructor(store: SessionStore, lock: Lock, file: SessionFile, opts: SessionOptions) {
    this.#store = store;
    this.#lock = lock;
    this.id = file.id;
    this.created = file.created;
    this.updated = file.updated;
    this.thread = file.thread;
    this.state = toState(file);
    this.#opts = { debounceMs: opts.debounceMs ?? 1000, heartbeatMs: opts.heartbeatMs ?? 10_000, staleAfterMs: opts.staleAfterMs ?? 30_000 };
    if (this.#opts.heartbeatMs > 0) {
      this.#beat = setInterval(() => void lock.refresh().then((ok) => void (ok || (this.lockLost = true))).catch(() => undefined), this.#opts.heartbeatMs);
      this.#beat.unref();
    }
  }

  /** The session now points at another thread. */
  point(thread: string): void {
    this.thread = thread;
    this.touch();
  }

  /** The state changed: write it soon (debounced, so typing does not write on every key). */
  touch(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch(() => undefined);
    }, this.#opts.debounceMs);
    this.#timer.unref();
  }

  /** Write now if anything changed. Writes never overlap. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const run = async (): Promise<void> => {
      if (!this.#dirty) return;
      this.#dirty = false;
      this.updated = new Date(this.#store.now()).toISOString();
      try {
        await this.#store.write(toFile(this));
      } catch (e) {
        this.#dirty = true;
        throw e;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Save, then release: a session with nothing pending is deleted, one with pending state is kept for resuming. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#beat !== undefined) clearInterval(this.#beat);
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    try {
      if (hasPendingState(this.state)) {
        this.#dirty = true;
        await this.flush();
      } else {
        await this.#queue;
        await this.#store.remove(this.id);
      }
    } finally {
      this.#closed = true;
      await this.#lock.release();
    }
  }
}

export interface OpenRequest {
  /** Resume the earliest unlocked session pointing at this thread, or make one. */
  thread: string;
  /** An exact session id (or a unique prefix): the session's own thread is used. */
  id?: string;
  /** Do not resume; make a new session. */
  fresh?: boolean;
}

export class SessionStore {
  readonly dir: string;
  readonly #host: Host;
  readonly #now: () => number;
  readonly #opts: SessionOptions;
  readonly #ulid: () => string;

  private constructor(host: Host, dir: string, now: () => number, opts: SessionOptions) {
    this.#host = host;
    this.dir = dir;
    this.#now = now;
    this.#opts = opts;
    this.#ulid = createUlid(now);
  }

  static async open(io: Pick<Io, "host" | "now">, git: Git, opts: SessionOptions = {}): Promise<SessionStore> {
    const dir = io.host.path.join(await git.commonDir(), "chattree", "cli", "sessions");
    return new SessionStore(io.host, dir, io.now, opts);
  }

  now(): number {
    return this.#now();
  }

  #file(id: string): string {
    return this.#host.path.join(this.dir, `${id}.yml`);
  }
  #lockFile(id: string): string {
    return this.#host.path.join(this.dir, `${id}.lock`);
  }

  /** @internal */
  async write(f: SessionFile): Promise<void> {
    const entry = await pipeline.encode(f);
    await this.#host.fs.writeAtomic(this.#file(f.id), enc.encode(emitEntry(entry)));
  }

  /** @internal */
  async remove(id: string): Promise<void> {
    await this.#host.fs.remove(this.#file(id));
  }

  async #read(id: string): Promise<SessionFile> {
    const bytes = await this.#host.fs.read(this.#file(id));
    const r = await pipeline.decode(parseEntry(dec.decode(bytes)));
    if (!r.ok) throw new Error(r.issues.map((i) => `${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("; "));
    if (r.value.id !== id) throw new Error(`the file is named ${id} but holds session ${r.value.id}`);
    return r.value;
  }

  async #lockedNow(id: string): Promise<boolean> {
    try {
      const v = JSON.parse(dec.decode(await this.#host.fs.read(this.#lockFile(id)))) as { createdAt?: unknown };
      return typeof v.createdAt === "number" && this.#now() - v.createdAt <= (this.#opts.staleAfterMs ?? 30_000);
    } catch {
      return false;
    }
  }

  async ids(): Promise<string[]> {
    const names = await this.#host.fs.readdir(this.dir).catch(() => [] as string[]);
    return names.flatMap((n) => (n.endsWith(".yml") && ULID_RE.test(n.slice(0, -4)) ? [n.slice(0, -4)] : [])).sort();
  }

  /** Every session, oldest first, including unreadable ones (with the reason). */
  async list(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const id of await this.ids()) {
      const locked = await this.#lockedNow(id);
      try {
        const f = await this.#read(id);
        out.push({ id, thread: f.thread, created: f.created, updated: f.updated, locked, draft: f.draft.trim() !== "", attachments: f.attachments.length });
      } catch (e) {
        out.push({ id, locked, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  async #lock(id: string): Promise<Lock | undefined> {
    try {
      return await acquireLock(this.#host.fs, this.#lockFile(id), { owner: `chattree-cli pid ${process.pid} session ${id}`, timeoutMs: 0, staleAfterMs: this.#opts.staleAfterMs ?? 30_000, now: this.#now });
    } catch (e) {
      if (e instanceof LockHeldError) return undefined;
      throw e;
    }
  }

  async create(thread: string): Promise<Session> {
    const id = this.#ulid();
    const lock = await this.#lock(id);
    if (lock === undefined) throw new CliError(`session ${id} is already locked`);
    const at = new Date(this.#now()).toISOString();
    const session = new Session(this, lock, { $tag: "session", format: 1, id, thread, created: at, updated: at, draft: "", drafts: [], history: [], thinking: "off", attachments: [] }, this.#opts);
    return session;
  }

  /** Resume or create (docs/cli.md, section 3). `skipped` names sessions that could not be used and why. */
  async open(req: OpenRequest): Promise<{ session: Session; resumed: boolean; skipped: string[] }> {
    const skipped: string[] = [];
    if (req.id !== undefined) {
      const matches = (await this.ids()).filter((i) => i === req.id || i.startsWith(req.id as string));
      if (matches.length === 0) throw new CliError(`there is no session ${req.id}`, "chattree sessions lists them");
      if (matches.length > 1) throw new CliError(`${req.id} matches ${matches.length} sessions`, "give more of the id");
      const id = matches[0] as string;
      const lock = await this.#lock(id);
      if (lock === undefined) throw new CliError(`session ${id} is in use by another process`, "close it there, or start another with --new-session");
      try {
        return { session: new Session(this, lock, await this.#read(id), this.#opts), resumed: true, skipped };
      } catch (e) {
        await lock.release();
        throw new CliError(`session ${id} cannot be read: ${e instanceof Error ? e.message : String(e)}`, `delete ${this.#file(id)} to discard it`);
      }
    }
    if (req.fresh !== true) {
      for (const id of await this.ids()) {
        const lock = await this.#lock(id);
        if (lock === undefined) continue;
        let file: SessionFile;
        try {
          file = await this.#read(id);
        } catch (e) {
          await lock.release();
          if ((await this.#host.fs.stat(this.#file(id))) !== undefined) skipped.push(`session ${id} was not used: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (file.thread !== req.thread) {
          await lock.release();
          continue;
        }
        return { session: new Session(this, lock, file, this.#opts), resumed: true, skipped };
      }
    }
    return { session: await this.create(req.thread), resumed: false, skipped };
  }
}
