import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import type { Prepared } from "./request.ts";
import { planTrim, type TrimRule } from "./trim.ts";

/** A trim loses the cache once, so it is only worth it when it takes out at least this share of the threshold (4 bytes to a token). */
const WORTH = 0.1;
/** With no `threshold_tokens`, trim when a request would use this share of the model's context window. */
const DEFAULT_SHARE = 0.7;

/** The rule `harness.yml` asks trims to use. */
export async function trimRuleOf(convo: Conversation): Promise<{ rule: TrimRule; keepRecent: number; auto: boolean; threshold?: number }> {
  const cfg = await convo.readConfig();
  const c = cfg?.ok === true ? cfg.value.compaction : undefined;
  const t = c?.trim ?? { tool_results: 2048, tool_args: 2048, reasoning: true };
  return { rule: { tool_results: t.tool_results, tool_args: t.tool_args, reasoning: t.reasoning }, keepRecent: c?.keep_recent ?? 12, auto: c?.auto === "trim", ...(c?.threshold_tokens === undefined ? {} : { threshold: c.threshold_tokens }) };
}

/**
 * At a request that would reach the threshold, record a trim of everything before the last `keep_recent` entries, if it would take out enough
 * to matter (`compaction.auto: trim` in `harness.yml`; off by default). Returns whether it wrote one, so the caller builds the request again.
 */
export async function autoTrim(convo: Conversation, prepared: Prepared): Promise<boolean> {
  const { rule, keepRecent, auto, threshold: configured } = await trimRuleOf(convo);
  if (!auto || prepared.estimate === undefined) return false;
  const window = prepared.estimate.contextWindow;
  const threshold = configured ?? (window === undefined ? undefined : Math.floor(window * DEFAULT_SHARE));
  if (threshold === undefined || prepared.estimate.inputTokens < threshold) return false;
  const entries: ChatEntry[] = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const plan = planTrim(entries, keepRecent, rule);
  if (plan === undefined || plan.bytes < threshold * 4 * WORTH) return false;
  await convo.trim({ upto: plan.upto, rule, by: "auto" });
  return true;
}
