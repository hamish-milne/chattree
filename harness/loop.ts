import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import { hashDefinition } from "./definitions.ts";
import { DEFAULT_RESULT_LIMIT, ToolRegistry, isStarted, shapeResult, type Tool, type ToolOutput } from "./tools.ts";
import { requestStream, type TurnOptions, type TurnResult } from "./turn.ts";
import type { StreamEvent } from "../providers/types.ts";
import type { Block } from "./context-builder.ts";
import type { ToolConvention } from "../providers/registry.ts";
import { servedModelId, type ModelSetup } from "./setup.ts";
import { flatProblems } from "./tool-schema.ts";
import type { JobRegistry, JobStatus } from "./jobs.ts";
import { keyProblem, permitted, untilAfter, type AllowMap } from "./approvals.ts";
import { callsIn, decisionsIn, mergeAllow, threadGrantsIn, unanswered, unseenQueued } from "./tip.ts";
import { type LeaseBefore, type LeaseOwner } from "./lease.ts";

/**
 * The tool loop (docs/tools.md, section 3): ask the model, run what it asked for, write the results, ask again, until
 * it answers without asking for a tool. Provider-neutral: it only sees `stop_reason: tool_use` and `tool_call` blocks.
 *
 * Every result is its own entry, committed as soon as its call finishes (an entry's commit also takes whatever the
 * tool changed in the workspace), so a crash after the second of three calls leaves two results and one unanswered call,
 * which the context builder already answers with a "did not run" error. The loop never re-runs a call that may have
 * half-finished: calls left unanswered by an earlier loop are answered "did not run" before the first request.
 */

export interface ApprovalRequest {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  tool: Tool;
  /**
   * What a grant would add to the tool's `allow` map (`Tool.allowKeys`), so the host can offer "allow all of these for
   * 5 minutes / 1 hour / forever". `null`: the call can only be allowed once, and the host should offer nothing longer.
   */
  keys: string[] | null;
}

/** A grant the user chose along with "yes": the request's keys, for `seconds` (`Infinity` is forever). */
export interface GrantChoice {
  seconds: number;
  /**
   * Where the grant lives. `project` (the default): in harness.yml, for every thread. `thread`: in the `approval` entry that records the
   * answer, for this thread and the branches forked from it afterwards. Each grant is kept in one place only.
   */
  scope?: "project" | "thread";
  /** Commit the change to harness.yml on its own. Default: only a forever grant. Otherwise it rides with the next commit. */
  commit?: boolean;
}

export type Approval = { allow: true; grant?: GrantChoice } | { allow: false; reason?: string };

/** Where grants live: the tool's `allow` map in harness.yml (`Conversation.grantStore`). */
export interface GrantStore {
  /** The tool's map as the file has it now, read fresh for each call so hand edits and `/tools` take effect at once. */
  allow(tool: string): Promise<AllowMap | undefined>;
  /** Add keys to the tool's map until `until`. */
  grant(tool: string, keys: readonly string[], until: string, opts: { commit: boolean }): Promise<void>;
}

export interface LoopOptions extends TurnOptions {
  registry: ToolRegistry;
  /**
   * Asked before a call that no live grant covers. Without `grants`: asked before every call, and with no `approve`
   * either, every call is allowed (the caller has auto-approved).
   */
  approve?: (request: ApprovalRequest) => Promise<Approval>;
  /**
   * Approvals the user has already given (docs/tools.md, section 5). When set, a call runs unasked only if a live key
   * covers it; otherwise `approve` is asked, and without `approve` the call is declined, never run.
   */
  grants?: GrantStore;
  /**
   * Where background jobs live. With it, a tool called with `background: true` starts a job; the loop commits the events of jobs
   * that ended before each request, and marks jobs lost in an earlier process. Without it such a call is refused.
   */
  jobs?: JobRegistry;
  /** The most bytes of a result the model is shown; the rest is kept as a blob. Default 30,000. */
  resultLimit?: number;
  /**
   * With no `approve`, a call no grant covers is not declined: the loop stops with `needs_approval`, leaving the call (and any after it)
   * without a result, and whoever answers appends an `approval` entry and runs the loop again, which carries on with those calls. The
   * run lease says whether those calls could have started: a lease left behind (the host died) means they may have, and they are answered
   * "did not run"; none means the last loop ended cleanly, by waiting, and they never started.
   */
  waitForApproval?: boolean;
  /** Milliseconds past a tool's own timeout before the loop stops the call itself. Default 5000. */
  toolGraceMs?: number;
  /** Called before each request, between calls and the model's next look: the host's chance to deliver what happened meanwhile (a background subagent's report). */
  beforeRequest?: () => Promise<void>;
}

