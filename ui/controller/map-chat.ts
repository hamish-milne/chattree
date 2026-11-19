/**
 * Entries to what the chat view draws. Pure apart from reading blobs (injected): no git, no lock, no provider. The
 * controller reads a branch's entries with their commits and gives them to `mapEntries`, which pairs each tool call with
 * its approval and result, folds a turn's requests into one `turn_end`, and turns everything else that is not a message
 * into a notice. Output is checked against the `Block` schema by the tests, so a shape the view cannot draw fails there.
 */

import { summarizeCall } from "../../app/tool-lines.ts";
import { attachmentKind } from "../../harness/attachments.ts";
import { inlineBlobs } from "../../harness/context-builder.ts";
import type { EntryRef } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import type { EntrySpend } from "../../harness/ledger.ts";
import type { AttachmentView, Block } from "../model/transcript.ts";

/** An entry with its place in the history; `ref.commit` is the anchor a block carries. */
export interface MapItem {
  entry: ChatEntry;
  ref: Pick<EntryRef, "commit">;
}

export interface MapEnv {
  /** Bytes of a stored blob, if it is there. */
  blob(sha256: string): Promise<Uint8Array | undefined>;
  /** Longest text sent to the view; longer is cut and marked. Default 20,000 characters. */
  maxText?: number;
}

/** What is known about the calls that have no result yet, from outside the entries. */
export interface MapState {
  /** Calls asked about and waiting for an answer. */
  awaiting?: ReadonlySet<string>;
  /** Calls that are running now. */
  running?: ReadonlySet<string>;
  /** What each item cost, by its index in the items (see `entrySpends`). */
  spends?: ReadonlyMap<number, EntrySpend>;
}

type Entry<T extends ChatEntry["$tag"]> = Extract<ChatEntry, { $tag: T }>;
type Of<T extends Block["type"]> = Extract<Block, { type: T }>;
type Text = string | { $tag: "blob"; sha256: string; bytes: number; mime?: string | undefined };

const DEFAULT_MAX_TEXT = 20_000;
const MAX_ARGS = 4_000;
const NOTICE_DETAIL = 600;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The mime type as the view groups it. */
function kindOf(mime: string): AttachmentView["kind"] {
  const k = attachmentKind(mime);
  return k ?? "other";
}

class Mapper {
  readonly out: Block[] = [];
  readonly #env: MapEnv;
  readonly #state: MapState;
  readonly #max: number;
  /** Where each call's block is in `out`. */
  readonly #tools = new Map<string, number>();
  readonly #declined = new Set<string>();
  #turn:
    | { usage: { input: number; output: number; cached: number }; usd: number; unpriced: boolean; stop: string; id: string; commit: string }
    | undefined;

  constructor(env: MapEnv, state: MapState) {
    this.#env = env;
    this.#state = state;
    this.#max = env.maxText ?? DEFAULT_MAX_TEXT;
  }

  /** Text in full unless it is huge: `[text, cut]`. */
  async #read(v: Text): Promise<[string, boolean]> {
    const s =
      typeof v === "string"
        ? v
        : new TextDecoder().decode((await this.#env.blob(v.sha256)) ?? new TextEncoder().encode("(content not available)"));
    return s.length <= this.#max ? [s, false] : [s.slice(0, this.#max), true];
  }

  async #text(v: Text): Promise<string> {
    return (await this.#read(v))[0];
  }

  #notice(
    e: { id?: string },
    commit: string,
    kind: Of<"notice">["kind"],
    level: Of<"notice">["level"],
    title: string,
    detail?: string,
  ): void {
    this.out.push({
      type: "notice",
      id: e.id ?? `${kind}.${this.out.length}`,
      commit,
      kind,
      level,
      title,
      ...(detail === undefined || detail === "" ? {} : { detail: clip(detail, NOTICE_DETAIL) }),
    });
  }

  #addUsage(usage: Record<string, number> | undefined, spend: EntrySpend | undefined, stop: string, id: string, commit: string): void {
    const t = (this.#turn ??= { usage: { input: 0, output: 0, cached: 0 }, usd: 0, unpriced: false, stop, id, commit });
    t.usage.input += usage?.["input_tokens"] ?? 0;
    t.usage.output += usage?.["output_tokens"] ?? 0;
    t.usage.cached += usage?.["cache_read_tokens"] ?? 0;
    if (spend !== undefined) {
      t.usd += spend.spend.usd;
      if (spend.spend.unpriced > 0) t.unpriced = true;
    }
    t.stop = stop;
    t.id = id;
    t.commit = commit;
  }

