/**
 * What the chat view shows about a thread besides its blocks, from what the harness knows: its status, the status bar, the
 * banner that says why it cannot take a message, and the question a call waits on. Pure functions over values the controller
 * has read; nothing here reads a file, a lease or a clock.
 */

import { summarizeCall } from "../../app/tool-lines.ts";
import type { ChangeKind, ChatEntry } from "../../harness/entries.ts";
import type { Ledger } from "../../harness/ledger.ts";
import type { LeaseOwner, LeaseState } from "../../harness/lease.ts";
import type { AgentSetup } from "../../harness/setup.ts";
import { unanswered, type CallNeed } from "../../harness/tip.ts";
import type { ConfigTrust } from "../../harness/trust.ts";
import type { ModelInfo } from "../../providers/registry.ts";
import type { Approval, ChatBanner, StatusBar } from "../model/chat.ts";
import type { ThreadStatus } from "../model/graph.ts";

export interface StatusInput {
  /** The thread's run lease (`Conversation.leaseState`). */
  lease?: LeaseState | undefined;
  /** A tool call of the thread waits for a decision. */
  awaiting?: boolean | undefined;
  /** The thread's entries, for how its last request ended. */
  entries: readonly ChatEntry[];
  /** Whether a lease owner is this session. */
  self: (owner: LeaseOwner) => boolean;
}

const QUIET = new Set(["header", "agent_setup", "approval", "injection", "file_touch"]);

/**
 * `running` is a request in flight in this session and `elsewhere` one in another process. A thread waiting on a decision is
 * `awaiting`. A lease whose holder is gone, or a last request that ended in an error, is `error`: the thread is stopped by a failure.
 */
export function threadStatus(i: StatusInput): ThreadStatus {
  if (i.lease?.state === "live") return i.awaiting === true ? "awaiting" : i.self(i.lease.owner) ? "running" : "elsewhere";
  if (i.awaiting === true) return "awaiting";
  if (i.lease?.state === "stale") return "error";
  const last = i.entries.findLast((e) => !QUIET.has(e.$tag));
  return last?.$tag === "interrupted" && last.by === "error" ? "error" : "idle";
}

/**
 * Why a thread that nothing is working on is not finished, if it is not: the model owes an answer (a message of the person's nobody
 * answered, a tool result it has not seen, a call without a result) or the last request failed. A person stopping it, or a background
 * event nobody asked about, is not stalled: those wait for the person. A thread the model last answered, or is working on, has no reason.
 * This is a rewound thread's case too: going back to a message or a result leaves one of these as its last entry.
 */
export function stalledReason(entries: readonly ChatEntry[]): string | undefined {
  if (unanswered(entries).length > 0) return "A tool call was left without a result";
  const last = entries.findLast((e) => !QUIET.has(e.$tag));
  switch (last?.$tag) {
    case "user":
      return "Your message has not been answered";
    case "tool_result": {
      // A call the person refused by stopping the turn was answered on purpose: stopping is not a stall.
      const stopped = entries.some((e) => e.$tag === "approval" && e.call_id === last.call_id && !e.allow && e.reason === "stopped");
      return stopped ? undefined : "The model has not seen the result of its tool call";
    }
    case "interrupted":
      return last.by === "error" ? "The last request failed" : undefined;
    default:
      return undefined;
  }
}

/** Why the thread cannot take a message, if it cannot: no provider is set up, or its `harness.yml` was not approved. Trust is the one to ask first, since a changed file may be what removed the provider. */
export function threadBanner(i: {
  trust: ConfigTrust;
  hasProvider: boolean;
  /** What changed the agent without the person (`AgentSetup.unacknowledged`), and the commit before the first of them. */
  unusual?: { changes: readonly ChangeKind[]; before: string } | undefined;
}): ChatBanner | undefined {
  if (i.trust.state !== "trusted") return { kind: "untrusted", state: i.trust.state };
  if (i.unusual !== undefined) return { kind: "unusual_change", changes: i.unusual.changes.map(changeWords), before: i.unusual.before };
  return i.hasProvider ? undefined : { kind: "no_provider" };
}

