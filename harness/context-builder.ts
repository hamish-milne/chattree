import { contextEntries } from "./context.ts";
import type { ChatEntry } from "./entries.ts";
import type { ToolDefinition } from "./definitions.ts";
import { chattreeEnglishV1, type Renderer } from "./renderer.ts";

/**
 * Turns a branch's entries into what a provider is asked: a provider-neutral `ModelContext`. Pure apart from
 * reading blobs; no network, no provider code. Adapters translate the result into their API's messages.
 * See docs/providers.md, P1.
 */

type EntryBlock = Extract<ChatEntry, { $tag: "assistant" }>["blocks"][number];
/** An assistant block with its texts read in. `payload` is opaque and goes back to the provider verbatim. */
export type Block =
  | { type: "text"; text: string; ext?: Record<string, unknown> }
  | { type: "reasoning"; provider: string; payload: string; visible?: string; ext?: Record<string, unknown> }
  | { type: "tool_call"; call_id: string; name: string; args: Record<string, unknown>; args_raw?: string; ext?: Record<string, unknown> };
type BlobRef = Extract<ChatEntry, { $tag: "tool_result" }>["content"] & { $tag: "blob" };

export type UserPart = { type: "text"; text: string } | { type: "attachment"; name: string | undefined; data: BlobRef };

export type Turn =
  | { role: "user"; parts: UserPart[] }
  | { role: "assistant"; provider: string; model: string; blocks: Block[] }
  | { role: "tool_results"; results: { call_id: string; is_error: boolean; content: string; truncated: boolean }[] };

export interface ModelContext {
  /** The harness's own prompt: part of the pinned prefix. */
  system: string;
  /** Global instructions; the adapter decides whether they ride in the system block or as a first message. */
  instructions: string | undefined;
  turns: Turn[];
  /** Canonical tool definitions, sorted by name. */
  tools: ToolDefinition[];
  /** Turn indexes after which a stable prefix ends: the previous exchange, and the last turn. */
  cacheHints: number[];
}

export interface BuildInput {
  system: string;
  instructions?: string | undefined;
  tools?: ToolDefinition[];
  /** The model this context is for. Reasoning travels only to the model that produced it. */
  target: { provider: string; model: string };
  /** Turns structured entries into text for the model. Default: `chattree-english-v1`. See `renderer.ts`. */
  renderer?: Renderer;
  /** Read a blob-backed text (large values are stored as blobs). Without it, a blob reference is an error. */
  readText?: (ref: { sha256: string; bytes: number }) => Promise<string>;
}

type Pending = { call_id: string; is_error: boolean; content: string; truncated: boolean; fallback?: string };

/**
 * Build the context for the next request.
 *
 * - `contextEntries` decides what is visible (fresh-context markers, compactions).
 * - Entries without a provider form are rendered as text by the renderer (the agent setup's `renderer`).
 * - Reasoning blocks are kept only for the model that produced them (same provider and model).
 * - An interrupted turn keeps its text; a half-received tool call becomes a note, never a live call.
 * - Tool calls and results always pair: a call with no result gets an error result ("did not run"), and a
 *   result with no call is dropped, so the request is valid however the conversation got here.
 * - Consecutive user turns are merged.
 */
