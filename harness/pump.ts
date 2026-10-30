import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import { keyProblem, untilAfter } from "./approvals.ts";
import { ThreadRuns, type CycleEnd, type Run, type RunOptions } from "./runs.ts";
import type { Approval, LoopEvent } from "./loop.ts";
import { decisionsIn, foldTip, unanswered, type CallNeed, type TipState } from "./tip.ts";

/**
 * The pump (docs/tools.md, 5.4). It looks at the threads of a project, works out from each tip what is needed next (`foldTip`) and does
 * what needs no person: it runs a thread whose calls are decided, and runs the parent again when the subagent it waited for has handed
 * back. What does need a person is a question, and the pump only collects those (`questions`); `answer` is the whole of answering one. A
 * pump is not tied to a screen: a terminal drives one and shows its events, a headless host drives one and has nobody to ask.
 *
 * Nothing is remembered that the transcripts do not say, apart from threads it has stopped restarting (`held`): a thread whose loop was
 * stopped, timed out or failed is left alone until someone releases it, so a stuck thread is not run again in a circle.
 */
export interface PumpHooks {
  /** A conversation on a branch's worktree. The pump closes it when it is done with it. */
  open(branch: string): Promise<Conversation>;
  /** The threads worth looking at: not archived, not merged. */
  threads(): Promise<string[]>;
  /** How this thread's loop is run, or undefined to leave the thread alone (a screen has it). Must set `registry`; `waitForApproval` is set by the pump. */
  loop(convo: Conversation): Promise<RunOptions | undefined>;
  /**
   * Whether a thread that is owed a request only because something happened (a job ended, a subagent reported: `background.resume`) is
   * run. Something a person did (a message, a brief) always is. Default: no.
   */
  resume?(convo: Conversation): boolean | Promise<boolean>;
  /** A thread is waiting for its next message with nothing owed: the text of a user message to send it, or undefined (a subagent that stopped without reporting). */
  idle?(convo: Conversation, entries: readonly ChatEntry[]): Promise<string | undefined>;
  /** Called with the thread, before its state is looked at, so work that others left for it can be done (a background subagent's report). */
  deliver?(convo: Conversation): Promise<unknown>;
  /** A thread a screen has (the one the user is on): the pump looks at it, asks its questions and says when it would run it (`onWanted`), but never starts its loop. */
  leave?(convo: Conversation): boolean;
  /** A thread that `leave` kept would have been run now: its owner should run it. */
  onWanted?(branch: string, at: string | undefined): void;
  onEvent?(branch: string, event: LoopEvent): void;
  onEnd?(branch: string, end: CycleEnd): void;
  /** The set of questions changed. */
  onQuestions?(questions: Question[]): void;
  now?(): number;
}

/** A call that waits for somebody to decide, and where. */
export interface Question {
  branch: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** What a grant would add to the tool's allow list, or null when the call can only be allowed once. */
  keys: string[] | null;
}

export type AnswerResult = { status: "recorded"; granted?: { keys: string[]; until: string }; grantError?: string } | { status: "already_decided" | "gone" };

export class Pump {
  readonly runs = new ThreadRuns();
  readonly #hooks: PumpHooks;
  readonly #open = new Map<string, Conversation>();
  readonly #held = new Map<string, string>();
  readonly #questions = new Map<string, Question>();
  #chain: Promise<unknown> = Promise.resolve();
  #closed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #tips = "";
  #swept = 0;

  constructor(hooks: PumpHooks) {
    this.#hooks = hooks;
  }

