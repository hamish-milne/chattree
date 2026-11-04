import type { Conversation } from "./conversation.ts";
import type { HarnessConfig } from "./config.ts";
import type { ChatEntry } from "./entries.ts";
import type { CostWarning } from "./limits.ts";
import type { Prepared } from "./request.ts";
import { thresholdOf, type CompactionSettings } from "./compaction.ts";

/**
 * Injections (docs/context.md, section 2): text the harness puts in front of the model before a request. A rule is a pure function of what the
 * request is about to be built from; whatever it returns is **recorded** as an `injection` entry and the context is built again, so the
 * context is the same on every later request and a replay shows what the model saw. A rule keeps no state of its own: "every N turns" is
 * answered from the history, by finding the last entry written under its key.
 */

export interface InjectionItem {
  /** Names the rule: the last entry with this key tells a rule when it last spoke. */
  key: string;
  text: string;
}

export interface InjectionContext {
  /** What the request would be built from (setup, context, estimate, ledger, warnings). */
  prepared: Prepared;
  /** The entries of this agent's flow (nothing from before a fresh-context marker). */
  entries: readonly ChatEntry[];
  /** The host's clock, as `Date.now()`. */
  now: number;
  /** Responses the model has given in this flow so far. */
  turns: number;
  /** Responses since the last injection under `key`, or `undefined` if there has been none. */
  since(key: string): number | undefined;
}

export type InjectionRule = (ctx: InjectionContext) => InjectionItem | readonly InjectionItem[] | undefined | Promise<InjectionItem | readonly InjectionItem[] | undefined>;

function flowOf(entries: readonly ChatEntry[]): ChatEntry[] {
  let start = 0;
  entries.forEach((e, i) => {
    if (e.$tag === "branch_start" && e.context === "fresh") start = i;
  });
  return entries.slice(start);
}

export function injectionContext(entries: readonly ChatEntry[], prepared: Prepared, now: number): InjectionContext {
  const flow = flowOf(entries);
  const turns = flow.filter((e) => e.$tag === "assistant").length;
  return {
    prepared,
    entries: flow,
    now,
    turns,
    since(key) {
      const at = flow.findLastIndex((e) => e.$tag === "injection" && e.key === key);
      return at < 0 ? undefined : flow.slice(at).filter((e) => e.$tag === "assistant").length;
    },
  };
}

// ---- built-in: usage ----------------------------------------------------------------------------------------

const USAGE_KINDS: readonly CostWarning["kind"][] = ["near_limit", "context_window", "long_context"];
/** While a warning stands, it is repeated this many responses after the last time, so a long task does not lose it. */
const USAGE_REPEAT = 5;

/** Tell the model what the user is told when a request nears a limit or the context window, so it can plan (wrap up, summarise). */
export const usageRule: InjectionRule = (ctx) => {
  const out: InjectionItem[] = [];
  for (const kind of USAGE_KINDS) {
    const messages = ctx.prepared.warnings.filter((w) => w.kind === kind).map((w) => w.message);
    if (messages.length === 0) continue;
    const key = `usage:${kind}`;
    const since = ctx.since(key);
    if (since === undefined || since >= USAGE_REPEAT) out.push({ key, text: `Usage notice: ${messages.join("; ")}.` });
  }
  return out;
};

// ---- built-in: compaction is near -------------------------------------------------------------------------------

/** Tell the model, from this share of the compaction threshold, that its context will be reduced, so it writes down what it needs before that. */
export const SOON_SHARE = 0.85;

export function compactionRule(s: CompactionSettings): InjectionRule {
  return (ctx) => {
    const tokens = ctx.prepared.estimate?.inputTokens;
    const threshold = thresholdOf(s, ctx.prepared.estimate?.contextWindow);
    if (tokens === undefined || threshold === undefined || tokens < threshold * SOON_SHARE) return undefined;
    const since = ctx.since("compaction:soon");
    if (since !== undefined && since < USAGE_REPEAT) return undefined;
    const what = s.auto === "full" ? "At the start of the next turn the older part of this conversation will be replaced by a summary, and before that the long tool output, long tool arguments and reasoning of older steps are left out." : "The long tool output, long tool arguments and reasoning of older steps will be left out.";
    return { key: "compaction:soon", text: `The context is filling up (about ${tokens} tokens; it is reduced at ${threshold}). ${what} Your own text and the user's messages stay. Before then, write down what you will need later (decisions, findings, file paths, what is left to do) in a file or in your reply, and do not repeat earlier output.` };
  };
}

// ---- rules from harness.yml ---------------------------------------------------------------------------------

type ConfigRule = HarnessConfig["injections"]["rules"][string] & {};

/** A reminder from `harness.yml`: its text (or the file's) every N responses, and on the first request if `first` is set. */
export function configRule(key: string, rule: ConfigRule, readFile: (path: string) => Promise<string>): InjectionRule {
  return async (ctx) => {
    const since = ctx.since(key);
    const due = since === undefined ? (rule.first ? true : ctx.turns >= rule.every) : since >= rule.every;
    if (!due) return undefined;
    const text = rule.text ?? (await readFile(rule.file as string));
    return text.trim() === "" ? undefined : { key, text: text.trim() };
  };
}

/** The rules `harness.yml` asks for, ahead of any the host passes. */
export function rulesFromConfig(cfg: HarnessConfig["injections"], readFile: (path: string) => Promise<string>): InjectionRule[] {
  return [...(cfg.usage ? [usageRule] : []), ...Object.entries(cfg.rules).map(([key, r]) => configRule(key, r, readFile))];
}

// ---- running them -------------------------------------------------------------------------------------------

/**
 * Run the rules and record what they return, in rule order. A rule that throws is skipped and reported (the request must still go out), and
 * the text of a rule that returns nothing, or an empty text, is not recorded. Resolves to how many entries were written and what failed.
 */
export async function runInjections(convo: Conversation, rules: readonly InjectionRule[], prepared: Prepared): Promise<{ appended: number; failures: CostWarning[] }> {
  if (rules.length === 0) return { appended: 0, failures: [] };
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const ctx = injectionContext(entries, prepared, convo.now());
  const failures: CostWarning[] = [];
  let appended = 0;
  const seen = new Set<string>();
  for (const rule of rules) {
    let items: InjectionItem | readonly InjectionItem[] | undefined;
    try {
      items = await rule(ctx);
    } catch (e) {
      failures.push({ kind: "injection_failed", message: `an injection rule failed and was skipped: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    for (const item of items === undefined ? [] : Array.isArray(items) ? items : [items as InjectionItem]) {
      if (item.text.trim() === "" || seen.has(item.key)) continue; // one entry per key per request
      seen.add(item.key);
      await convo.inject(item.key, item.text);
      appended++;
    }
  }
  return { appended, failures };
}
