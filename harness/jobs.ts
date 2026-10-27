import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import type { StartedJob, Tool, ToolOutput } from "./tools.ts";
import { ALL } from "./approvals.ts";

/**
 * Background jobs (docs/tools.md, section 3.5). A tool called with `background: true` returns a `StartedJob` at once; the
 * registry keeps it running in this process, and when it ends a `job_event` entry is committed on the branch, which the model
 * is shown with its next request. Jobs live as long as the process: after a crash `recover` commits a `lost` event for each
 * job that was started and never ended.
 *
 * When the event is committed:
 * - while a tool loop runs, at the start of its next request (never between the calls of one response, whose results must stay together);
 * - otherwise at once, and the host is told (`onCommitted`); with `resume` it is also asked to send a request (`onResume`).
 */

export type JobStatus = "running" | "completed" | "failed" | "stopped" | "lost";

export interface JobInfo {
  id: string;
  /** The call that started it. */
  call_id: string;
  /** One line: what it is (`run: pnpm test`). */
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** What it printed, once it has ended. */
  output?: string;
}

export interface JobsOptions {
  /** Also ask the host to send a request when an event is committed while idle (`background.resume`). Default false. */
  resume?: boolean;
  /** Called after job events were committed outside a loop (so the host can tell the user at the next prompt). */
  onCommitted?: (events: { job: string; status: JobStatus; summary: string }[]) => void;
  /** With `resume`: called after those events, so the host can start a request to let the model react. */
  onResume?: () => void;
  /** True while the host is in the middle of a request the registry must not interleave with. Default: a loop is running. */
  busy?: () => boolean;
}

/** `started job j3` as the loop writes it into the result of the starting call; recovery finds jobs by it. */
export const JOB_STARTED = /^started job (j\d+)\b/;

const jobNumber = (id: string): number => Number(id.slice(1));

