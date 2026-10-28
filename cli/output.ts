import type { Appended, Conversation } from "../harness/conversation.ts";
import type { ChatEntry } from "../harness/entries.ts";
import { inlineBlobs } from "../harness/context-builder.ts";
import { resultLines, summarizeCall } from "./tool-lines.ts";

/**
 * What the engine says. Nothing here knows about terminals: a renderer turns outputs into text for a plain stream or a
 * tty, and tests read them directly.
 */
export type Output =
  /** The result of a command: goes to standard output. */
  | { type: "text"; text: string }
  /** A line of information about what is happening (a price pinned, a thread opened). */
  | { type: "notice"; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; hint?: string }
  /** An entry from the transcript, as in `/history`. */
  | { type: "entry"; value: ChatEntry; entry?: Appended }
  /** A request is starting, streaming, or over. */
  | { type: "clear" }
  | { type: "request_start"; model: string }
  | { type: "stream"; kind: "text" | "reasoning"; text: string }
  /** A tool call the model made, as the loop starts it. */
  | { type: "tool_start"; callId: string; name: string; summary: string }
  | { type: "tool_result"; callId: string; name: string; is_error: boolean; content: string; ms: number; truncated: boolean }
  /** A background job's event was committed. */
  | { type: "job_event"; job: string; status: string; summary: string }
  | { type: "request_end"; status: "completed" | "interrupted" | "cancelled"; usage?: { input: number; output: number; cached: number }; turnUsd?: number; threadUsd?: number; unpriced?: boolean; stopReason?: string };

export type Thinking = "off" | "brief" | "on";
/** How much of the tool calls and results is shown: none, a line each with a short preview, or everything. */
export type ToolView = "off" | "brief" | "full";
/** What earlier assistant entries asked for, by call id, so a result can say what it answers. */
export type CallMap = Map<string, { name: string; args: Record<string, unknown> }>;

const textOf = async (convo: Conversation, t: string | { sha256: string; bytes: number }): Promise<string> => {
  if (typeof t === "string") return t;
  const bytes = await convo.store.get(t.sha256);
  return bytes === undefined ? `(missing text, ${t.bytes} bytes)` : new TextDecoder().decode(bytes);
};