export type LoopEvent =
  | { type: "request.start"; n: number }
  /** A background job's event was committed; the next request shows it to the model. */
  | { type: "job.event"; job: string; status: JobStatus; summary: string }
  | { type: "stream"; event: StreamEvent }
  | { type: "request.end"; n: number; result: TurnResult }
  | { type: "tool.start"; callId: string; name: string; args: Record<string, unknown> }
  /** The answer to the approval question, when it was asked. */
  | { type: "tool.approval"; callId: string; name: string; allowed: boolean; reason?: string; via?: "allowlist" | "asked" | "headless" | "recorded"; keys?: string[]; granted?: { keys: string[]; until: string }; grantError?: string }
  /** `content` is what was recorded; `skipped` says why a call that did not run got an error result instead. */
  | { type: "tool.result"; callId: string; name: string; content: string; is_error: boolean; truncated: boolean; ms: number; skipped?: string };

export type LoopResult = {
  /**
   * `completed`: the model answered without asking for a tool (`last.completed.stop_reason` says how it ended).
   * `finished`: a tool ended the loop on purpose (its output said `finish`). `interrupted` / `cancelled`: the request was cut off or stopped (see `last`).
   * `stopped`: the user aborted while tools were running. `deadline`: the turn's time limit passed between or during calls.
   * `needs_approval`: a call waits for a decision (`waitForApproval`); `waiting` is the call.
   * `blocked`: a call waits for another thread (`ToolOutput.waiting`); `blocked` is the call and the thread.
   */
  status: "completed" | "interrupted" | "cancelled" | "stopped" | "deadline" | "finished" | "needs_approval" | "blocked";
  /** Requests made by this run. */
  requests: number;
  last?: TurnResult;
  waiting?: { callId: string; name: string; args: Record<string, unknown>; keys: string[] | null };
  blocked?: { callId: string; name: string; on: string };
};

export class ToolsOutOfSync extends Error {
  override name = "ToolsOutOfSync";
  readonly missing: string[];
  readonly changed: string[];
  readonly extra: string[];
  constructor(d: { missing: string[]; changed: string[]; extra: string[] }) {
    const parts = [
      d.missing.length > 0 ? `not yet pinned to the agent: ${d.missing.join(", ")}` : "",
      d.changed.length > 0 ? `definition changed: ${d.changed.join(", ")}` : "",
      d.extra.length > 0 ? `pinned but not registered: ${d.extra.join(", ")}` : "",
    ].filter((p) => p !== "");
    super(`the agent's tools do not match the host's (${parts.join("; ")}); syncTools pins the host's tools`);
    this.missing = d.missing;
    this.changed = d.changed;
    this.extra = d.extra;
  }
}

/** A tool the model's calling convention cannot show properly (docs/tools.md, 3.7). */
export class ToolsNotSupported extends Error {
  override name = "ToolsNotSupported";
  readonly convention: ToolConvention;
  readonly tools: { name: string; why: string[] }[];
  constructor(convention: ToolConvention, tools: { name: string; why: string[] }[]) {
    super(`the model's tool convention is ${convention}, which cannot show: ${tools.map((t) => `${t.name} (${t.why.join(", ")})`).join("; ")}; give these tools flat arguments, remove them, or set tool_convention for this model`);
    this.convention = convention;
    this.tools = tools;
  }
}