export class JobRegistry {
  readonly #convo: Conversation;
  readonly #opts: JobsOptions;
  readonly #jobs = new Map<string, JobInfo & { stop: () => void; stopped: boolean }>();
  readonly #uncommitted: string[] = [];
  #next = 1;
  #loops = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(convo: Conversation, opts: JobsOptions = {}) {
    this.#convo = convo;
    this.#opts = opts;
  }

  /** Called by `runLoop` around its run, so a job that ends meanwhile waits for the loop's next request. */
  enterLoop(): void {
    this.#loops++;
  }
  leaveLoop(): void {
    this.#loops--;
    // Jobs that ended during the loop's last request have no later request to be delivered with.
    if (!this.#busy() && this.#uncommitted.length > 0) void this.flush().catch(() => undefined);
  }

  #busy(): boolean {
    return this.#opts.busy?.() ?? this.#loops > 0;
  }

  /** Start tracking a job the tool has already begun; resolves to its id (`j1`). */
  async start(call_id: string, started: StartedJob["started"]): Promise<string> {
    await this.#syncNumber();
    const id = `j${this.#next++}`;
    const job = { id, call_id, label: started.summary, status: "running" as JobStatus, startedAt: this.#convo.now(), stop: () => started.stop(), stopped: false };
    this.#jobs.set(id, job);
    void started.done.then(
      (out) => this.#ended(job, out),
      (e: unknown) => this.#ended(job, { content: `The job failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true }),
    );
    return id;
  }

  /** The next number is after every job this branch's history already mentions. */
  async #syncNumber(): Promise<void> {
    if (this.#next > 1) return;
    for (const e of await this.#entries()) {
      if (e.$tag === "job_event") this.#next = Math.max(this.#next, jobNumber(e.job) + 1);
      else if (e.$tag === "tool_result" && typeof e.content === "string") {
        const m = JOB_STARTED.exec(e.content);
        if (m !== null) this.#next = Math.max(this.#next, jobNumber(m[1] as string) + 1);
      }
    }
  }

  #ended(job: JobInfo & { stopped: boolean }, out: ToolOutput): void {
    job.status = job.stopped ? "stopped" : out.is_error === true ? "failed" : "completed";
    job.endedAt = this.#convo.now();
    job.output = out.content;
    this.#uncommitted.push(job.id);
    if (!this.#busy()) void this.flush().catch(() => undefined); // the next flush retries
  }

  /** The clock jobs are timed with. */
  get now(): () => number {
    return this.#convo.now;
  }

  list(): JobInfo[] {
    return [...this.#jobs.values()].map(({ stop: _s, stopped: _t, ...info }) => info);
  }

  get(id: string): JobInfo | undefined {
    return this.list().find((j) => j.id === id);
  }

  /** Ask a running job to stop. False if there is no such job or it is not running. */
  stop(id: string): boolean {
    const job = this.#jobs.get(id);
    if (job === undefined || job.status !== "running") return false;
    job.stopped = true;
    job.stop();
    return true;
  }

  /** Stop every running job (the host is exiting). */
  stopAll(): void {
    for (const id of this.#jobs.keys()) this.stop(id);
  }

  async #entries(): Promise<ChatEntry[]> {
    return (await this.#convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  }

  /** What a job printed: from the live job, else from the `job_event` entry in the history. */
  async output(id: string): Promise<{ status: JobStatus; output: string | undefined } | undefined> {
    const live = this.#jobs.get(id);
    if (live !== undefined) return { status: live.status, output: live.output };
    for (const e of (await this.#entries()).reverse()) {
      if (e.$tag === "job_event" && e.job === id) {
        const out = e.output === undefined ? undefined : typeof e.output === "string" ? e.output : new TextDecoder().decode(await this.#convo.store.get(e.output.sha256));
        return { status: e.status, output: out };
      }
    }
    return undefined;
  }

  /**
   * Commit the `job_event` entries of jobs that have ended and are not yet in the history, in the order they ended. Returns
   * the entries' text, for the caller to show. Serialized, so two callers never commit one job twice.
   */
  flush(): Promise<{ job: string; status: JobStatus; summary: string }[]> {
    const run = this.#queue.then(async () => {
      const done: { job: string; status: JobStatus; summary: string }[] = [];
      while (this.#uncommitted.length > 0) {
        const id = this.#uncommitted[0] as string;
        const job = this.#jobs.get(id) as JobInfo;
        const secs = Math.max(0, Math.round(((job.endedAt ?? job.startedAt) - job.startedAt) / 1000));
        const summary = `${job.label} ${job.status} after ${secs}s`;
        await this.#convo.append({ $tag: "job_event", job: id, call_id: job.call_id, status: job.status as "completed", summary, ...(job.output === undefined ? {} : { output: job.output }) });
        this.#uncommitted.shift();
        done.push({ job: id, status: job.status, summary });
      }
      return done;
    });
    this.#queue = run.catch(() => undefined);
    return run.then((done) => {
      if (done.length > 0 && !this.#busy()) {
        this.#opts.onCommitted?.(done);
        if (this.#opts.resume === true) this.#opts.onResume?.();
      }
      return done;
    });
  }

  /**
   * Commit a `lost` event for every job the history says was started and never ended, that this process is not running.
   * (The process that ran them ended, so their output is gone.) Safe to call at any time; returns the job ids.
   */
  async recover(): Promise<string[]> {
    const entries = await this.#entries();
    const started = new Map<string, string>();
    const ended = new Set<string>();
    for (const e of entries) {
      if (e.$tag === "job_event") ended.add(e.job);
      else if (e.$tag === "tool_result" && typeof e.content === "string") {
        const m = JOB_STARTED.exec(e.content);
        if (m !== null) started.set(m[1] as string, e.call_id);
      }
    }
    const lost = [...started].filter(([id]) => !ended.has(id) && !this.#jobs.has(id));
    for (const [id, call_id] of lost) {
      await this.#convo.append({ $tag: "job_event", job: id, call_id, status: "lost", summary: `job ${id} was running when the process that started it ended; it did not finish and its output is gone` });
    }
    await this.#syncNumber();
    return lost.map(([id]) => id);
  }
}

// ---- the tools that manage jobs ------------------------------------------------------------------------------------

const ago = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`);

/** `jobs`, `job_output` and `job_stop`: one registry, three small flat tools. */
export function jobTools(registry: JobRegistry): Tool[] {
  const noArgs = { type: "object", additionalProperties: false, properties: {} };
  const jobArg = { type: "string", description: "The job id, for example j1." };
  return [
    {
      definition: { name: "jobs", description: "List the background jobs started in this session: id, what it is, whether it is still running, and how long.", input_schema: noArgs },
      allowKeys: () => [ALL],
      execute: async () => {
        const jobs = registry.list();
        const now = registry.now();
        return { content: jobs.length === 0 ? "No background jobs." : jobs.map((j) => `${j.id}  ${j.status}  ${j.label}${j.status === "running" ? `  (running ${ago(now - j.startedAt)})` : ""}`).join("\n") };
      },
    },
    {
      definition: {
        name: "job_output",
        description: "Read what a finished background job printed, from a character offset. A job that is still running has nothing to read yet; you are told when it ends. Returns the text and the offset to continue from.",
        input_schema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: jobArg, offset: { type: "integer", minimum: 0, description: "Characters to skip. Default 0." }, limit: { type: "integer", minimum: 1, maximum: 30000, description: "Most characters to return. Default 8000." } } },
      },
      allowKeys: () => [ALL],
      execute: async (args) => {
        const id = args["job"] as string;
        const found = await registry.output(id);
        if (found === undefined) return { content: `There is no job ${id}.`, is_error: true };
        if (found.output === undefined) return { content: `Job ${id} is ${found.status}: there is no output yet.` };
        const offset = (args["offset"] as number | undefined) ?? 0;
        const limit = (args["limit"] as number | undefined) ?? 8000;
        const part = found.output.slice(offset, offset + limit);
        const end = offset + part.length;
        return { content: `${part === "" ? "(nothing at that offset)" : part}\n[job ${id} ${found.status}; ${end >= found.output.length ? `end of output at ${end}` : `continue from offset ${end}`}]` };
      },
    },
    {
      definition: { name: "job_stop", description: "Stop a running background job. It ends with status stopped and you are told what it had printed.", input_schema: { type: "object", additionalProperties: false, required: ["job"], properties: { job: jobArg } } },
      allowKeys: () => [ALL],
      execute: async (args) => {
        const id = args["job"] as string;
        const info = registry.get(id);
        if (info === undefined) return { content: `There is no job ${id}.`, is_error: true };
        return registry.stop(id) ? { content: `Asked job ${id} to stop.` } : { content: `Job ${id} is not running (${info.status}).`, is_error: true };
      },
    },
  ];
}