  /** Close the turn that was going: one block for what its requests used. */
  endTurn(): void {
    const t = this.#turn;
    this.#turn = undefined;
    if (t === undefined) return;
    this.out.push({
      type: "turn_end",
      id: `end.${t.id}`,
      commit: t.commit,
      usage: t.usage,
      ...(t.usd > 0 || !t.unpriced ? { usd: t.usd } : {}),
      ...(t.unpriced ? { unpriced: true } : {}),
      stop: t.stop,
    });
  }

  #status(callId: string): Of<"tool">["status"] {
    if (this.#declined.has(callId)) return "did_not_run";
    if (this.#state.awaiting?.has(callId) === true) return "awaiting_approval";
    if (this.#state.running?.has(callId) === true) return "running";
    return "pending";
  }

  async #args(args: Record<string, unknown>, raw: Text | undefined): Promise<{ text: string; summary: Record<string, unknown> }> {
    const inlined = await inlineBlobs(args, async (r) => this.#text({ $tag: "blob", ...r }));
    const obj =
      inlined !== null && typeof inlined === "object" && !Array.isArray(inlined) ? Object.fromEntries(Object.entries(inlined)) : {};
    if (Object.keys(obj).length === 0 && raw !== undefined) return { text: clip(await this.#text(raw), MAX_ARGS), summary: {} };
    return { text: clip(JSON.stringify(obj, null, 2), MAX_ARGS), summary: obj };
  }

  #tool(callId: string): Of<"tool"> | undefined {
    const i = this.#tools.get(callId);
    const b = i === undefined ? undefined : this.out[i];
    return b?.type === "tool" ? b : undefined;
  }

  async #user(e: Entry<"user">, commit: string): Promise<void> {
    this.endTurn();
    const texts: string[] = [];
    const attachments: AttachmentView[] = [];
    for (const p of e.content) {
      if (p.$tag === "text") texts.push(await this.#text(p.text));
      else {
        const mime = p.data.mime ?? "application/octet-stream";
        attachments.push({ name: p.name ?? "attachment", mime, kind: kindOf(mime), bytes: p.data.bytes });
      }
    }
    this.out.push({
      type: "user",
      id: e.id,
      commit,
      text: texts.join("\n\n"),
      attachments,
      ...(e.queued === true ? { queued: true } : {}),
      ...(e.from === undefined ? {} : { from: e.from }),
    });
  }

  async #blocks(blocks: Entry<"assistant">["blocks"], id: string, model: string, commit: string, partial: boolean): Promise<void> {
    for (const [i, b] of blocks.entries()) {
      if (b.$tag === "text") {
        const markdown = await this.#text(b.text);
        if (markdown !== "") this.out.push({ type: "assistant", id: `${id}.${i}`, commit, markdown, model });
      } else if (b.$tag === "reasoning") {
        const text = b.visible === undefined ? "" : await this.#text(b.visible);
        if (text !== "") this.out.push({ type: "reasoning", id: `${id}.${i}`, commit, text });
      } else if (b.$tag === "tool_call") {
        const a = await this.#args(b.args, b.args_raw);
        this.#tools.set(b.call_id, this.out.length);
        if (partial) this.#declined.add(b.call_id);
        this.out.push({
          type: "tool",
          id: b.call_id,
          commit,
          name: b.name,
          summary: summarizeCall(b.name, a.summary),
          args: a.text,
          status: this.#status(b.call_id),
        });
      }
    }
  }

  async #result(e: Entry<"tool_result">, commit: string): Promise<void> {
    const [text, cut] = await this.#read(e.content);
    const result = { text, truncated: cut || e.truncated === true };
    const tool = this.#tool(e.call_id);
    if (tool === undefined) {
      this.out.push({
        type: "tool",
        id: e.call_id,
        commit,
        name: "unknown call",
        summary: "unknown call",
        args: "{}",
        status: e.is_error ? "error" : "ok",
        result,
      });
      return;
    }
    tool.status = this.#declined.has(e.call_id) ? "did_not_run" : e.is_error ? "error" : "ok";
    tool.result = result;
  }

  async #setup(e: Entry<"agent_setup">, commit: string): Promise<void> {
    const parts: string[] = [];
    if (e.model !== undefined) parts.push(`model ${e.model.provider}/${e.model.resolved ?? e.model.id}`);
    if (e.instructions !== undefined) parts.push("instructions");
    if (e.tools !== undefined) parts.push("tools");
    if (e.skills !== undefined) parts.push("skills");
    if (e.mcp !== undefined) parts.push("MCP servers");
    if (e.renderer !== undefined) parts.push("renderer");
    if (e.pricing !== undefined) parts.push("prices");
    // A fork or subagent copies the setup it started from: that is not news.
    if (parts.length === 0 || e.reason === "fork" || e.reason === "subagent") return;
    const observed = e.reason === "provider" || e.reason === "resolved";
    const changes = (e.changes ?? []).map((c) => c.replaceAll("_", " "));
    this.#notice(
      e,
      commit,
      "setup",
      observed && changes.length > 0 ? "warning" : "info",
      observed ? `The provider reported a different ${e.model === undefined ? "setup" : "model"}` : `Setup changed: ${parts.join(", ")}`,
      observed ? `${parts.join(", ")}${changes.length > 0 ? ` (${changes.join(", ")})` : ""}` : undefined,
    );
  }

  async add(item: MapItem, index: number): Promise<void> {
    const e = item.entry;
    const commit = item.ref.commit;
    const spend = this.#state.spends?.get(index);
    switch (e.$tag) {
      case "header":
        return;
      case "user":
        return this.#user(e, commit);
      case "assistant":
        await this.#blocks(e.blocks, e.id, e.model, commit, false);
        this.#addUsage(e.usage, spend, e.stop_reason, e.id, commit);
        return;
      case "interrupted":
        await this.#blocks(e.partial, e.id, "", commit, true);
        this.#addUsage(e.usage, spend, "interrupted", e.id, commit);
        this.#notice(
          e,
          commit,
          "interrupted",
          e.by === "error" ? "error" : "warning",
          e.by === "error" ? "The request failed" : "Interrupted",
          e.error,
        );
        return;
      case "tool_result":
        return this.#result(e, commit);
      case "approval": {
        if (!e.allow) {
          this.#declined.add(e.call_id);
          const tool = this.#tool(e.call_id);
          if (tool !== undefined) {
            tool.status = "did_not_run";
            if (e.reason !== undefined && tool.result === undefined) tool.result = { text: e.reason, truncated: false };
          }
        }
        return;
      }
      case "compaction":
        this.#notice(
          e,
          commit,
          "compaction",
          "info",
          e.by === "auto" ? "Conversation compacted automatically" : "Conversation compacted",
          await this.#text(e.summary),
        );
        return;
      case "trim": {
        const r = e.rule;
        const what = [
          r.tool_results === undefined ? undefined : `tool output over ${r.tool_results} bytes`,
          r.tool_args === undefined ? undefined : `tool arguments over ${r.tool_args} bytes`,
          r.reasoning === true ? "reasoning" : undefined,
        ].filter((x): x is string => x !== undefined);
        this.#notice(
          e,
          commit,
          "trim",
          "info",
          e.by === "auto" ? "Older output trimmed automatically" : "Older output trimmed",
          what.join(", "),
        );
        return;
      }
      case "agent_setup":
        return this.#setup(e, commit);
      case "injection":
        this.#notice(e, commit, "injection", "info", `Reminder added: ${e.key}`, await this.#text(e.text));
        return;
      case "branch_start":
        this.#notice(
          e,
          commit,
          "branch",
          "info",
          e.kind === "fork" ? `Forked from ${e.from.branch}` : `Subagent started from ${e.from.branch}`,
          e.brief === undefined ? undefined : await this.#text(e.brief),
        );
        return;
      case "subagent_result": {
        const summary = await this.#text(e.summary);
        const n = e.files.changed.length + e.files.added.length;
        const tool = this.#tool(e.call_id);
        if (tool === undefined) {
          this.#notice(e, commit, "subagent_result", "info", `Subagent ${e.branch} finished`, summary);
          return;
        }
        tool.thread = e.branch;
        tool.status = "ok";
        tool.result = { text: `${summary}${n > 0 ? `\n\n${plural(n, "file")} merged` : ""}`, truncated: false };
        return;
      }
      case "fork_merge": {
        const summary = await this.#text(e.summary);
        const n = e.files.changed.length + e.files.added.length;
        const kept = e.files.discarded.length;
        this.#notice(
          e,
          commit,
          "merge",
          kept > 0 ? "warning" : "info",
          `Merged ${e.branch}: ${plural(n, "file")}${kept > 0 ? `, ${kept} left as they were` : ""}`,
          summary,
        );
        const tool = e.call_id === undefined ? undefined : this.#tool(e.call_id);
        if (tool !== undefined) {
          tool.status = "ok";
          tool.thread = e.branch;
        }
        return;
      }
      case "job_event":
        this.#notice(
          e,
          commit,
          "job",
          e.status === "failed" ? "error" : e.status === "completed" ? "info" : "warning",
          `Job ${e.job} ${e.status}`,
          await this.#text(e.summary),
        );
        return;
    }
  }
}

/**
 * The blocks for a branch's entries, oldest first. A call with no result is `awaiting_approval` or `running` when `state`
 * says so, `did_not_run` when it was declined or cut off, and `pending` otherwise.
 */
export async function mapEntries(items: readonly MapItem[], env: MapEnv, state: MapState = {}): Promise<Block[]> {
  const m = new Mapper(env, state);
  for (const [i, item] of items.entries()) await m.add(item, i);
  m.endTurn();
  return m.out;
}
