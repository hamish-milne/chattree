import { localOwner } from "../../app/owner.ts";
import { mediaFor, type ToolSet } from "../../app/toolset.ts";
import { openThread, type Project } from "../../app/project.ts";
import type { AppEnv } from "../../app/env.ts";
import type { Conversation } from "../../harness/conversation.ts";
import { SYSTEM_PROMPT, type HostEnvironment } from "../../harness/environment.ts";
import { toolDrift, type LoopEvent } from "../../harness/loop.ts";
import { Pump, type Question } from "../../harness/pump.ts";
import type { CycleEnd, RunOptions } from "../../harness/runs.ts";
import { deliverSubagents, subagentChildRegistry, subagentGrants, subagentNudge } from "../../harness/subagent.ts";
import { thrownText } from "../../providers/wire.ts";

/** What the background runner needs from the controller. */
export interface BackgroundHost {
  env: AppEnv;
  session: string;
  /** The repository's project and trunk: where threads live and which conversation lists them. */
  project: Project;
  trunk: Conversation;
  environment: HostEnvironment | undefined;
  /** The tool set of a thread (its own tools, and the children's, `childRegistry`). */
  toolsetFor(thread: string): Promise<ToolSet>;
  /** The controller runs this thread itself (a message was sent, or it is the one on screen): the pump leaves it alone. */
  owns(thread: string): boolean;
  /** The controller has run this thread in this session, so it has a tool set and may have handed work to others (the pump looks for their reports). */
  ran(thread: string): boolean;
  /** The pump would run a thread the controller owns; its owner should. `at` says what is owed, so it is told from what was owed already. */
  wanted(thread: string, at: string | undefined): void;
  /** What a run the pump has is doing, event by event. */
  event(thread: string, e: LoopEvent): void | Promise<void>;
  /** A run the pump had has ended. `why` says if it did not end by finishing. */
  ended(thread: string, why: string | undefined): void;
  /** The questions waiting changed, or what a thread waits for did. */
  changed(): void;
  /** Said once, for the person (a thread's tools could not be pinned). */
  say(text: string): void;
}

/**
 * The threads that run without a person at the keyboard: subagents, and forks that were started to work by themselves. A `Pump` looks
 * at every thread of the repository, runs the ones whose next step needs no one, and collects the questions of the ones that do, so
 * the controller can show them where the person is looking (the thread, and every thread that waits for it). The thread on screen is
 * the controller's own and the pump only tells it when it is owed a request.
 */
export class Background {
  readonly pump: Pump;
  readonly #host: BackgroundHost;
  /** Whether a thread, the last time it was looked at, was a subagent (its tools are the children's). */
  readonly #subs = new Map<string, boolean>();

  constructor(host: BackgroundHost) {
    this.#host = host;
    this.pump = new Pump({
      // The pump has handles of its own: it appends answers and reports while the controller's handles stay as they were.
      open: async (branch) => (await openThread(host.env, host.project, branch, { providers: "optional" })).convo,
      threads: async () => {
        const merged = await host.trunk.mergedBranches();
        return (await host.trunk.listBranches()).filter((b) => !b.archived && !merged.has(b.name)).map((b) => b.name);
      },
      loop: (convo) => this.#loopFor(convo),
      resume: async (convo) => (await host.toolsetFor(convo.branch)).resume,
      idle: subagentNudge,
      deliver: async (convo) => await deliverSubagents(convo),
      leave: (convo) => (host.owns(convo.branch) || host.ran(convo.branch)) && this.#subs.get(convo.branch) !== true,
      onWanted: (branch, at) => host.wanted(branch, at),
      onEvent: (branch, e) => void host.event(branch, e),
      onEnd: (branch, end) => host.ended(branch, endedWhy(end)),
      onQuestions: () => host.changed(),
    });
  }

