import type { Host } from "../src/host.ts";
import type { Completed, StreamEvent } from "../providers/types.ts";

/**
 * The journal of a request in flight (docs/providers.md, P5): one append-only JSON-lines file per branch, beside the
 * repository's locks and never committed, that records what a request was and every event it produced. It exists
 * for one reason: if the process dies, `open` can say what the request got instead of losing it.
 *
 * It is not canonical YAML and not content-addressed. Lines are buffered and flushed every `flushMs` (or at
 * `maxBuffer` bytes), so a crash can lose the last few hundred milliseconds of events; a final `done` record
 * (the whole `Completed`) is flushed before the transcript is touched, so nothing is lost between the end of the
 * stream and the commit. A heartbeat line every `heartbeatMs` keeps the file's modification time current, which is how
 * another process tells a request still running from one whose process died.
 */
export interface JournalStart {
  /** The provider's name in `harness.yml`. */
  provider: string;
  /** The model the request named (the setup's id, or the dated one once resolved). */
  model: string;
  /** Digests of the setup and the context that were sent, to tell requests apart in a log. */
  setup_digest: string;
  context_digest: string;
  /** The id of the transcript's last entry when the request began; an entry after it means the request was committed. */
  after: string | undefined;
  /** When it began (the host's clock). */
  at: number;
  /** Random per request: how the request that wrote this file tells, later, that the file is still its own and has not been recovered by someone else. */
  nonce?: string;
  /** Who is running the request, for hosts that want to say so ("session 2, pid 4711") and for abort requests. */
  owner?: { pid?: number; host?: string; session?: string };
}

export type JournalRecord =
  | ({ t: "start"; v: 1 } & JournalStart)
  | { t: "event"; e: StreamEvent }
  | { t: "beat"; at: number }
  | { t: "done"; completed: Completed };

export interface JournalOptions {
  /** Default 250 ms. */
  flushMs?: number;
  /** Default 64 KiB. */
  maxBuffer?: number;
  /** Default 15 s; 0 turns the heartbeat off. */
  heartbeatMs?: number;
  /** Told when writing fails. The journal then stops writing and the request carries on without crash protection. */
  onError?: (error: unknown) => void;
  now?: () => number;
}

/**
 * A request finished after its journal had been recovered by another process (it was taken for dead, for instance
 * after the host was suspended): the transcript already holds an `interrupted` entry for it. The response is not
 * committed, so the transcript has one outcome for the request, and is handed back here for the host to use or drop.
 */
export class RequestSuperseded extends Error {
  override name = "RequestSuperseded";
  /** The response the request completed, if it did. */
  readonly completed: Completed | undefined;
  constructor(completed: Completed | undefined) {
    super("this request's journal was recovered by another process while it was running; its result was not committed");
    this.completed = completed;
  }
}