const CHANGE_WORDS: Record<ChangeKind, string> = {
  model_changed: "the model is a different one",
  provider_changed: "the provider is a different one",
  cache_break: "the cached conversation is lost",
  cost_increase: "requests cost more",
  context_overflow: "the conversation no longer fits the model",
  reasoning_dropped: "the model no longer reasons",
  capability_loss: "the model lost a capability",
  mid_loop: "it happened in the middle of a tool loop",
  tools_changed: "the tools are different",
  instructions_changed: "the instructions are different",
  pricing_changed: "the prices changed",
  resolved_model_changed: "the provider serves a different version of the model",
  renderer_changed: "the way the conversation is shown to the model changed",
};
const changeWords = (k: ChangeKind): string => CHANGE_WORDS[k];

/** The first change nobody acknowledged, with the commit before it, for the banner; the transcript's own order decides which is first. */
export function unusualChange(
  unacknowledged: readonly { id: string; changes: readonly ChangeKind[] }[],
  refs: readonly { id: string | undefined; commit: string }[],
): { changes: ChangeKind[]; before: string } | undefined {
  const first = unacknowledged[0];
  if (first === undefined) return undefined;
  const at = refs.findIndex((r) => r.id === first.id);
  const before = refs[at - 1]?.commit;
  if (at < 1 || before === undefined) return undefined;
  return { changes: [...new Set(unacknowledged.flatMap((u) => u.changes))], before };
}

/** The reasoning level whose settings are all in the model's current settings. */
export function reasoningLevel(settings: Record<string, unknown> | undefined, info: ModelInfo | undefined): string | undefined {
  if (settings === undefined || info?.reasoning === undefined) return undefined;
  let best: [string, number] | undefined;
  for (const [name, set] of Object.entries(info.reasoning)) {
    const keys = Object.keys(set);
    if (keys.length === 0 || !keys.every((k) => JSON.stringify(settings[k]) === JSON.stringify(set[k]))) continue;
    if (best === undefined || keys.length > best[1]) best = [name, keys.length];
  }
  return best?.[0];
}

/** What the last response put in the model's context: everything it was sent, cached or not. */
export function contextUsed(entries: readonly ChatEntry[]): number | undefined {
  const last = entries.findLast((e) => e.$tag === "assistant" && e.usage !== undefined);
  if (last?.$tag !== "assistant" || last.usage === undefined) return undefined;
  const u = last.usage;
  return (u["input_tokens"] ?? 0) + (u["cache_read_tokens"] ?? 0) + (u["cache_write_tokens"] ?? 0);
}

export interface StatusBarInput {
  state: ThreadStatus;
  setup: AgentSetup;
  info?: ModelInfo | undefined;
  ledger: Ledger;
  entries: readonly ChatEntry[];
  /** `stalledReason` for a thread nothing is working on. */
  stalled?: string | undefined;
}

/** The status bar; `undefined` while the thread has no model, which is what the banner is for. */
export function statusBar(i: StatusBarInput): StatusBar | undefined {
  const m = i.setup.model;
  if (m === undefined) return undefined;
  const used = contextUsed(i.entries);
  const thinking = reasoningLevel(m.settings, i.info);
  const spent = i.ledger.conversation;
  return {
    state: i.state,
    model: m.resolved ?? m.id,
    provider: m.provider,
    ...(used === undefined ? {} : { context: { used, ...(i.info?.context_window === undefined ? {} : { limit: i.info.context_window }) } }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(spent.requests - spent.unpriced > 0 ? { usd: spent.usd } : {}),
    ...(spent.unpriced > 0 ? { unpriced: true } : {}),
    ...(i.stalled === undefined ? {} : { stalled: i.stalled }),
  };
}

/** The question a call waits on: exactly what would run. */
export function approvalView(need: Pick<CallNeed, "callId" | "name" | "args">, keys?: readonly string[] | null): Approval {
  const args = JSON.stringify(need.args, null, 2);
  return {
    callId: need.callId,
    name: need.name,
    summary: summarizeCall(need.name, need.args),
    args: args.length > 4000 ? `${args.slice(0, 3999)}…` : args,
    ...(keys === undefined || keys === null || keys.length === 0 ? {} : { keys: [...keys] }),
  };
}
