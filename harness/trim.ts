import type { ChatEntry } from "./entries.ts";
import { contextEntries } from "./context.ts";
import type { z } from "zod";
import type { trimRule } from "./entries.ts";

/**
 * Trimming (docs/context.md, section 5): the cheap kind of compaction. Nothing is summarised: the bulky parts of old entries (big tool output,
 * big tool arguments, reasoning) are left out of what the model sees, and every word the user and the model wrote stays. A `trim` entry
 * records the rule and the last entry it covers, so a replay shows the model the same thing.
 *
 * The two markers below are frozen like a renderer's text: changing them would change what an old thread shows the model.
 */

export type TrimRule = z.infer<typeof trimRule>;

/** What stands in place of a tool's output. */
export const outputLeftOut = (bytes: number): string => `[The ${size(bytes)} of output of this call were left out to save context. Run it again if the output is needed.]`;
/** What stands in place of a long text inside a call's arguments. */
export const valueLeftOut = (bytes: number): string => `[${size(bytes)} left out to save context]`;

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const enc = new TextEncoder();
export const byteLength = (s: string): number => enc.encode(s).length;
export const textBytes = (t: string | { bytes: number }): number => (typeof t === "string" ? byteLength(t) : t.bytes);

/** Both rules at once: a part applies if either does, at the smaller size. */
export function mergeRules(a: TrimRule | undefined, b: TrimRule): TrimRule {
  if (a === undefined) return b;
  const least = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const tool_results = least(a.tool_results, b.tool_results);
  const tool_args = least(a.tool_args, b.tool_args);
  const reasoning = a.reasoning === true || b.reasoning === true ? true : (a.reasoning ?? b.reasoning);
  return { ...(tool_results === undefined ? {} : { tool_results }), ...(tool_args === undefined ? {} : { tool_args }), ...(reasoning === undefined ? {} : { reasoning }) };
}

/**
 * For each entry of a visible sequence (`contextEntries`), the rule that covers it, if any. A trim whose `upto` is not an entry before it
 * in the sequence (unknown, compacted away, or after it) has no effect, like a compaction that cannot be applied.
 */
export function trimRules(visible: readonly ChatEntry[]): (TrimRule | undefined)[] {
  const out = new Array<TrimRule | undefined>(visible.length).fill(undefined);
  const at = new Map<string, number>();
  visible.forEach((e, i) => {
    if (e.$tag === "trim") {
      const k = at.get(e.upto);
      if (k !== undefined) for (let j = 0; j <= k; j++) out[j] = mergeRules(out[j], e.rule);
    }
    if ("id" in e && typeof e.id === "string") at.set(e.id, i);
  });
  return out;
}

/** Replace long text values anywhere inside call arguments. */
export function elideArgs(value: unknown, min: number): unknown {
  const blob = blobBytes(value);
  if (blob !== undefined) return blob >= min ? valueLeftOut(blob) : value;
  if (typeof value === "string") {
    const n = byteLength(value);
    return n >= min ? valueLeftOut(n) : value;
  }
  if (Array.isArray(value)) return value.map((v) => elideArgs(v, min));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elideArgs(v, min)]));
  return value;
}

/** The size of a long string that was stored as a blob (`inlineBlobs` puts it back). */
function blobBytes(v: unknown): number | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return o["$tag"] === "blob" && typeof o["sha256"] === "string" && typeof o["bytes"] === "number" ? o["bytes"] : undefined;
}

function argBytes(value: unknown, min: number): number {
  const blob = blobBytes(value);
  if (blob !== undefined) return blob >= min ? blob : 0;
  if (typeof value === "string") {
    const n = byteLength(value);
    return n >= min ? n : 0;
  }
  if (Array.isArray(value)) return value.reduce<number>((s, v) => s + argBytes(v, min), 0);
  if (typeof value === "object" && value !== null) return Object.values(value).reduce<number>((s, v) => s + argBytes(v, min), 0);
  return 0;
}

/** Bytes a rule would leave out of an entry (by what is stored: a blob's size is known without reading it). */
export function elidedBytes(e: ChatEntry, rule: TrimRule | undefined): number {
  if (rule === undefined) return 0;
  if (e.$tag === "tool_result") {
    const n = textBytes(e.content);
    return rule.tool_results !== undefined && n >= rule.tool_results ? n : 0;
  }
  if (e.$tag === "assistant") {
    let sum = 0;
    for (const b of e.blocks) {
      if (b.$tag === "reasoning" && rule.reasoning === true) sum += (b.visible === undefined ? 0 : textBytes(b.visible)) + (b.payload === undefined ? 0 : JSON.stringify(b.payload).length);
      if (b.$tag === "tool_call" && rule.tool_args !== undefined) sum += argBytes(b.args, rule.tool_args);
    }
    return sum;
  }
  return 0;
}

export interface TrimPlan {
  /** The last entry the new trim covers. */
  upto: string;
  /** Bytes it would leave out that earlier trims have not already. */
  bytes: number;
}

/**
 * Where a trim with `rule` would end if the last `keepRecent` entries stay whole, and what it would save. `undefined` when there is nothing before
 * that point to leave out. Only entries that carry content count towards `keepRecent` (not approvals, setups or injections).
 */
export function planTrim(entries: readonly ChatEntry[], keepRecent: number, rule: TrimRule): TrimPlan | undefined {
  const visible = contextEntries(entries);
  const carries = (e: ChatEntry): boolean => e.$tag === "user" || e.$tag === "assistant" || e.$tag === "tool_result" || e.$tag === "compaction" || e.$tag === "subagent_result" || e.$tag === "fork_merge" || e.$tag === "job_event" || e.$tag === "interrupted";
  let kept = 0;
  let end = visible.length - 1;
  while (end >= 0 && kept < keepRecent) {
    if (carries(visible[end] as ChatEntry)) kept++;
    end--;
  }
  // `end` is the last entry before the kept ones; end the range on an entry that has an id.
  while (end >= 0 && !("id" in (visible[end] as ChatEntry))) end--;
  if (end < 0) return undefined;
  const before = trimRules(visible);
  let bytes = 0;
  for (let i = 0; i <= end; i++) {
    const e = visible[i] as ChatEntry;
    bytes += Math.max(0, elidedBytes(e, mergeRules(before[i], rule)) - elidedBytes(e, before[i]));
  }
  if (bytes === 0) return undefined;
  const last = visible[end] as ChatEntry & { id: string };
  return { upto: last.id, bytes };
}
