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
  #buffer: string[] = [];
  #size = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;
  #chain: Promise<void> = Promise.resolve();
  #failed = false;
  #closed = false;

  private constructor(host: Host, path: string, opts: JournalOptions) {
    this.#host = host;
    this.#path = path;
    this.#opts = opts;
  }

  /** Start a journal. Fails with `JournalBusy` if one exists: two requests on one branch would interleave. */
  static async begin(host: Host, path: string, start: JournalStart, opts: JournalOptions = {}, staleMs = 60_000): Promise<Journal> {
    const line = `${JSON.stringify({ t: "start", v: 1, ...start } satisfies JournalRecord)}\n`;
    await host.fs.mkdir(host.path.dirname(path));
    if (!(await host.fs.createExclusive(path, enc.encode(line)))) {
      throw new JournalBusy(path, await isLive(host, path, staleMs, opts.now));
    }
    const j = new Journal(host, path, opts);
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

  /** `abandon`, then delete the file: the request is recorded (or deliberately dropped). */
  async discard(): Promise<void> {
    await this.abandon();
    await this.#host.fs.remove(this.#path).catch(() => false);
  }

  get failed(): boolean {
    return this.#failed;
  }
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
