import { contextEntries } from "./context.ts";
import { buildContext, type ModelContext } from "./context-builder.ts";
import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import { askModel } from "./oneshot.ts";
import { prepareContext, type PrepareOptions, type Prepared } from "./request.ts";
import { chattreeEnglishV1 } from "./renderer.ts";
import { servedModelId } from "./setup.ts";
import { planTrim, byteLength, type TrimRule } from "./trim.ts";

/**
 * Keeping a thread inside the model's window (docs/context.md, sections 5 and 6). `compactionSettings` reads the policy from `harness.yml`;
 * `autoCompact` applies it to a request about to be sent; `summariseRange` is the summary itself, also used by `/compact`.
 */

export interface CompactionSettings {
  auto: "off" | "trim" | "full";
  rule: TrimRule;
  keepRecent: number;
  threshold?: number;
  summaryModel?: string;
  summaryInput: "seen" | "raw";
}

export async function compactionSettings(convo: Conversation): Promise<CompactionSettings> {
  const cfg = await convo.readConfig();
  const c = cfg?.ok === true ? cfg.value.compaction : undefined;
  const t = c?.trim ?? { tool_results: 2048, tool_args: 2048, reasoning: true };
  return {
    auto: c?.auto ?? "off",
    rule: { tool_results: t.tool_results, tool_args: t.tool_args, reasoning: t.reasoning },
    keepRecent: c?.keep_recent ?? 12,
    ...(c?.threshold_tokens === undefined ? {} : { threshold: c.threshold_tokens }),
    ...(c?.summary_model === undefined ? {} : { summaryModel: c.summary_model }),
    summaryInput: c?.summary_input ?? "seen",
  };
}

/** With no `threshold_tokens`: this share of the context window. The rest is what lets a long tool loop finish its turn after a trim. */
export const DEFAULT_SHARE = 0.7;
/** Above this share of the window a request is not sent (when `auto` is on): a model that cannot see its own recent output misbehaves. */
export const HARD_SHARE = 0.9;
/** A trim loses the cache once, so (without `auto: full`) it is only worth it when it takes out at least this share of the threshold, at 4 bytes to a token. */
const WORTH = 0.1;
/** After an automatic summary, no other until this many entries have been added (a summary that did not help is not repeated on every request). */
export const COOLDOWN = 6;

/** The token count at which `auto` acts: the setting, else a share of the model's window; `undefined` when neither is known. */
export const thresholdOf = (s: CompactionSettings, contextWindow: number | undefined): number | undefined => s.threshold ?? (contextWindow === undefined ? undefined : Math.floor(contextWindow * DEFAULT_SHARE));

export class ContextFull extends Error {
  override name = "ContextFull";
  constructor(tokens: number, window: number) {
    super(`the request is about ${tokens} tokens, ${Math.round((tokens / window) * 100)}% of the ${window} token context window, and trimming did not bring it down; it was not sent, because a model that cannot see its own recent work misbehaves. Compact the thread by hand (/compact), start a fresh one, or lower compaction.keep_recent`);
  }
}

export class CompactionInsufficient extends Error {
  override name = "CompactionInsufficient";
  constructor(message: string) {
    super(message);
  }
}

const carries = (e: ChatEntry): boolean => e.$tag === "user" || e.$tag === "assistant" || e.$tag === "tool_result" || e.$tag === "compaction" || e.$tag === "subagent_result" || e.$tag === "fork_merge" || e.$tag === "job_event" || e.$tag === "interrupted";
const idOf = (e: ChatEntry): string | undefined => ("id" in e && typeof e.id === "string" ? e.id : undefined);

/** Whether the next request starts a turn: the last entry that carries content is a user message or a finished job, not the middle of a tool loop. */
export function atTurnStart(entries: readonly ChatEntry[]): boolean {
  const last = contextEntries(entries).findLast(carries);
  return last !== undefined && ((last.$tag === "user" && last.queued !== true) || last.$tag === "job_event");
}

/**
 * The range a summary would replace: from the first entry of the context (an earlier summary included) up to before the last `keepRecent`
 * entries. It never reaches into the open turn (from the last user message on) and never ends between a call and its result.
 */
