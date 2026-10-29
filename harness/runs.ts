import type { Conversation } from "./conversation.ts";
import { runLoop, type LoopEvent, type LoopOptions, type LoopResult } from "./loop.ts";

/**
 * The run manager (docs/tools.md, section 4.2 and the step 8 plan). One place owns every loop that is running in this process, so that
 * a loop does not belong to whichever call or screen started it: a subagent's loop is a run, a fork that works by itself is a run,
 * and the terminal's own turn can be one. A run belongs to one branch; it can be watched from any number of places, stopped, and
 * started again when the user speaks to its branch.
 *
 * A run goes through cycles. A cycle is one `runLoop` (it ends when the model answers without a tool, a limit stops it, the user
 * aborts it, or a tool says `finish`). Between cycles the run is `idle`; `resume` starts the next. A run ends for good when its owner
 * calls `close`. What a cycle's end means (done, or waiting for the user) is for the owner to decide.
 */

export type RunState = "running" | "idle" | "closed";

/** How a cycle ended: the loop's result, or what it threw. */
export type CycleEnd = { result: LoopResult; error?: undefined } | { error: unknown; result?: undefined };

export interface RunInfo {
  branch: string;
  kind: string;
  label: string;
  state: RunState;
  cycles: number;
  startedAt: number;
}

export type RunOptions = Omit<LoopOptions, "signal">;

const BUFFER = 500;

export class Run {
  readonly convo: Conversation;
  readonly kind: string;
  readonly label: string;
  readonly startedAt: number;
  #state: RunState = "running";
  #cycles = 0;
  #opts: RunOptions;
  #ac = new AbortController();
  #buffer: LoopEvent[] = [];
  #subs = new Set<(e: LoopEvent) => void>();
  #waiters: ((end: CycleEnd) => void)[] = [];
  #closed: Promise<void>;
  #close!: () => void;
  #last: CycleEnd | undefined;
  readonly #onClosed: (run: Run) => void;

  constructor(convo: Conversation, opts: RunOptions, meta: { kind: string; label: string }, now: number, onClosed: (run: Run) => void) {
    this.convo = convo;
    this.#opts = opts;
    this.kind = meta.kind;
    this.label = meta.label;
    this.startedAt = now;
    this.#onClosed = onClosed;
    this.#closed = new Promise<void>((r) => (this.#close = r));
    this.#start();
  }

  get branch(): string {
    return this.convo.branch;
  }
  get state(): RunState {
    return this.#state;
  }
  get cycles(): number {
    return this.#cycles;
  }
  /** How the latest cycle ended, once one has. */
  get last(): CycleEnd | undefined {
    return this.#last;
  }
  info(): RunInfo {
    return { branch: this.branch, kind: this.kind, label: this.label, state: this.#state, cycles: this.#cycles, startedAt: this.startedAt };
  }

  /** Watch the run's events. With `replay` the events of the current cycle so far come first. Returns the way to stop watching. */
  subscribe(fn: (e: LoopEvent) => void, opts: { replay?: boolean } = {}): () => void {
    if (opts.replay === true) for (const e of this.#buffer) fn(e);
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }

  /**
   * Resolves when the current cycle ends (at once if the run is idle and a cycle has ended: the latest end). With `next`, waits for
   * the end of a cycle that has not started yet when the run is idle. Resolves with `undefined` if the run is closed first.
   */
  cycleEnd(opts: { next?: boolean } = {}): Promise<CycleEnd | undefined> {
    if (this.#state === "closed") return Promise.resolve(this.#last);
    if (this.#state === "idle" && opts.next !== true && this.#last !== undefined) return Promise.resolve(this.#last);
    return new Promise((resolve) => {
      const done = (end: CycleEnd): void => resolve(end);
      this.#waiters.push(done);
      void this.#closed.then(() => resolve(undefined));
    });
  }

  /** Start the next cycle of an idle run, with other options if given (a changed system prompt, say). */
  resume(opts?: RunOptions): void {
    if (this.#state !== "idle") throw new Error(`the run on ${this.branch} is ${this.#state}, not idle`);
    if (opts !== undefined) this.#opts = opts;
    this.#state = "running";
    this.#start();
  }

  /** Stop the running cycle (its request and tools); the run goes idle when the loop has wound up. */
  abort(): void {
    this.#ac.abort();
  }

  /** End the run for good (aborting a cycle that is still going). */
  close(): void {
    if (this.#state === "closed") return;
    const wasRunning = this.#state === "running";
    this.#state = "closed";
    if (wasRunning) this.#ac.abort();
    this.#close();
    this.#onClosed(this);
  }

  #start(): void {
    this.#ac = new AbortController();
    this.#buffer = [];
    this.#cycles++;
    void this.#drive(this.#ac.signal);
  }

  async #drive(signal: AbortSignal): Promise<void> {
    let end: CycleEnd;
    try {
      const loop = runLoop(this.convo, { ...this.#opts, signal });
      for (;;) {
        const n = await loop.next();
        if (n.done) {
          end = { result: n.value };
          break;
        }
        if (this.#buffer.length < BUFFER) this.#buffer.push(n.value);
        for (const s of this.#subs) {
          try {
            s(n.value);
          } catch {
            /* a watcher's failure is not the run's */
          }
        }
      }
    } catch (error) {
      end = { error };
    }
    this.#last = end;
    if (this.#state === "running") this.#state = "idle";
    const waiters = this.#waiters.splice(0);
    for (const w of waiters) w(end);
  }
}

export class ThreadRuns {
  readonly #runs = new Map<string, Run>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Start a run on `convo`'s branch. One run per branch: starting another while one is open is an error. */
  start(convo: Conversation, opts: RunOptions, meta: { kind: string; label?: string }): Run {
    const existing = this.#runs.get(convo.branch);
    if (existing !== undefined) throw new Error(`there is already a run on ${convo.branch}`);
    const run = new Run(convo, opts, { kind: meta.kind, label: meta.label ?? convo.branch }, this.#now(), (r) => {
      if (this.#runs.get(r.branch) === r) this.#runs.delete(r.branch);
    });
    this.#runs.set(convo.branch, run);
    return run;
  }

  get(branch: string): Run | undefined {
    return this.#runs.get(branch);
  }

  list(): RunInfo[] {
    return [...this.#runs.values()].map((r) => r.info());
  }

  /** Abort the running cycle of a branch. False if nothing runs there. */
  abort(branch: string): boolean {
    const r = this.#runs.get(branch);
    if (r === undefined || r.state !== "running") return false;
    r.abort();
    return true;
  }

  /** Close every run (the process is leaving). */
  closeAll(): void {
    for (const r of [...this.#runs.values()]) r.close();
  }
}
