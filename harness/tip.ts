import type { ChatEntry } from "./entries.ts";
import { permitted, untilMs, type AllowMap } from "./approvals.ts";
import type { ApprovalContext, ToolRegistry } from "./tools.ts";
import type { LeaseOwner, LeaseState } from "./lease.ts";

/**
 * What a thread's tip needs (docs/tools.md, 5.4): worked out by reading its history, the way the model's context is, so it is the same
 * answer in every process that looks. Nothing here is stored. A session that is not running the thread can show "this thread asks
 * whether to run `run: rm -r build`", and appending an `approval` entry is the whole of answering it.
 *
 * Two things the history cannot say, which the caller supplies: whether a loop is running on the thread right now and whether the last one
 * died (the run lease, `lease.ts`), and what the user would answer. With no lease given the thread is taken to be idle and its last loop
 * to have ended cleanly.
 */

type Call = { call_id: string; name: string; args: Record<string, unknown>; args_raw?: string };

/** Calls of the last assistant entry that nothing answered, unless a user message has come since (the context builder covers that case). */
export function unanswered(entries: readonly ChatEntry[]): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as ChatEntry;
    if (e.$tag === "branch_start" && e.context === "fresh") return [];
    if (e.$tag === "user" && e.queued === true) continue; // sent while the call was running: not an answer to anything
    if (e.$tag === "user" || e.$tag === "interrupted" || e.$tag === "compaction") return [];
    if (e.$tag !== "assistant") continue;
    const answered = new Set<string>();
    for (const later of entries.slice(i + 1)) {
      if (later.$tag === "tool_result" || later.$tag === "subagent_result") answered.add(later.call_id);
      else if (later.$tag === "fork_merge" && later.call_id !== undefined) answered.add(later.call_id);
    }
    return e.blocks.flatMap((b) => (b.$tag === "tool_call" && !answered.has(b.call_id) ? [b.call_id] : []));
  }
  return [];
}

/**
 * Messages sent while the thread was working that the last answer was built without (ids after its `context_tip`, placed before it): the
 * model owes the user a reply to them even though the last entry is an assistant's.
 */
export function unseenQueued(entries: readonly ChatEntry[]): boolean {
  const at = entries.findLastIndex((e) => e.$tag === "assistant");
  const last = entries[at];
  if (last === undefined || last.$tag !== "assistant" || last.context_tip === undefined) return false;
  const tip = last.context_tip;
  return entries.slice(0, at).some((e) => e.$tag === "user" && e.queued === true && e.id > tip);
}

/** Every tool call in the history, by id (the arguments as the entries hold them: a long string may still be a blob reference). */
export function callsIn(entries: readonly ChatEntry[]): Map<string, Call> {
  const calls = new Map<string, Call>();
  for (const e of entries) {
    if (e.$tag !== "assistant") continue;
    for (const b of e.blocks) if (b.$tag === "tool_call") calls.set(b.call_id, { call_id: b.call_id, name: b.name, args: b.args, ...(typeof b.args_raw === "string" ? { args_raw: b.args_raw } : {}) });
  }
  return calls;
}

export type Decision = { allow: true } | { allow: false; reason?: string };

/** The decisions recorded in the history, by call id (the last one for a call wins). */
export function decisionsIn(entries: readonly ChatEntry[]): Map<string, Decision> {
  const out = new Map<string, Decision>();
  for (const e of entries) {
    if (e.$tag === "approval") out.set(e.call_id, e.allow ? { allow: true } : { allow: false, ...(e.reason === undefined ? {} : { reason: e.reason }) });
  }
  return out;
}

/**
 * The grants the history holds, per tool: key to expiry, the later expiry where a key was granted twice. Expired ones are kept (the
 * reader judges them against its clock, as it does for `harness.yml`). Only an allowed decision can carry a grant.
 */
export function threadGrantsIn(entries: readonly ChatEntry[]): Map<string, AllowMap> {
  const out = new Map<string, Record<string, string>>();
  for (const e of entries) {
    if (e.$tag !== "approval" || !e.allow || e.grant === undefined) continue;
    const map = out.get(e.grant.tool) ?? {};
    for (const key of e.grant.keys) {
      const old = map[key];
      const oldT = old === undefined ? undefined : untilMs(old);
      const newT = untilMs(e.grant.until);
      if (newT !== undefined && (oldT === undefined || newT > oldT)) map[key] = e.grant.until;
    }
    out.set(e.grant.tool, map);
  }
  return out;
}

/** Two grant maps as one: each key lasts as long as the longer of its two expiries. */
export function mergeAllow(a: AllowMap | undefined, b: AllowMap | undefined): AllowMap | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out: Record<string, string> = { ...a };
  for (const [k, until] of Object.entries(b)) {
    const old = out[k];
    const oldT = old === undefined ? undefined : untilMs(old);
    const newT = untilMs(until);
    if (newT !== undefined && (oldT === undefined || newT > oldT)) out[k] = until;
  }
  return out;
}

/** What one call that has no result needs next. */
export interface CallNeed {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * `covered`: a live grant covers it, so it can run. `approved` / `declined`: an `approval` entry decided it. `invalid`: the call cannot
   * be run as given (unknown tool, bad arguments), and the loop answers it with the error. `ask`: someone has to decide. `lost`: the host
   * that was running the thread died, so the call may have started; it is answered "did not run" and is neither asked nor run again.
   * `blocked`: it was allowed and waits for another thread (`on`), which is still working; nothing is to be done with it yet.
   */
  status: "covered" | "approved" | "declined" | "invalid" | "ask" | "lost" | "blocked";
  /** For `blocked`: the thread it waits for. */
  on?: string;
  /** For `ask`: what a grant would add to the tool's `allow` map, or null when the call can only be allowed once. */
  keys?: string[] | null;
  /** For `invalid`: the message the model is given. For `declined`: the reason, if one was given. */
  message?: string;
}