export function summaryRange(entries: readonly ChatEntry[], keepRecent: number): { from: string; to: string; entries: number } | undefined {
  const visible = contextEntries(entries);
  let end = visible.length - 1;
  for (let kept = 0; end >= 0 && kept < keepRecent; end--) if (carries(visible[end] as ChatEntry)) kept++;
  const open = visible.findLastIndex((e) => e.$tag === "user" && e.queued !== true);
  if (open >= 0) end = Math.min(end, open - 1);
  // Do not cut a call from its result: end before the first assistant in the range whose call is answered after it.
  const answeredLater = new Set<string>();
  for (let i = end + 1; i < visible.length; i++) {
    const e = visible[i] as ChatEntry;
    if (e.$tag === "tool_result" || e.$tag === "subagent_result") answeredLater.add(e.call_id);
    else if (e.$tag === "fork_merge" && e.call_id !== undefined) answeredLater.add(e.call_id);
  }
  for (let i = 0; i <= end; i++) {
    const e = visible[i] as ChatEntry;
    if (e.$tag === "assistant" && e.blocks.some((b) => b.$tag === "tool_call" && answeredLater.has(b.call_id))) {
      end = i - 1;
      break;
    }
  }
  while (end >= 0 && !(carries(visible[end] as ChatEntry) && idOf(visible[end] as ChatEntry) !== undefined)) end--;
  const first = visible.findIndex((e) => carries(e) && idOf(e) !== undefined);
  if (end < 0 || first < 0 || first > end) return undefined;
  const count = visible.slice(first, end + 1).filter(carries).length;
  if (count < 2) return undefined;
  return { from: idOf(visible[first] as ChatEntry) as string, to: idOf(visible[end] as ChatEntry) as string, entries: count };
}

/** A context's turns as plain text, for a summarizer to read. */
export function turnsAsText(ctx: ModelContext): string {
  const lines: string[] = [];
  for (const t of ctx.turns) {
    if (t.role === "user") {
      lines.push(`User: ${t.parts.map((p) => (p.type === "text" ? p.text : `[attachment: ${p.name ?? p.mime}]`)).join("\n")}`);
    } else if (t.role === "assistant") {
      const parts = t.blocks.flatMap((b) => (b.type === "text" ? [b.text] : b.type === "tool_call" ? [`[called ${b.name} ${JSON.stringify(b.args)}]`] : []));
      if (parts.length > 0) lines.push(`Assistant: ${parts.join("\n")}`);
    } else {
      for (const r of t.results) lines.push(`Tool result${r.is_error ? " (error)" : ""} for ${r.call_id}: ${r.content}`);
    }
  }
  return lines.join("\n\n");
}

const SUMMARY_PROMPT = (transcript: string): string =>
  `Summarise this part of a conversation so that the summary can replace it in the model's context and the work can go on from it. Keep: what the user asked for, in nearly their own words; decisions and the reasons for them; facts, names, file paths, numbers and errors that later steps depend on; what was done, what is still to do, and open questions. Drop pleasantries and anything that no longer matters. Plain text, no preamble.\n\n${transcript}`;

/**
 * Ask a model for a summary of `from`..`to` and record it as a compaction. What the summarizer reads is `input`: what the main model sees
 * (`seen`, always smaller than the context that triggered this), or the entries untrimmed (`raw`, when it fits the summarizer's window). The request
 * counts against the limits and its usage goes into the entry, so the ledger has it. An empty summary, or one as long as its source, is refused.
 */
