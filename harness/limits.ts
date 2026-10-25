import type { HarnessConfig } from "./config.ts";
import type { Estimate } from "./estimate.ts";
import type { Ledger } from "./ledger.ts";

/**
 * The spending limits (docs/providers.md, P9). A request that would break one is not sent. `warn_at` is the fraction
 * of a limit at which a warning is raised first. To go past a limit, edit `harness.yml`.
 */

export type Limits = HarnessConfig["limits"];

export type LimitName = "max_request_usd" | "max_turn_usd" | "max_conversation_usd" | "max_requests_per_turn" | "unknown_price";

export interface Violation {
  limit: LimitName;
  /** What the request would bring the figure to. */
  value: number;
  limitValue: number;
  message: string;
}

export interface CostWarning {
  kind: "near_limit" | "unknown_price" | "unpriced_history" | "context_window" | "long_context";
  message: string;
}

export class LimitExceeded extends Error {
  override name = "LimitExceeded";
  readonly violations: readonly Violation[];
  constructor(violations: readonly Violation[]) {
    super(`request not sent: ${violations.map((v) => v.message).join("; ")}; to go past it, change the limit in harness.yml`);
    this.violations = violations;
  }
}

const usd = (n: number): string => `$${n < 0.1 ? n.toFixed(4) : n.toFixed(2)}`;

export function checkLimits(opts: { limits: Limits; ledger: Ledger; estimate: Estimate }): { violations: Violation[]; warnings: CostWarning[] } {
  const { limits, ledger, estimate } = opts;
  const violations: Violation[] = [];
  const warnings: CostWarning[] = [];
  const warnAt = limits.warn_at ?? 0.8;
  const next = estimate.usd;

  const money = (limit: Exclude<LimitName, "max_requests_per_turn" | "unknown_price">, label: string, before: number): void => {
    const cap = limits[limit];
    if (cap === undefined || next === undefined) return;
    const value = before + next;
    if (value > cap) violations.push({ limit, value, limitValue: cap, message: `${label} would reach ${usd(value)}, over the limit of ${usd(cap)}` });
    else if (value >= cap * warnAt) warnings.push({ kind: "near_limit", message: `${label} will reach ${usd(value)}, ${Math.round((value / cap) * 100)}% of the limit of ${usd(cap)}` });
  };
  money("max_request_usd", "this request", 0);
  money("max_turn_usd", "this turn", ledger.turn.usd);
  money("max_conversation_usd", "the conversation", ledger.conversation.usd);

  const cap = limits.max_requests_per_turn;
  if (cap !== undefined) {
    const value = ledger.turn.requests + 1;
    if (value > cap) violations.push({ limit: "max_requests_per_turn", value, limitValue: cap, message: `this would be request ${value} in the turn, over the limit of ${cap}` });
    else if (value >= cap * warnAt) warnings.push({ kind: "near_limit", message: `this is request ${value} of ${cap} allowed in the turn` });
  }

  const enforced = limits.max_request_usd !== undefined || limits.max_turn_usd !== undefined || limits.max_conversation_usd !== undefined;
  if (next === undefined) {
    const message = "the price of this model is unknown, so the cost of the request cannot be estimated" + (enforced ? " and the cost limits cannot be enforced" : "");
    if (limits.unknown_price === "block") violations.push({ limit: "unknown_price", value: 0, limitValue: 0, message });
    else warnings.push({ kind: "unknown_price", message });
  }
  if (ledger.conversation.unpriced > 0) warnings.push({ kind: "unpriced_history", message: `${ledger.conversation.unpriced} earlier request(s) had no known price, so the spend shown is understated` });
  if (estimate.contextWindow !== undefined && estimate.inputTokens >= estimate.contextWindow * 0.9) warnings.push({ kind: "context_window", message: `the request is about ${estimate.inputTokens} tokens, ${Math.round((estimate.inputTokens / estimate.contextWindow) * 100)}% of the ${estimate.contextWindow} token context window` });
  if (estimate.longContextAt !== undefined && estimate.inputTokens >= estimate.longContextAt * 0.9) warnings.push({ kind: "long_context", message: `the request is within 10% of ${estimate.longContextAt} tokens, where the price per token rises` });
  return { violations, warnings };
}