export type TipState =
  /** A loop (or a background job) is running on the thread now, in the foreground or in another process. Nothing else is decided here. */
  | { kind: "running"; owner: LeaseOwner; holding: string[] }
  /** Nothing is owed: the model has answered (or was interrupted), and the next move is the user's. */
  | { kind: "awaiting_user" }
  /**
   * A request to the model is owed. Nobody's decision is needed. `cause` says what made it owed: `human` (a user message, or the brief
   * a thread was started with: somebody asked), `event` (a background job's end, a subagent's or fork's report: nobody asked, so running
   * on it is the host's policy, `background.resume`) or `result` (a tool result: the loop that was answering it did not finish).
   */
  | { kind: "ready"; cause: "human" | "event" | "result" }
  /** A call waits for another thread's work (a foreground subagent): this thread is a context switch away, and nothing runs here until that thread finishes. */
  | { kind: "blocked"; calls: CallNeed[]; on: string[] }
  /** Calls have no result and none of them waits for a decision: the loop runs, declines or rejects them in order. */
  | { kind: "run"; calls: CallNeed[] }
  /** At least one call waits for a decision. `question` is the first; `calls` is every call without a result, in order. */
  | { kind: "needs_approval"; calls: CallNeed[]; question: CallNeed };

export interface TipInput {
  entries: readonly ChatEntry[];
  registry: ToolRegistry;
  /** The tool's `allow` map in harness.yml as it is now (`GrantStore.allow`). */
  allow: (tool: string) => Promise<AllowMap | undefined>;
  nowMs: number;
  ctx: ApprovalContext;
  /** The thread's run lease (`Conversation.leaseState`). */
  lease?: LeaseState;
}

/** How each call without a result stands: the same classification the loop uses before it asks anyone. */
export async function classifyCalls(input: TipInput, callIds: readonly string[]): Promise<CallNeed[]> {
  const { entries, registry } = input;
  const calls = callsIn(entries);
  const decisions = decisionsIn(entries);
  const held = threadGrantsIn(entries);
  const out: CallNeed[] = [];
  const interrupted = input.lease?.state === "stale";
  for (const id of callIds) {
    const call = calls.get(id);
    if (call === undefined) continue;
    const base = { callId: id, name: call.name, args: call.args };
    const checked = registry.check(call);
    if ("error" in checked) {
      out.push({ ...base, status: "invalid", message: checked.error });
      continue;
    }
    const decision = decisions.get(id);
    if (decision?.allow === false) {
      out.push({ ...base, args: checked.args, status: "declined", ...(decision.reason === undefined ? {} : { message: decision.reason }) });
      continue;
    }
    if (interrupted && checked.tool.resumable !== true) {
      out.push({ ...base, args: checked.args, status: "lost" });
      continue;
    }
    if (decision !== undefined) {
      const on = await checked.tool.waitingOn?.(checked.args, id);
      out.push({ ...base, args: checked.args, status: on === undefined ? "approved" : "blocked", ...(on === undefined ? {} : { on }) });
      continue;
    }
    const allow = mergeAllow(await input.allow(call.name), held.get(call.name));
    const hit = await permitted(checked.tool, checked.args, allow, input.nowMs, input.ctx);
    if (hit.permitted) {
      const on = await checked.tool.waitingOn?.(checked.args, id);
      out.push({ ...base, args: checked.args, status: on === undefined ? "covered" : "blocked", keys: hit.keys, ...(on === undefined ? {} : { on }) });
    }
    else out.push({ ...base, args: checked.args, status: "ask", keys: (await checked.tool.allowKeys?.(checked.args, input.ctx)) ?? null });
  }
  return out;
}

/** The state of the tip. See `TipState`. */
export async function foldTip(input: TipInput): Promise<TipState> {
  const { entries } = input;
  if (input.lease?.state === "live") return { kind: "running", owner: input.lease.owner, holding: input.lease.holding };
  const open = unanswered(entries);
  if (open.length > 0) {
    const calls = await classifyCalls(input, open);
    const question = calls.find((c) => c.status === "ask");
    if (question !== undefined) return { kind: "needs_approval", calls, question };
    const on = calls.flatMap((c) => (c.status === "blocked" && c.on !== undefined ? [c.on] : []));
    return on.length > 0 ? { kind: "blocked", calls, on } : { kind: "run", calls };
  }
  const last = [...entries].reverse().find((e) => e.$tag !== "header" && e.$tag !== "agent_setup" && e.$tag !== "approval");
  switch (last?.$tag) {
    case "user":
      return { kind: "ready", cause: "human" };
    case "tool_result":
      return { kind: "ready", cause: "result" };
    case "job_event":
    case "subagent_result":
      return { kind: "ready", cause: "event" };
    case "fork_merge":
      return last.call_id === undefined ? { kind: "awaiting_user" } : { kind: "ready", cause: "event" };
    case "branch_start":
      return last.context === "fresh" && last.brief !== undefined ? { kind: "ready", cause: "human" } : { kind: "awaiting_user" };
    case "assistant":
      return unseenQueued(entries) ? { kind: "ready", cause: "human" } : { kind: "awaiting_user" };
    default:
      return { kind: "awaiting_user" };
  }
}