export async function summariseRange(convo: Conversation, opts: PrepareOptions, range: { from: string; to: string }, s: Pick<CompactionSettings, "summaryModel" | "summaryInput">, by: "user" | "auto"): Promise<{ summary: string; model: string }> {
  const setup = await convo.setup();
  if (setup.model === undefined) throw new Error("this thread has no model; set one with /model");
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const dec = new TextDecoder();
  const input = (trims: boolean): Promise<string> =>
    buildContext(entries, {
      system: "",
      target: { provider: setup.model!.provider, model: servedModelId(setup.model!) },
      renderer: chattreeEnglishV1,
      upTo: range.to,
      trims,
      readBytes: async (r) => {
        const bytes = await convo.store.get(r.sha256);
        if (bytes === undefined) throw new Error(`blob ${r.sha256} is missing`);
        return bytes;
      },
      readText: async (r) => {
        const bytes = await convo.store.get(r.sha256);
        if (bytes === undefined) throw new Error(`blob ${r.sha256} is missing`);
        return dec.decode(bytes);
      },
    }).then(turnsAsText);
  const summarizer = s.summaryModel ?? servedModelId(setup.model);
  const window = convo.modelInfo(setup.model.provider, summarizer)?.context_window;
  const fits = (text: string): boolean => window === undefined || byteLength(text) / 3 + 2000 < window * 0.9;
  let transcript = s.summaryInput === "raw" ? await input(false) : await input(true);
  if (s.summaryInput === "raw" && !fits(transcript)) transcript = await input(true);
  if (!fits(transcript)) throw new CompactionInsufficient(`the part of the conversation to summarise (about ${Math.round(byteLength(transcript) / 3)} tokens) does not fit the ${window}-token window of ${summarizer}; set compaction.summary_model to a model with a larger window`);
  const r = await askModel(convo, SUMMARY_PROMPT(transcript), { limits: true, ...(s.summaryModel === undefined ? {} : { model: s.summaryModel }) });
  if (r.text === "") throw new CompactionInsufficient(`${r.model} returned an empty summary, so nothing was compacted`);
  if (byteLength(r.text) >= byteLength(transcript)) throw new CompactionInsufficient(`${r.model} wrote a summary as long as what it summarises, so nothing was compacted`);
  await convo.compact({ from: range.from, to: range.to, summary: r.text, model: r.model, usage: r.record, by });
  return { summary: r.text, model: r.model };
}

/**
 * Apply `compaction.auto` to a request that is about to be built into `prepared`. Returns the request to send (built again if the thread changed).
 *
 * At the threshold: trim everything before the last `keep_recent` entries (with `auto: trim`, only if that is worth losing the cache for). With
 * `auto: full`, if that was not enough and this request starts a turn, write a summary of the older entries (a summary in the middle of a tool loop
 * would hide the work the model is in the middle of). A summary that does not bring the request under the threshold is an error, and is not tried
 * again until `COOLDOWN` entries have been added. Past `HARD_SHARE` of the window the request is not sent.
 */
export async function autoCompact(convo: Conversation, opts: PrepareOptions, prepared: Prepared): Promise<Prepared> {
  const s = await compactionSettings(convo);
  if (s.auto === "off" || prepared.estimate === undefined) return prepared;
  const window = prepared.estimate.contextWindow;
  const threshold = thresholdOf(s, window);
  if (threshold === undefined) return prepared;
  let p = prepared;
  const read = async (): Promise<ChatEntry[]> => (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  if ((p.estimate?.inputTokens ?? 0) >= threshold) {
    const entries = await read();
    const plan = planTrim(entries, s.keepRecent, s.rule);
    if (plan !== undefined && (s.auto === "full" || plan.bytes >= threshold * 4 * WORTH)) {
      await convo.trim({ upto: plan.upto, rule: s.rule, by: "auto" });
      p = await prepareContext(convo, opts);
    }
    if (s.auto === "full" && (p.estimate?.inputTokens ?? 0) >= threshold) {
      const now = await read();
      const lastAuto = now.findLastIndex((e) => e.$tag === "compaction" && e.by === "auto");
      const cooling = lastAuto >= 0 && now.slice(lastAuto + 1).filter(carries).length < COOLDOWN;
      if (!cooling && atTurnStart(now)) {
        const range = summaryRange(now, s.keepRecent);
        if (range === undefined) throw new CompactionInsufficient(`the request is about ${p.estimate?.inputTokens} tokens, over the threshold of ${threshold}, but nothing older than the last ${s.keepRecent} entries can be summarised; lower compaction.keep_recent`);
        await summariseRange(convo, opts, range, s, "auto");
        p = await prepareContext(convo, opts);
        const after = p.estimate?.inputTokens ?? 0;
        if (after >= threshold) throw new CompactionInsufficient(`the summary of ${range.entries} entries did not bring the request under the threshold: it is still about ${after} tokens, and the threshold is ${threshold}. The instructions, tools or the last ${s.keepRecent} entries are most of it; lower compaction.keep_recent or raise compaction.threshold_tokens`);
      }
    }
  }
  const tokens = p.estimate?.inputTokens ?? 0;
  if (window !== undefined && tokens >= window * HARD_SHARE) throw new ContextFull(tokens, window);
  return p;
}