/** The tools in the registry that the agent's model cannot be given (none unless its convention is `flat`). */
export function toolConventionProblems(convo: Conversation, registry: ToolRegistry, model: ModelSetup | undefined): { convention: ToolConvention; tools: { name: string; why: string[] }[] } {
  const info = model === undefined ? undefined : convo.modelInfo(model.provider, servedModelId(model));
  const convention = info?.tool_convention ?? "full";
  if (convention === "full") return { convention, tools: [] };
  return { convention, tools: registry.definitions().flatMap((d) => { const why = flatProblems(d.input_schema); return why.length > 0 ? [{ name: d.name, why }] : []; }) };
}

/** How the agent's pinned tools differ from the registry. */
export async function toolDrift(convo: Conversation, registry: ToolRegistry): Promise<{ missing: string[]; changed: string[]; extra: string[] }> {
  const pinned = (await convo.setup()).tools;
  const missing: string[] = [];
  const changed: string[] = [];
  for (const def of registry.definitions()) {
    const pin = pinned[def.name];
    if (pin === undefined) missing.push(def.name);
    else if (pin.hash !== (await hashDefinition("tool", def))) changed.push(def.name);
  }
  return { missing, changed, extra: Object.keys(pinned).filter((n) => registry.get(n) === undefined).sort() };
}

/** Make the agent's pinned tools exactly the registry's (a `tools_changed` setup entry, only when something differs). */
export async function syncTools(convo: Conversation, registry: ToolRegistry) {
  const d = await toolDrift(convo, registry);
  if (d.missing.length + d.changed.length + d.extra.length === 0) return undefined;
  const pins = await registry.pin(convo.store);
  return convo.setupChange({ tools: { set: pins, remove: d.extra } }, { allow: ["tools_changed"] });
}

const DID_NOT_RUN = {
  stopped: "The tool did not run: the user stopped the turn first.",
  deadline: "The tool did not run: the turn's time limit passed first.",
  stale: "The tool did not run: the conversation was interrupted before it started.",
  finished: "The tool did not run: the conversation ended with an earlier call.",
} as const;

type CallBlock = Extract<Block, { type: "tool_call" }>;

/**
 * Run the loop for the thread as it stands: the last entry is a user message (or a tool result, for `/retry` after a
 * limit or a crash). Library refusals (`LimitExceeded`, `ChangeNotAllowed`) are thrown from here, between calls, so the
 * transcript is always valid when they are; asking again after fixing them continues the same turn.
 */
export async function* runLoop(convo: Conversation, opts: LoopOptions): AsyncGenerator<LoopEvent, LoopResult, void> {
  opts.jobs?.enterLoop();
  try {
    return yield* loopBody(convo, opts);
  } finally {
    opts.jobs?.leaveLoop();
  }
}

async function* loopBody(convo: Conversation, opts: LoopOptions): AsyncGenerator<LoopEvent, LoopResult, void> {
  const { registry } = opts;
  const drift = await toolDrift(convo, registry);
  if (drift.missing.length + drift.changed.length + drift.extra.length > 0) throw new ToolsOutOfSync(drift);
  const unsupported = toolConventionProblems(convo, registry, (await convo.setup()).model);
  if (unsupported.tools.length > 0) throw new ToolsNotSupported(unsupported.convention, unsupported.tools);

  // The thread's run lease (lease.ts): taken for the loop, held while it works, released when it ends (background jobs keep it).
  const lease = await RunLease.take(convo, opts.owner ?? {});
  try {
    return yield* steps(convo, opts, lease);
  } finally {
    await lease.end();
  }
}

