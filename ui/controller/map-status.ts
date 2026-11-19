/**
 * What the chat view shows about a thread besides its blocks, from what the harness knows: its status, the status bar, the
 * banner that says why it cannot take a message, and the question a call waits on. Pure functions over values the controller
 * has read; nothing here reads a file, a lease or a clock.
 */

import { summarizeCall } from "../../app/tool-lines.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import type { Ledger } from "../../harness/ledger.ts";
import type { LeaseOwner, LeaseState } from "../../harness/lease.ts";
import type { AgentSetup } from "../../harness/setup.ts";
import type { CallNeed } from "../../harness/tip.ts";
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

const QUIET = new Set(["header", "agent_setup", "approval", "injection"]);

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

/** Why the thread cannot take a message, if it cannot: no provider is set up, or its `harness.yml` was not approved. Trust is the one to ask first, since a changed file may be what removed the provider. */
export function threadBanner(i: { trust: ConfigTrust; hasProvider: boolean }): ChatBanner | undefined {
  if (i.trust.state !== "trusted") return { kind: "untrusted", state: i.trust.state };
  return i.hasProvider ? undefined : { kind: "no_provider" };
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
  };
}

/** The question a call waits on: exactly what would run. */
export function approvalView(need: Pick<CallNeed, "callId" | "name" | "args">): Approval {
  const args = JSON.stringify(need.args, null, 2);
  return {
    callId: need.callId,
    name: need.name,
    summary: summarizeCall(need.name, need.args),
    args: args.length > 4000 ? `${args.slice(0, 3999)}…` : args,
  };
}