  /** The tool set a thread's children get comes from the thread they were started from. */
  async #parentOf(convo: Conversation): Promise<string | undefined> {
    const entries = await convo.readEntries();
    const start = entries.flatMap((e) => (e.ok && e.value.$tag === "branch_start" ? [e.value] : [])).at(-1);
    return start?.from.branch;
  }

  /**
   * What the pump needs to run a thread, or undefined to leave it alone: a subagent gets its parent's leaf tools (and its hand-back
   * tool), a fork that was started to work by itself gets them as pinned, and any other thread is a person's, which the controller runs.
   */
  async #loopFor(convo: Conversation): Promise<RunOptions | undefined> {
    const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const start = entries.findLast((e) => e.$tag === "branch_start" && e.context === "fresh");
    const sub = start?.$tag === "branch_start" && start.kind === "subagent";
    this.#subs.set(convo.branch, sub);
    // A thread the controller has run is looked at with its own tools, so reports to it are delivered and what it waits for is known;
    // the controller starts its requests (`leave`), the pump only says when one is owed.
    if (!sub && this.#host.ran(convo.branch)) {
      let own: ToolSet;
      try {
        own = await this.#host.toolsetFor(convo.branch);
      } catch {
        return undefined;
      }
      return {
        system: SYSTEM_PROMPT,
        environment: this.#host.environment,
        owner: localOwner(this.#host.session),
        jobs: own.jobs,
        media: mediaFor(this.#host.env, () => convo.git.commonDir()),
        registry: own.registry,
        grants: convo.grantStore(),
      };
    }
    const parent = await this.#parentOf(convo);
    if (parent === undefined) return undefined;
    let set: ToolSet;
    try {
      set = await this.#host.toolsetFor(parent);
    } catch {
      return undefined;
    }
    const base = {
      system: SYSTEM_PROMPT,
      environment: this.#host.environment,
      owner: localOwner(this.#host.session),
      jobs: set.jobs,
      media: mediaFor(this.#host.env, () => convo.git.commonDir()),
    };
    if (sub) return { ...base, registry: subagentChildRegistry(set.childRegistry), grants: subagentGrants(convo.grantStore(), set.merge) };
    // A thread that is not a subagent runs by itself only if its pinned tools are exactly the ones a child gets: a fork that was started to.
    const d = await toolDrift(convo, set.childRegistry);
    if (d.missing.length + d.changed.length + d.extra.length > 0) return undefined;
    return { ...base, registry: set.childRegistry, grants: convo.grantStore() };
  }

  /** Run a subagent thread the pump left alone (it stopped or failed) again, as its own kind of thread; false for any other thread. */
  resume(thread: string): boolean {
    if (this.#subs.get(thread) !== true) return false;
    this.pump.release(thread);
    void this.pump.tick([thread]).catch(() => undefined);
    return true;
  }

  /** Stop what the pump is running on a thread, and leave the thread alone until it is resumed. */
  stop(thread: string): boolean {
    if (!this.running(thread)) return false;
    this.pump.hold(thread, "stopped");
    this.pump.runs.abort(thread);
    return true;
  }

  /** Whether the thread is a subagent. */
  isSubagent(thread: string): boolean {
    return this.#subs.get(thread) === true;
  }

  /** The questions waiting, in every thread the pump looks at. */
  questions(): Question[] {
    return this.pump.questions();
  }

  /** What a thread is waiting for from other threads, if anything. */
  blockedOn(thread: string): readonly string[] | undefined {
    return this.pump.blockedOn(thread);
  }

  /** The thread's own question, if a call of its waits for a decision and the pump holds it. */
  own(thread: string): Question | undefined {
    return this.questions().find((q) => q.branch === thread);
  }

  /** The questions of the threads that wait for this one: what is forwarded up to it. */
  below(thread: string): Question[] {
    return this.questions().filter((q) => q.branch !== thread && q.ancestors.includes(thread));
  }

  /** Whether the pump has a loop running on a thread. */
  running(thread: string): boolean {
    return this.pump.runs.get(thread)?.state === "running";
  }

  async close(): Promise<void> {
    await this.pump.close();
  }
}

function endedWhy(end: CycleEnd): string | undefined {
  const status = end.result?.status;
  if (end.error !== undefined) return `failed: ${thrownText(end.error)}`;
  if (status === "stopped" || status === "deadline" || status === "interrupted" || status === "cancelled") return status;
  return undefined;
}