export async function buildContext(entries: readonly ChatEntry[], input: BuildInput): Promise<ModelContext> {
  const render = input.renderer ?? chattreeEnglishV1;
  const text = async (t: string | { sha256: string; bytes: number }): Promise<string> => {
    if (typeof t === "string") return t;
    if (input.readText === undefined) throw new Error(`a blob-backed text (${t.sha256.slice(0, 12)}) needs readText`);
    return input.readText(t);
  };
  const keepReasoning = (provider: string, model: string, b: EntryBlock): boolean => b.$tag !== "reasoning" || (provider === input.target.provider && model === input.target.model && b.provider === input.target.provider);
  const block = async (b: EntryBlock): Promise<Block> => {
    const ext = b.ext === undefined ? {} : { ext: b.ext };
    if (b.$tag === "text") return { type: "text", text: await text(b.text), ...ext };
    if (b.$tag === "reasoning") return { type: "reasoning", provider: b.provider, payload: await text(b.payload), ...(b.visible === undefined ? {} : { visible: b.visible }), ...ext };
    return { type: "tool_call", call_id: b.call_id, name: b.name, args: b.args, ...(b.args_raw === undefined ? {} : { args_raw: b.args_raw }), ...ext };
  };

  type Raw = Turn | { role: "result"; result: Pending };
  const raw: Raw[] = [];
  const userText = (s: string): void => void raw.push({ role: "user", parts: [{ type: "text", text: s }] });

  for (const e of contextEntries(entries)) {
    switch (e.$tag) {
      case "header":
      case "agent_setup":
        break;
      case "branch_start":
        if (e.context === "fresh" && e.brief !== undefined) userText(render.subagentBrief(await text(e.brief)));
        break;
      case "user": {
        const parts: UserPart[] = [];
        for (const p of e.content) parts.push(p.$tag === "text" ? { type: "text", text: await text(p.text) } : { type: "attachment", name: p.name, data: p.data as BlobRef });
        raw.push({ role: "user", parts });
        break;
      }
      case "assistant": {
        const blocks: Block[] = [];
        for (const b of e.blocks) if (keepReasoning(e.provider, e.model, b)) blocks.push(await block(b));
        if (blocks.length > 0) raw.push({ role: "assistant", provider: e.provider, model: e.model, blocks });
        break;
      }
      case "tool_result":
        raw.push({ role: "result", result: { call_id: e.call_id, is_error: e.is_error, content: await text(e.content), truncated: e.truncated === true } });
        break;
      case "compaction":
        userText(render.compaction(await text(e.summary)));
        break;
      case "subagent_result": {
        const summary = await text(e.summary);
        raw.push({ role: "result", result: { call_id: e.call_id, is_error: false, content: render.subagentResult(summary, e.files), truncated: false, fallback: render.subagentResultUnattached(summary, e.files) } });
        break;
      }
      case "fork_merge":
        userText(render.forkMerge(await text(e.summary), e.files));
        break;
      case "interrupted": {
        const blocks: Block[] = [];
        for (const b of e.partial) {
          if (b.$tag === "text") blocks.push({ type: "text", text: await text(b.text) });
          else if (b.$tag === "tool_call") blocks.push({ type: "text", text: render.cutOffCall(b.name) });
        }
        if (blocks.length > 0) raw.push({ role: "assistant", provider: "", model: "", blocks });
        break;
      }
    }
  }

  // Pair calls with results.
  const turns: Turn[] = [];
  let open = new Map<string, true>(); // calls of the last assistant turn still waiting for a result
  const answered = new Set<string>();
  const closeOpen = (): void => {
    if (open.size === 0) return;
    const results = [...open.keys()].map((call_id) => ({ call_id, is_error: true, content: render.toolDidNotRun(), truncated: false }));
    const last = turns.at(-1);
    if (last?.role === "tool_results") last.results.push(...results);
    else turns.push({ role: "tool_results", results });
    open = new Map();
  };
  let pendingResults: Pending[] = [];
  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    const results: Omit<Pending, "fallback">[] = [];
    const orphans: Pending[] = [];
    for (const r of pendingResults) {
      if (open.has(r.call_id) && !answered.has(r.call_id)) {
        const { fallback: _f, ...plain } = r;
        results.push(plain);
        open.delete(r.call_id);
        answered.add(r.call_id);
      } else orphans.push(r);
    }
    // Anything the call never got a result for is answered now, in call order, before the result turn closes.
    pendingResults = [];
    if (results.length > 0) turns.push({ role: "tool_results", results });
    for (const o of orphans) if (o.fallback !== undefined) turns.push({ role: "user", parts: [{ type: "text", text: o.fallback }] });
  };
  for (const r of raw) {
    if (r.role === "result") {
      pendingResults.push(r.result);
      continue;
    }
    flushResults();
    if (r.role === "assistant") {
      closeOpen();
      turns.push(r);
      open = new Map(r.blocks.flatMap((b) => (b.type === "tool_call" ? ([[b.call_id, true]] as const) : [])));
    } else {
      closeOpen();
      turns.push(r);
    }
  }
  flushResults();
  closeOpen();

  // Merge consecutive user turns.
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged.at(-1);
    if (t.role === "user" && last?.role === "user") last.parts.push(...t.parts);
    else merged.push(t);
  }

  // Cache hints: the end of the previous exchange (the last assistant turn before the final turn), and the last turn.
  const hints: number[] = [];
  const lastIdx = merged.length - 1;
  for (let i = lastIdx - 1; i >= 0; i--) {
    if (merged[i]?.role === "assistant") {
      hints.push(i);
      break;
    }
  }
  if (lastIdx >= 0) hints.push(lastIdx);

  return { system: input.system, instructions: input.instructions, turns: merged, tools: input.tools ?? [], cacheHints: hints };
}

/** The structural rules every built context must satisfy (used by tests and the turn runner as a last check). */
export function contextProblems(ctx: ModelContext): string[] {
  const out: string[] = [];
  const open = new Set<string>();
  ctx.turns.forEach((t, i) => {
    if (t.role === "assistant") {
      if (open.size > 0) out.push(`turn ${i}: tool calls without results: ${[...open].join(", ")}`);
      open.clear();
      for (const b of t.blocks) if (b.type === "tool_call") open.add(b.call_id);
      if (t.blocks.length === 0) out.push(`turn ${i}: empty assistant turn`);
    } else if (t.role === "tool_results") {
      for (const r of t.results) {
        if (!open.delete(r.call_id)) out.push(`turn ${i}: result for ${r.call_id} has no call`);
      }
      if (open.size > 0) out.push(`turn ${i}: calls left unanswered: ${[...open].join(", ")}`);
    } else {
      if (open.size > 0) out.push(`turn ${i}: user turn while tool calls are unanswered: ${[...open].join(", ")}`);
      if (ctx.turns[i - 1]?.role === "user") out.push(`turn ${i}: consecutive user turns`);
      if (t.parts.length === 0) out.push(`turn ${i}: empty user turn`);
    }
  });
  if (open.size > 0) out.push(`end: tool calls without results: ${[...open].join(", ")}`);
  return out;
}