const clip = (s: string, n: number | undefined): string => (n === undefined || s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more characters)`);
const indent = (s: string, by = "  "): string => s.split("\n").map((l) => (l === "" ? l : by + l)).join("\n");

/** One transcript entry as plain text. `max` clips long texts (the full entry is `/show`). */
export async function formatEntry(convo: Conversation, e: ChatEntry, opts: { thinking?: Thinking; tools?: ToolView; max?: number; calls?: CallMap } = {}): Promise<string | undefined> {
  const thinking = opts.thinking ?? "off";
  const tools = opts.tools ?? "brief";
  const t = (x: string | { sha256: string; bytes: number }): Promise<string> => textOf(convo, x).then((s) => clip(s, opts.max));
  switch (e.$tag) {
    case "header":
      return undefined;
    case "user": {
      const lines: string[] = [];
      for (const p of e.content) {
        if (p.$tag === "text") lines.push(await t(p.text));
        else lines.push(`[attached ${p.name ?? p.data.sha256.slice(0, 8)}: ${p.data.mime ?? "unknown type"}, ${p.data.bytes} bytes]`);
      }
      return `you:\n${indent(lines.join("\n"))}`;
    }
    case "assistant": {
      const parts: string[] = [];
      for (const b of e.blocks) {
        if (b.$tag === "text") parts.push(await t(b.text));
        else if (b.$tag === "reasoning" && thinking !== "off" && b.visible !== undefined && b.visible !== "") {
          const visible = await t(b.visible);
          parts.push(`(thinking) ${thinking === "brief" ? clip(visible, 200) : visible}`);
        } else if (b.$tag === "tool_call") {
          const args = (await inlineBlobs(b.args, t)) as Record<string, unknown>;
          opts.calls?.set(b.call_id, { name: b.name, args });
          if (tools === "brief") parts.push(`→ ${summarizeCall(b.name, args)}`);
          else if (tools === "full") parts.push(`→ ${summarizeCall(b.name, args)}\n${indent(JSON.stringify(args, null, 2), "    ")}`);
        }
      }
      return parts.length === 0 ? undefined : `${e.model}:\n${indent(parts.join("\n"))}`;
    }
    case "tool_result": {
      if (tools === "off") return undefined;
      const content = await textOf(convo, e.content);
      const r = resultLines({ is_error: e.is_error, content, truncated: e.truncated === true });
      if (tools === "full") return `  ← ${r.head}\n${indent(clip(content, opts.max), "    ")}`;
      return `  ← ${r.head}${r.preview.map((l) => `\n    ${l}`).join("")}${r.more ? "\n    …" : ""}`;
    }
    case "interrupted": {
      const parts: string[] = [];
      for (const b of e.partial) if (b.$tag === "text") parts.push(await t(b.text));
      return `[reply interrupted ${e.by === "user" ? "by you" : `by an error${e.error === undefined ? "" : `: ${e.error}`}`}]${parts.length > 0 ? `\n${indent(parts.join("\n"))}` : ""}`;
    }
    case "agent_setup": {
      const what = [e.model === undefined ? "" : `model ${e.model.provider}/${e.model.id}`, e.instructions === undefined ? "" : "instructions", e.pricing === undefined ? "" : "prices pinned", e.renderer === undefined ? "" : `renderer ${e.renderer}`].filter((x) => x !== "");
      return `[setup changed (${e.reason}): ${what.join(", ") || "tools or definitions"}]`;
    }
    case "compaction":
      return `[earlier messages summarised]\n${indent(await t(e.summary))}`;
    case "branch_start":
      return `[thread started${e.kind === "fork" ? " as a fork" : ` as a ${e.kind}`} of ${e.from.branch}]`;
    case "fork_merge":
      return `[a fork was merged back]\n${indent(await t(e.summary))}`;
    case "subagent_result":
      return `[subagent ${e.branch} finished]\n${indent(await t(e.summary))}`;
    case "job_event":
      return `[background job ${e.job} ${e.status}] ${await t(e.summary)}${e.output === undefined ? "" : `\n${indent(clip(await t(e.output), 400))}`}`;
  }
}

/** A run of entries as text, one block per shown entry, with tool results knowing which call they answer. */
export async function formatTranscript(convo: Conversation, entries: readonly ChatEntry[], opts: { thinking?: Thinking; tools?: ToolView; max?: number } = {}): Promise<string[]> {
  const calls: CallMap = new Map();
  const out: string[] = [];
  for (const e of entries) {
    const t = await formatEntry(convo, e, { ...opts, calls });
    if (t !== undefined) out.push(t);
  }
  return out;
}

/** What a renderer does with outputs: plain text for pipes and tests. */
export interface PlainSink {
  out(text: string): void;
  err(text: string): void;
  /** Clear the screen (a terminal sink does; plain output has nothing to clear). */
  clear?(): void;
}

/** How a renderer marks up what it says: plain text by default, ANSI colours on a terminal. */
export interface Style {
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
}
export const plainStyle: Style = { dim: (s) => s, red: (s) => s, yellow: (s) => s };
export const ansiStyle: Style = { dim: (s) => `\x1b[2m${s}\x1b[22m`, red: (s) => `\x1b[31m${s}\x1b[39m`, yellow: (s) => `\x1b[33m${s}\x1b[39m` };

export class PlainRenderer {
  readonly #sink: PlainSink;
  readonly #convo: () => Conversation;
  readonly thinking: Thinking;
  readonly tools: ToolView;
  readonly #calls: CallMap = new Map();
  readonly #style: Style;
  #open: "text" | "reasoning" | undefined;
  #atLineStart = true;

  constructor(sink: PlainSink, convo: () => Conversation, thinking: Thinking = "off", style: Style = plainStyle, tools: ToolView = "brief") {
    this.tools = tools;
    this.#style = style;
    this.#sink = sink;
    this.#convo = convo;
    this.thinking = thinking;
  }

  async render(o: Output): Promise<void> {
    switch (o.type) {
      case "text":
        this.#flush();
        this.#sink.out(o.text.endsWith("\n") ? o.text : `${o.text}\n`);
        return;
      case "notice":
        this.#flush();
        this.#sink.err(`${this.#style.dim(o.message)}\n`);
        return;
      case "warning":
        this.#flush();
        this.#sink.err(`${this.#style.yellow(`warning: ${o.message}`)}\n`);
        return;
      case "error":
        this.#flush();
        this.#sink.err(`${this.#style.red(`error: ${o.message}`)}\n${o.hint === undefined ? "" : `${this.#style.dim(`  ${o.hint}`)}\n`}`);
        return;
      case "entry": {
        this.#flush();
        const text = await formatEntry(this.#convo(), o.value, { thinking: this.thinking, tools: this.tools, max: 600, calls: this.#calls });
        if (text !== undefined) this.#sink.out(`${text}\n`);
        return;
      }
      case "clear":
        this.#flush();
        this.#sink.clear?.();
        return;
      case "request_start":
        return;
      case "tool_start":
        if (this.tools === "off") return;
        this.#flush();
        this.#sink.err(`${this.#style.dim(`→ ${o.summary}`)}\n`);
        return;
      case "tool_result": {
        if (this.tools === "off") return;
        this.#flush();
        const r = resultLines(o);
        const paint = o.is_error ? this.#style.red : this.#style.dim;
        if (this.tools === "full") {
          this.#sink.err(`${paint(`  ← ${r.head}`)}\n${this.#style.dim(o.content.split("\n").map((l) => `    ${l}`).join("\n"))}\n`);
          return;
        }
        this.#sink.err(`${paint(`  ← ${r.head}`)}\n${r.preview.map((l) => `${this.#style.dim(`    ${l}`)}\n`).join("")}${r.more ? `${this.#style.dim("    … /expand shows all of it")}\n` : ""}`);
        return;
      }
      case "job_event":
        this.#flush();
        this.#sink.err(`${this.#style.dim(`[job ${o.job} ${o.status}] ${o.summary}`)}\n`);
        return;
      case "stream":
        if (o.kind === "reasoning") {
          if (this.thinking === "off") return;
          if (this.#open !== "reasoning") this.#sink.err(this.#style.dim(this.#atLineStart ? "(thinking) " : "\n(thinking) "));
          this.#open = "reasoning";
          this.#sink.err(this.#style.dim(o.text));
          return;
        }
        if (this.#open === "reasoning") this.#sink.err("\n");
        this.#open = "text";
        this.#sink.out(o.text);
        this.#atLineStart = o.text.endsWith("\n");
        return;
      case "request_end": {
        if (this.#open === "text" && !this.#atLineStart) this.#sink.out("\n");
        this.#open = undefined;
        this.#atLineStart = true;
        const bits: string[] = [];
        if (o.status !== "completed") bits.push(o.status);
        if (o.usage !== undefined) bits.push(`${o.usage.input} in${o.usage.cached > 0 ? ` (${o.usage.cached} cached)` : ""}, ${o.usage.output} out`);
        if (o.turnUsd !== undefined) bits.push(`turn $${o.turnUsd.toFixed(4)}`);
        if (o.threadUsd !== undefined) bits.push(`thread $${o.threadUsd.toFixed(4)}${o.unpriced === true ? "+" : ""}`);
        if (bits.length > 0) this.#sink.err(`${this.#style.dim(`[${bits.join(" · ")}]`)}\n`);
        return;
      }
    }
  }

  #flush(): void {
    if (this.#open === "text" && !this.#atLineStart) this.#sink.out("\n");
    if (this.#open === "reasoning") this.#sink.err("\n");
    this.#open = undefined;
    this.#atLineStart = true;
  }
}