export class JournalBusy extends Error {
  override name = "JournalBusy";
  readonly path: string;
  /** True when its modification time is recent enough that the request may still be running. */
  readonly live: boolean;
  constructor(path: string, live: boolean) {
    super(live ? "another request is in flight on this branch" : "a request on this branch ended without being recorded; open the conversation again to recover it");
    this.path = path;
    this.live = live;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Journal {
  readonly #host: Host;
  readonly #path: string;
  readonly #opts: JournalOptions;
  /** The bytes of our start line: the file is ours while it begins with exactly these. */
  readonly #head: Uint8Array;
  /** This request's nonce, which an abort request must quote. */
  readonly nonce: string;
  #buffer: string[] = [];
  #size = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #failed = false;
  #closed = false;

  private constructor(host: Host, path: string, opts: JournalOptions, head: Uint8Array, nonce: string) {
    this.nonce = nonce;
    this.#host = host;
    this.#path = path;
    this.#opts = opts;
    this.#head = head;
  }

  /** Start a journal. Fails with `JournalBusy` if one exists: two requests on one branch would interleave. */
  static async begin(host: Host, path: string, start: JournalStart, opts: JournalOptions = {}, staleMs = 60_000): Promise<Journal> {
    const nonce = crypto.randomUUID();
    const line = `${JSON.stringify({ t: "start", v: 1, ...start, nonce } satisfies JournalRecord)}\n`;
    const head = enc.encode(line);
    await host.fs.mkdir(host.path.dirname(path));
    if (!(await host.fs.createExclusive(path, head))) {
      throw new JournalBusy(path, await isLive(host, path, staleMs, opts.now));
    }
    const j = new Journal(host, path, opts, head, nonce);
    await host.fs.remove(abortMarkerPath(path)).catch(() => false); // a request for an earlier request's abort is not for this one
    const beat = opts.heartbeatMs ?? 15_000;
    if (beat > 0) {
      j.#beat = setInterval(() => j.write({ t: "beat", at: (opts.now ?? Date.now)() }), beat);
      j.#beat.unref?.();
    }
    return j;
  }

  /** Queue a record; it reaches the file within `flushMs`. */
  write(rec: JournalRecord): void {
    if (this.#failed || this.#closed) return;
    const line = `${JSON.stringify(rec)}\n`;
    this.#buffer.push(line);
    this.#size += line.length;
    if (this.#size >= (this.#opts.maxBuffer ?? 65_536)) void this.flush();
    else this.#timer ??= setTimeout(() => void this.flush(), this.#opts.flushMs ?? 250);
  }

  /** Whether the file at the journal's path is still the one this request created (not deleted, not replaced by a recovery and a new request). */
  async owned(): Promise<boolean> {
    try {
      const got = await this.#host.fs.readRange(this.#path, 0, this.#head.length);
      return got.length === this.#head.length && got.every((b, i) => b === this.#head[i]);
    } catch {
      return false;
    }
  }

  /** Whether someone asked for this request to be aborted (`requestAbortOf`). The marker is consumed; one naming another request is dropped. */
  async abortRequested(): Promise<boolean> {
    const path = abortMarkerPath(this.#path);
    try {
      if ((await this.#host.fs.stat(path)) === undefined) return false;
      const who = dec.decode(await this.#host.fs.read(path)).trim();
      await this.#host.fs.remove(path).catch(() => false);
      return who === this.nonce;
    } catch {
      return false;
    }
  }

  /** Write what is queued and wait until it is on disk. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const text = this.#buffer.join("");
    this.#buffer = [];
    this.#size = 0;
    if (text === "" || this.#failed) return this.#chain;
    this.#chain = this.#chain.then(async () => {
      try {
        // Never write into a file that is no longer ours: append would recreate a journal that recovery deleted, or extend another request's.
        if (!(await this.owned())) {
          this.#failed = true;
          return;
        }
        await this.#host.fs.append(this.#path, enc.encode(text));
      } catch (e) {
        this.#failed = true;
        try {
          this.#opts.onError?.(e);
        } catch {
          /* the handler must not break the request */
        }
      }
    });
    return this.#chain;
  }

  /** Stop the timers and write the last of the queue, leaving the file for recovery (the commit failed, so the journal is all there is). */
  async abandon(): Promise<void> {
    this.#closed = true;
    if (this.#beat !== undefined) clearInterval(this.#beat);
    this.#beat = undefined;
    await this.flush();
  }

  /** `abandon`, then delete the file: the request is recorded (or deliberately dropped). Does nothing to a file that is not ours. */
  async discard(): Promise<void> {
    await this.abandon();
    if (await this.owned()) await this.#host.fs.remove(this.#path).catch(() => false);
  }

  get failed(): boolean {
    return this.#failed;
  }
}

/** Where an abort request for the request journaled at `journalPath` is left. */
export function abortMarkerPath(journalPath: string): string {
  return `${journalPath}.abort`;
}

/** Ask the request journaled at `path` to stop: leave a marker naming its nonce, which its process notices within a poll interval. */
export async function requestAbortOf(host: Host, path: string, nonce: string): Promise<void> {
  await host.fs.writeAtomic(abortMarkerPath(path), enc.encode(nonce));
}

async function isLive(host: Host, path: string, staleMs: number, now: (() => number) | undefined): Promise<boolean> {
  const mtime = (await host.fs.stat(path))?.mtimeMs;
  return mtime === undefined || (now ?? Date.now)() - mtime <= staleMs;
}

export interface JournalContents {
  start: JournalStart;
  events: StreamEvent[];
  /** The response as the stream completed it, when the process got that far. */
  done: Completed | undefined;
  /** The last line was cut off (the process died mid-write); it is ignored. */
  torn: boolean;
}

/** Whether the journal's owner may still be running: its modification time is within `staleMs`. */
export async function journalIsLive(host: Host, path: string, staleMs: number, now?: () => number): Promise<boolean> {
  return (await host.fs.stat(path)) !== undefined && (await isLive(host, path, staleMs, now));
}

/** Read a journal, tolerating a torn last line. Undefined if there is none, or its first line is not a start record. */
export async function readJournal(host: Host, path: string): Promise<JournalContents | undefined> {
  if ((await host.fs.stat(path)) === undefined) return undefined;
  const lines = dec.decode(await host.fs.read(path)).split("\n");
  const endsClean = lines.at(-1) === "";
  if (endsClean) lines.pop();
  let start: JournalStart | undefined;
  const events: StreamEvent[] = [];
  let done: Completed | undefined;
  let torn = !endsClean;
  for (const [i, line] of lines.entries()) {
    let rec: JournalRecord;
    try {
      rec = JSON.parse(line) as JournalRecord;
    } catch {
      torn = true;
      break; // only the last line can be torn; anything after a bad line is not trusted
    }
    if (i === 0) {
      if (rec.t !== "start") return undefined;
      const { t: _t, v: _v, ...rest } = rec;
      start = rest;
    } else if (rec.t === "event") events.push(rec.e);
    else if (rec.t === "done") done = rec.completed;
  }
  return start === undefined ? undefined : { start, events, done, torn };
}