/** The loop's hold on the thread's run lease: what it is held for and until when. */
class RunLease {
  /** The lease as the loop found it: `stale` means the host that held it died, so a call without a result may have started. */
  readonly before: LeaseBefore;
  readonly #convo: Conversation;
  readonly #owner: LeaseOwner;
  private constructor(convo: Conversation, owner: LeaseOwner, before: LeaseBefore) {
    this.#convo = convo;
    this.#owner = owner;
    this.before = before;
  }
  static async take(convo: Conversation, owner: LeaseOwner): Promise<RunLease> {
    const store = await convo.leaseStore();
    const before = await store.hold(convo.branch, owner, convo.leaseEnv, "loop", convo.now() + LEASE_HEADROOM_MS);
    return new RunLease(convo, owner, before);
  }
  /** The loop will be busy for `ms` more (a request, a tool call), then needs the lease for the usual headroom. */
  async busyFor(ms: number): Promise<void> {
    const store = await this.#convo.leaseStore();
    await store.hold(this.#convo.branch, this.#owner, this.#convo.leaseEnv, "loop", this.#convo.now() + ms + LEASE_HEADROOM_MS);
  }
  async follow(key: string, branch: string): Promise<void> {
    await (await this.#convo.leaseStore()).follow(this.#convo.branch, this.#owner, this.#convo.leaseEnv, key, branch);
  }
  async drop(key: string): Promise<void> {
    await (await this.#convo.leaseStore()).drop(this.#convo.branch, key);
  }
  async end(): Promise<void> {
    await this.drop("loop").catch(() => undefined);
  }
}

/** How long past a deadline the lease stays held, so a host that is slow to finish is not taken for dead. */
const LEASE_HEADROOM_MS = 30_000;
/** Time a tool gets, past its own timeout, to report that timeout itself before the loop stops it. */
const TOOL_GRACE_MS = 5_000;
const DEFAULT_TOOL_SECONDS = 600;
const DEFAULT_REQUEST_SECONDS = 600;

async function* steps(convo: Conversation, opts: LoopOptions, lease: RunLease): AsyncGenerator<LoopEvent, LoopResult, void> {
  const { registry } = opts;
  const now = convo.now;
  const approvalCtx = { workspace: convo.dir, host: convo.host };
  let deadline = opts.deadline;
  const config = await convo.readConfig();
  const limits = config?.ok === true ? config.value.limits : undefined;
  if (deadline === undefined) {
    const secs = limits?.max_turn_seconds;
    if (secs !== undefined) deadline = now() + secs * 1000;
  }
  const toolSeconds = limits?.max_tool_seconds ?? DEFAULT_TOOL_SECONDS;
  const graceMs = opts.toolGraceMs ?? TOOL_GRACE_MS;
  const requestSeconds = limits?.max_request_seconds ?? DEFAULT_REQUEST_SECONDS;
  const stopReason = (): "stopped" | "deadline" | undefined => (opts.signal?.aborted === true ? "stopped" : deadline !== undefined && now() >= deadline ? "deadline" : undefined);

  const record = async function* (call: { call_id: string; name: string }, out: ToolOutput, t0: number, skipped?: string): AsyncGenerator<LoopEvent, void, void> {
    if (out.recorded === true) {
      yield { type: "tool.result", callId: call.call_id, name: call.name, content: out.content, is_error: out.is_error === true, truncated: false, ms: now() - t0 };
      return;
    }
    let full: { $tag: "blob"; sha256: string; bytes: number; mime: string } | undefined;
    const shaped = await shapeResult(out, {
      ...(opts.resultLimit === undefined ? {} : { limit: opts.resultLimit }),
      keep: async (bytes) => {
        const sha256 = await convo.store.put(bytes);
        full = { $tag: "blob", sha256, bytes: bytes.length, mime: "text/plain" };
        return `blob:${sha256}`;
      },
    });
    await convo.append({ $tag: "tool_result", call_id: call.call_id, is_error: shaped.is_error, content: shaped.content, ...(shaped.truncated ? { truncated: true } : {}), ...(full === undefined ? {} : { full }) });
    yield { type: "tool.result", callId: call.call_id, name: call.name, content: shaped.content, is_error: shaped.is_error, truncated: shaped.truncated, ms: now() - t0, ...(skipped === undefined ? {} : { skipped }) };
  };

  if (opts.jobs !== undefined) for (const id of await opts.jobs.recover()) yield { type: "job.event", job: id, status: "lost", summary: `job ${id} was lost` };

  // What the history already says: calls that have a decision, and grants the thread holds (the loop adds to both as it records more).
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const decisions = decisionsIn(entries);
  const held = threadGrantsIn(entries);
  let waiting: NonNullable<LoopResult["waiting"]> | undefined;
  let blocked: NonNullable<LoopResult["blocked"]> | undefined;

  /** A person may take as long as they like to answer in place, so the lease is renewed while they are being asked. */
  const whileAsking = async <T>(ask: () => Promise<T>): Promise<T> => {
    await lease.busyFor(0);
    const beat = setInterval(() => void lease.busyFor(0).catch(() => undefined), LEASE_HEADROOM_MS / 3);
    try {
      return await ask();
    } finally {
      clearInterval(beat);
    }
  };

  /** One call of a response (or a call a crashed loop left, for a tool that can resume): checks, approvals, execution, the result. True when the call ended the loop. */
  const callOne = async function* (call: CallBlock): AsyncGenerator<LoopEvent, "next" | "finish" | "wait" | "blocked", void> {
    const t0 = now();
    yield { type: "tool.start", callId: call.call_id, name: call.name, args: (call.args ?? {}) as Record<string, unknown> };
    const checked = registry.check(call);
    if ("error" in checked) {
      yield* record(call, { content: checked.error, is_error: true }, t0);
      return "next";
    }
    const decline = async function* (reason: string | undefined, via: "asked" | "headless" | "recorded"): AsyncGenerator<LoopEvent, void, void> {
      yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: false, via, ...(reason === undefined ? {} : { reason }) };
      yield* record(call, { content: `The user declined to run this call${reason === undefined || reason === "" ? "." : `: ${reason}`}`, is_error: true }, t0);
    };
    let proceed = true;
    /** Write down the answer to the question, so that every reader of the thread has it (and so a resumed loop does not ask again). */
    const recordDecision = async (d: Approval, grant?: { tool: string; keys: string[]; until: string }): Promise<void> => {
      await convo.append({ $tag: "approval", call_id: call.call_id, allow: d.allow, ...(!d.allow && d.reason !== undefined && d.reason !== "" ? { reason: d.reason } : {}), ...(grant === undefined ? {} : { grant }) });
      decisions.set(call.call_id, d.allow ? { allow: true } : { allow: false, ...(d.reason === undefined ? {} : { reason: d.reason }) });
      if (grant !== undefined) {
        const merged = mergeAllow(held.get(grant.tool), Object.fromEntries(grant.keys.map((k) => [k, grant.until])));
        if (merged !== undefined) held.set(grant.tool, merged);
      }
    };
    const recorded = decisions.get(call.call_id);
    if (recorded !== undefined) {
      // Someone answered while the loop was not running (or the loop was asked and stopped): act on the answer.
      if (recorded.allow) yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: true, via: "recorded" };
      else {
        proceed = false;
        yield* decline(recorded.reason, "recorded");
      }
    } else if (opts.grants !== undefined) {
      const hit = await permitted(checked.tool, checked.args, mergeAllow(await opts.grants.allow(call.name), held.get(call.name)), now(), approvalCtx);
      if (hit.permitted) yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: true, via: "allowlist", keys: hit.keys };
      else if (opts.approve === undefined) {
        const keys = (await checked.tool.allowKeys?.(checked.args, approvalCtx)) ?? null;
        if (opts.waitForApproval === true) {
          waiting = { callId: call.call_id, name: call.name, args: checked.args, keys };
          return "wait";
        }
        proceed = false;
        yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: false, via: "headless" };
        yield* record(call, { content: "This call needs the user's approval and none is available here, so it did not run.", is_error: true }, t0);
      } else {
        const keys = (await checked.tool.allowKeys?.(checked.args, approvalCtx)) ?? null;
        const decision = await whileAsking(() => (opts.approve as NonNullable<typeof opts.approve>)({ callId: call.call_id, name: call.name, args: checked.args, tool: checked.tool, keys }));
        if (!decision.allow) {
          proceed = false;
          await recordDecision(decision);
          yield* decline(decision.reason, "asked");
        } else {
          const ev: Extract<LoopEvent, { type: "tool.approval" }> = { type: "tool.approval", callId: call.call_id, name: call.name, allowed: true, via: "asked" };
          let held_: { tool: string; keys: string[]; until: string } | undefined;
          if (decision.grant !== undefined && keys !== null && keys.length > 0) {
            const bad = keys.map((k) => keyProblem(checked.tool, k)).find((p) => p !== undefined);
            const until = untilAfter(now(), decision.grant.seconds);
            try {
              if (bad !== undefined) throw new Error(bad);
              if (decision.grant.scope === "thread") held_ = { tool: call.name, keys, until };
              else await opts.grants.grant(call.name, keys, until, { commit: decision.grant.commit ?? !Number.isFinite(decision.grant.seconds) });
              ev.granted = { keys, until };
            } catch (e) {
              ev.grantError = e instanceof Error ? e.message : String(e); // the user said yes: this call still runs, once
            }
          }
          await recordDecision(decision, held_);
          yield ev;
        }
      }
    } else if (opts.approve !== undefined) {
      const decision = await whileAsking(() => (opts.approve as NonNullable<typeof opts.approve>)({ callId: call.call_id, name: call.name, args: checked.args, tool: checked.tool, keys: null }));
      await recordDecision(decision);
      yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: decision.allow, ...(decision.allow || decision.reason === undefined ? {} : { reason: decision.reason }) };
      if (!decision.allow) {
        proceed = false;
        yield* record(call, { content: `The user declined to run this call${decision.reason === undefined || decision.reason === "" ? "." : `: ${decision.reason}`}`, is_error: true }, t0);
      }
    }
    if (!proceed) return "next";
    // The call's time is bounded (the tool says how long it may take, else `limits.max_tool_seconds`), and the lease is held that long: a
    // loop that is not heard from after that is dead. A tool that waits for another thread follows that thread's lease instead.
    const allowed = checked.tool.timeout?.(checked.args) ?? toolSeconds;
    const own = new AbortController();
    const signals = [opts.signal, own.signal, deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadline - now()))].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = allowed === "thread" ? undefined : new Promise<"timeout">((resolve) => (timer = setTimeout(() => (resolve("timeout"), own.abort()), allowed * 1000 + graceMs)));
    await lease.busyFor(allowed === "thread" ? 0 : allowed * 1000 + graceMs);
    const followKey = `call:${call.call_id}`;
    let out: ToolOutput;
    try {
      const running = checked.tool.execute(checked.args, { signal, callId: call.call_id, workspace: convo.dir, host: convo.host, blobs: convo.store, lease: { follow: (branch) => lease.follow(followKey, branch) } });
      const res = timedOut === undefined ? await running : await Promise.race([running, timedOut]);
      if (res !== "timeout" && !isStarted(res) && res.waiting !== undefined) {
        blocked = { callId: call.call_id, name: call.name, on: res.waiting };
        return "blocked";
      }
      if (res === "timeout") {
        running.catch(() => undefined); // it was told to stop; whatever it does now is not the loop's concern
        out = { content: `The tool did not finish within ${allowed as number} seconds and was stopped.`, is_error: true };
      } else if (!isStarted(res)) out = res;
      else if (opts.jobs === undefined) {
        res.started.stop();
        out = { content: "background jobs are not available here", is_error: true };
      } else {
        const id = await opts.jobs.start(call.call_id, res.started);
        out = { content: `started job ${id}: ${res.started.summary}. It keeps running; you will be told when it ends (jobs lists jobs, job_stop stops one).` };
      }
    } catch (e) {
      out = { content: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await lease.drop(followKey).catch(() => undefined);
      await lease.busyFor(0).catch(() => undefined);
    }
    yield* record(call, out, t0);
    return out.finish === true ? "finish" : "next";
  };

  // Calls an earlier loop left unanswered are not run again, except those of a tool that can resume (a subagent finds its branch by the
  // call id and carries on); the model hears that the others did not run. Two cases are certain that nothing ran, so the loop carries on:
  // a call the user declined (only the result is missing), and, when the caller says earlier loops ended by waiting (`waitForApproval`),
  // every call: those with a decision or a covering grant run, and one that still waits stops the loop again.
  const blocks = callsIn(entries);
  let resumedFinish = false;
  for (const id of unanswered(entries)) {
    const info = blocks.get(id);
    const call = info === undefined ? undefined : ({ type: "tool_call", call_id: info.call_id, name: info.name, args: info.args, ...(info.args_raw === undefined ? {} : { args_raw: info.args_raw }) } as CallBlock);
    if (resumedFinish) {
      yield* record({ call_id: id, name: call?.name ?? "" }, { content: DID_NOT_RUN.finished, is_error: true }, now(), "finished");
      continue;
    }
    const carryOn = call !== undefined && stopReason() === undefined && ((opts.waitForApproval === true && lease.before !== "stale") || registry.get(call.name)?.resumable === true || decisions.get(id)?.allow === false);
    if (!carryOn) {
      yield* record({ call_id: id, name: call?.name ?? "" }, { content: DID_NOT_RUN.stale, is_error: true }, now(), "stale");
      continue;
    }
    const end = yield* callOne(call);
    if (end === "wait") return { status: "needs_approval", requests: 0, ...(waiting === undefined ? {} : { waiting }) };
    if (end === "blocked") return { status: "blocked", requests: 0, ...(blocked === undefined ? {} : { blocked }) };
    if (end === "finish") resumedFinish = true;
  }
  if (resumedFinish) return { status: "finished", requests: 0 };

  const turnOpts: TurnOptions = { ...opts, deadline: deadline as number };
  if (deadline === undefined) delete (turnOpts as { deadline?: number }).deadline;
  let requests = 0;
  for (;;) {
    if (opts.jobs !== undefined) for (const j of await opts.jobs.flush()) yield { type: "job.event", ...j };
    await opts.beforeRequest?.();
    requests++;
    await lease.busyFor(requestSeconds * 1000);
    yield { type: "request.start", n: requests };
    const gen = requestStream(convo, turnOpts);
    let result: TurnResult;
    for (;;) {
      const n = await gen.next();
      if (n.done) {
        result = n.value;
        break;
      }
      yield { type: "stream", event: n.value };
    }
    yield { type: "request.end", n: requests, result };
    if (result.status !== "completed") return { status: result.status, requests, last: result };
    const calls = result.completed.blocks.filter((b): b is CallBlock => b.type === "tool_call");
    if (result.completed.stop_reason !== "tool_use" || calls.length === 0) {
      // A message sent while this request was streaming was not in it: answer it before the turn ends.
      const now = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
      if (!unseenQueued(now)) return { status: "completed", requests, last: result };
      const why = stopReason();
      if (why !== undefined) return { status: why, requests, last: result };
      continue;
    }

    let finished = false;
    for (const [i, call] of calls.entries()) {
      if (finished) {
        yield* record({ call_id: call.call_id, name: call.name }, { content: DID_NOT_RUN.finished, is_error: true }, now(), "finished");
        continue;
      }
      const why = stopReason();
      if (why !== undefined) {
        for (const rest of calls.slice(i)) yield* record({ call_id: rest.call_id, name: rest.name }, { content: DID_NOT_RUN[why], is_error: true }, now(), why);
        return { status: why, requests, last: result };
      }
      const end = yield* callOne(call);
      if (end === "wait") return { status: "needs_approval", requests, last: result, ...(waiting === undefined ? {} : { waiting }) };
      if (end === "blocked") return { status: "blocked", requests, last: result, ...(blocked === undefined ? {} : { blocked }) };
      if (end === "finish") finished = true;
    }
    if (finished) return { status: "finished", requests, last: result };
    const after = stopReason();
    if (after !== undefined) return { status: after, requests, last: result };
  }
}