  #now(): number {
    return this.#hooks.now?.() ?? Date.now();
  }

  /** The questions waiting, oldest thread first. */
  questions(): Question[] {
    return [...this.#questions.values()];
  }

  /** Threads that were left alone after their loop was stopped or failed, with why. */
  held(): ReadonlyMap<string, string> {
    return this.#held;
  }

  /** Leave a thread alone (the user stopped it at a question) until it is released. */
  hold(branch: string, why: string): void {
    this.#held.set(branch, why);
  }

  /** Let the pump run a held thread again. */
  release(branch: string): void {
    this.#held.delete(branch);
  }

  /** Drop the handle kept for a branch (its owner changed); a handle this pump opened is closed unless `keep`. Never while a loop runs on it. */
  async forget(branch: string, opts: { keep?: boolean; except?: Conversation } = {}): Promise<void> {
    const c = this.#open.get(branch);
    if (c === undefined || this.runs.get(branch)?.state === "running") return;
    this.#open.delete(branch);
    if (opts.keep !== true && c !== opts.except) await c.close().catch(() => undefined);
  }

  async #convo(branch: string): Promise<Conversation> {
    let c = this.#open.get(branch);
    if (c === undefined) {
      c = await this.#hooks.open(branch);
      this.#open.set(branch, c);
    }
    return c;
  }

  /** One look at every thread (or just `only`), starting what can be started. Calls are queued, so two ticks never overlap. */
  tick(only?: readonly string[]): Promise<void> {
    const next = this.#chain.then(() => (this.#closed ? undefined : this.#tick(only)));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #tick(only?: readonly string[]): Promise<void> {
    const names = only ?? (await this.#hooks.threads());
    for (const name of names) {
      if (this.#closed) return;
      try {
        await this.#look(name);
      } catch {
        // A thread that cannot be read now is looked at again next time.
      }
    }
    if (only === undefined) {
      for (const b of [...this.#questions.keys()]) if (!names.includes(b)) this.#questions.delete(b);
      this.#hooks.onQuestions?.(this.questions());
    }
  }

  async #look(branch: string): Promise<void> {
    const run = this.runs.get(branch);
    if (run?.state === "running") return;
    const convo = await this.#convo(branch);
    const options = await this.#hooks.loop(convo);
    if (options === undefined) {
      this.#setQuestion(branch, undefined);
      return;
    }
    await this.#hooks.deliver?.(convo);
    const tip = await this.#fold(convo, options);
    this.#setQuestion(branch, tip.kind === "needs_approval" ? tip.question : undefined, branch);
    if (this.#held.has(branch)) return;
    const wants = await this.#wants(convo, tip);
    if (wants === undefined) return;
    if (this.#hooks.leave?.(convo) === true) {
      this.#hooks.onWanted?.(branch, wants.at);
      return;
    }
    if (wants.say !== undefined) await convo.append({ $tag: "user", content: [{ $tag: "text", text: wants.say }] });
    this.#start(branch, convo, options);
  }

  async #fold(convo: Conversation, options: RunOptions): Promise<TipState> {
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    return foldTip({
      entries,
      registry: options.registry,
      allow: (tool) => (options.grants === undefined ? Promise.resolve(undefined) : options.grants.allow(tool)),
      nowMs: this.#now(),
      ctx: { workspace: convo.dir, host: convo.host },
      lease: await convo.leaseState(),
    });
  }

  /** Whether to start the thread's loop now, and with what user message first. */
  async #wants(convo: Conversation, tip: TipState): Promise<{ say?: string; at?: string } | undefined> {
    const at = await this.#lastEntryId(convo);
    switch (tip.kind) {
      case "running":
      case "blocked":
      case "needs_approval":
        return undefined;
      case "run": {
        const decided = tip.calls.some((c) => c.status === "covered" || c.status === "approved" || c.status === "declined" || c.status === "invalid");
        return decided ? { ...(at === undefined ? {} : { at }) } : undefined;
      }
      case "ready":
        if (tip.cause === "human" || (tip.cause === "event" && (await this.#hooks.resume?.(convo)) === true)) return { ...(at === undefined ? {} : { at }) };
        return undefined;
      case "awaiting_user": {
        const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
        const say = await this.#hooks.idle?.(convo, entries);
        return say === undefined ? undefined : { say };
      }
    }
  }

  /** The id of the last entry that says something about the thread's state (not set-up or approvals): what a screen compares to tell new from old. */
  async #lastEntryId(convo: Conversation): Promise<string | undefined> {
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const last = entries.findLast((e) => e.$tag !== "header" && e.$tag !== "agent_setup" && e.$tag !== "approval");
    return last !== undefined && "id" in last && typeof last.id === "string" ? last.id : undefined;
  }

  #setQuestion(branch: string, need: CallNeed | undefined, from?: string): void {
    if (need === undefined || from === undefined) {
      this.#questions.delete(branch);
      return;
    }
    this.#questions.set(branch, { branch, callId: need.callId, name: need.name, args: need.args, keys: need.keys ?? null });
  }

  #start(branch: string, convo: Conversation, options: RunOptions): void {
    const opts: RunOptions = { ...options, waitForApproval: true };
    let run: Run | undefined = this.runs.get(branch);
    if (run === undefined) {
      run = this.runs.start(convo, opts, { kind: "subagent", label: branch });
      run.subscribe((e) => this.#hooks.onEvent?.(branch, e));
    } else run.resume(opts);
    void run.cycleEnd({ next: false }).then((end) => this.#ended(branch, end));
  }

  #ended(branch: string, end: CycleEnd | undefined): void {
    if (end === undefined || this.#closed) return;
    this.#hooks.onEnd?.(branch, end);
    const status = end.result?.status;
    if (end.error !== undefined) this.#held.set(branch, `the loop failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`);
    else if (status === "stopped" || status === "deadline" || status === "interrupted" || status === "cancelled") this.#held.set(branch, `the loop ended: ${status}`);
    // A thread that finished or is waiting changes what others need (a parent waits for this one), so everything is looked at again.
    void this.tick().catch(() => undefined);
  }

  /** Tick until nothing is running and nothing new starts. For tests and for a headless host that wants the work done. */
  async settle(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      await this.tick();
      const active = this.runs.list().filter((r) => r.state === "running");
      if (active.length === 0) {
        await this.#chain;
        if (this.runs.list().every((r) => r.state !== "running")) {
          const before = this.runs.list().reduce((n, r) => n + r.cycles, 0);
          await this.tick();
          if (this.runs.list().reduce((n, r) => n + r.cycles, 0) === before) return;
        }
        continue;
      }
      await Promise.all(active.map((r) => this.runs.get(r.branch)?.cycleEnd({ next: false })));
    }
    throw new Error("the pump did not settle");
  }

  /**
   * Watch for changes made by other processes: tips are compared every `pollMs`, and every `sweepMs` all threads are looked at anyway
   * (a lease running out is a change nothing writes down).
   */
  watch(pollMs = 1500, sweepMs = 10_000): () => void {
    if (this.#timer !== undefined) return () => undefined;
    const poll = async (): Promise<void> => {
      try {
        const names = await this.#hooks.threads();
        const first = names[0];
        if (first === undefined) return;
        const convo = await this.#convo(first);
        const r = await convo.git.run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], { readOnly: true });
        const tips = new TextDecoder().decode(r.stdout);
        const now = this.#now();
        if (tips !== this.#tips || now - this.#swept >= sweepMs) {
          this.#tips = tips;
          this.#swept = now;
          await this.tick();
        }
      } catch {
        /* looked at again next time */
      }
    };
    this.#timer = setInterval(() => void poll(), pollMs);
    return () => this.unwatch();
  }

  unwatch(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Answer a question: appends the `approval` entry to the thread (the first answer wins; a call that already has a decision or no longer
   * waits is reported, and nothing is written), records a project grant in harness.yml, then looks at the thread again so its loop runs.
   */
  async answer(branch: string, callId: string, decision: Approval): Promise<AnswerResult> {
    const convo = await this.#convo(branch);
    const options = await this.#hooks.loop(convo);
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const stale = (status: "gone" | "already_decided"): AnswerResult => {
      this.#questions.delete(branch);
      return { status };
    };
    if (!unanswered(entries).includes(callId)) return stale("gone");
    if (decisionsIn(entries).has(callId)) return stale("already_decided");
    let granted: { keys: string[]; until: string } | undefined;
    let grantError: string | undefined;
    let held: { tool: string; keys: string[]; until: string } | undefined;
    const q = this.#questions.get(branch);
    if (decision.allow && decision.grant !== undefined && options !== undefined) {
      const tip = await this.#fold(convo, options);
      const need = tip.kind === "needs_approval" ? tip.calls.find((c) => c.callId === callId) : undefined;
      const tool = need === undefined ? undefined : options.registry.get(need.name);
      const keys = need?.keys ?? q?.keys ?? null;
      if (tool !== undefined && need !== undefined && keys !== null && keys.length > 0) {
        const until = untilAfter(this.#now(), decision.grant.seconds);
        try {
          const bad = keys.map((k) => keyProblem(tool, k)).find((p) => p !== undefined);
          if (bad !== undefined) throw new Error(bad);
          if (decision.grant.scope === "thread") held = { tool: need.name, keys, until };
          else if (options.grants === undefined) throw new Error("this thread has no place to keep a grant");
          else await options.grants.grant(need.name, keys, until, { commit: decision.grant.commit ?? !Number.isFinite(decision.grant.seconds) });
          granted = { keys, until };
        } catch (e) {
          grantError = e instanceof Error ? e.message : String(e);
        }
      }
    }
    await convo.append({
      $tag: "approval",
      call_id: callId,
      allow: decision.allow,
      ...(!decision.allow && decision.reason !== undefined && decision.reason !== "" ? { reason: decision.reason } : {}),
      ...(held === undefined ? {} : { grant: held }),
    });
    this.#questions.delete(branch);
    this.#held.delete(branch);
    void this.tick([branch]).catch(() => undefined);
    return { status: "recorded", ...(granted === undefined ? {} : { granted }), ...(grantError === undefined ? {} : { grantError }) };
  }

  /** Stop every loop and let go of every conversation. */
  async close(): Promise<void> {
    this.#closed = true;
    this.unwatch();
    this.runs.closeAll();
    await this.#chain;
    for (const c of this.#open.values()) await c.close().catch(() => undefined);
    this.#open.clear();
  }
}
