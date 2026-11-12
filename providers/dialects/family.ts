import type { Block, Turn } from "../../harness/context-builder.ts";
import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect, Emit, Parser, RenderInput } from "../dialect.ts";
import { argNode } from "./schema-tree.ts";
import { coerce, nextMarker, safeLength, spacedJson, Trimmer } from "./scan.ts";

/**
 * Template families: a dialect written as a declaration. Most chat formats are the same machine with different tokens: turns in
 * role markers, the tool list somewhere in the system part, calls between begin and end markers, results in a role or a wrapper,
 * thinking between tags. A `FamilySpec` says which tokens, and `defineFamily` makes the renderer and the streaming parser. What
 * does not fit a declaration (Harmony's channels, Gemma's quoting) stays a hand-written dialect.
 *
 * The one thing every family differs in most is how a call's body is written, so that is a small codec of its own: `tagParams` (a
 * tag per argument), `jsonCall` (one JSON object that names the tool) and `nameThenJson` (the name, a separator, the arguments as
 * JSON). Options every family takes: `thinking` (default true: the model may think; false asks it not to, where the format has a
 * way) and `keep_reasoning` (default true: the reasoning of the unfinished exchange is replayed, as the templates do; earlier
 * exchanges never are). A family adds its own in `head`.
 */

type Tools = readonly ToolDefinition[];
type Args = Record<string, unknown>;

export interface Wrap {
  open: string;
  close: string;
}

/** A call read back from the model's text: the arguments parsed, or only their text (the assembler reads it as JSON, else keeps it). */
export type Read = { name: string; args: Args } | { name: string; raw: string };

/** How one call's body (between its markers) is written and read. */
export interface CallCodec {
  /** `raw` is the text the model wrote for a call it got wrong, written back as it was where the format allows. */
  write(call: { name: string; id: string; args: Args; raw?: string }): string;
  read(body: string, tools: Tools): Read | undefined;
  /** The name, as soon as enough of the body has arrived to say. */
  peek(partial: string): string | undefined;
  /** Whether a body that was cut off is whole anyway (the arguments are all there). */
  complete?(body: string): boolean;
}

export interface FamilySpec {
  id: string;
  /** What the prompt starts with: the system text and the tool list, in the family's way. `options` are the dialect's options. */
  head(h: { system: string; tools: Tools; options: Record<string, unknown> }): string;
  user: Wrap;
  assistant: Wrap & {
    /** Written before the text of an answer (when there is any). */
    lead?: string;
  };
  /** Tool results: `item` has `{content}`, `{id}` (the call's id) and `{name}` (its tool) in it; `open` and `close` wrap a run of them. */
  results: {
    open?: string;
    close?: string;
    item: string;
    /** The model carries on straight after the results, with no turn marker of its own (DeepSeek). */
    continues?: true;
  };
  call: {
    start: string;
    /** Without one, a call ends at the next `start`, at the end of a section, or when the model stops (Mistral). */
    end?: string;
    /** Markers around all the calls of a turn: written, and left out of the text when read. */
    section?: Wrap;
    /** Written between the text and the first call (when there is text; `gapEmpty` when there is none), and between calls. */
    gap?: string;
    gapEmpty?: string;
    between?: string;
    /** The id a call is given when written into history, and that its result is answered with. Default: the call's own. */
    id?: (name: string, n: number) => string;
    codec: CallCodec;
  };
  think?: {
    /** The tags; the parser reads what is between them as reasoning, wherever they come. */
    open: string;
    close: string;
    /** What the prompt ends with to ask the model to think, and not to (the empty block). */
    start?: string;
    skip?: string;
    /** What stands where an exchange's reasoning is not replayed. */
    absent?: string;
    /** Replay a think block (empty if there is no reasoning) for the unfinished exchange; otherwise only when it has reasoning. */
    emptyBlock?: true;
    /** The family never replays reasoning. */
    never?: true;
    /** `thinking: true` is the default; a family whose calls only work without thinking sets false. */
    default?: boolean;
  };
  stop?: string[];
}

/** `{name}` placeholders filled in. */
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

// ---- call codecs ------------------------------------------------------------------------------------------------------

const NAME = "[\\w.:-]+";
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A template with `{name}`, `{key}` and `{value}` in it, as a pattern. A newline in it may be missing (one is dropped from each side of a
 * value), except one straight after a name: there it, or a tag straight after the name, is what says the name is complete.
 */
function pattern(template: string, flags = ""): RegExp {
  const parts = template.split(/(\{name\}|\{key\}|\{value\})/);
  const src = parts
    .map((p, i) => {
      if (p === "{name}" || p === "{key}") return `(${NAME})`;
      if (p === "{value}") return "([\\s\\S]*?)";
      const afterName = parts[i - 1] === "{name}" && /^\n*$/.test(p);
      // The newline that ends a name may be missing when a tag follows straight away (GLM-4.7 writes `read<arg_key>`).
      return afterName ? "(?:\\n|(?=<))" : esc(p).replace(/\n/g, "\\n?");
    })
    .join("");
  return new RegExp(src, flags);
}

const jsonOf = (v: unknown): string => spacedJson(v);
const argText = (v: unknown): string => (typeof v === "string" ? v : jsonOf(v));

/**
 * A tag for each argument. `head` opens the call and has the name in it, `param` is one argument (with `{key}` and `{value}`), `tail`
 * closes it; strings are written as they are and anything else as JSON, and read back as the schema says. The same body is read
 * wherever it is, so whitespace around the tags does not matter.
 */
export function tagParams(t: { head: string; param: string; tail?: string }): CallCodec {
  const head = pattern(t.head);
  const param = pattern(t.param, "g");
  const tail = (t.tail ?? "").trim();
  return {
    write: (c) => `${fill(t.head, { name: c.name })}${Object.entries(c.args).map(([k, v]) => fill(t.param, { key: k }).replace("{value}", () => argText(v))).join("")}${t.tail ?? ""}`,
    peek: (partial) => head.exec(partial)?.[1],
    read(body, tools) {
      const h = head.exec(body);
      if (h === null) return undefined;
      const name = h[1] as string;
      const args: Args = {};
      for (const m of body.slice(h.index + h[0].length).matchAll(param)) args[m[1] as string] = coerce(m[2] as string, argNode(tools, name, m[1] as string));
      return { name, args };
    },
    ...(tail === "" ? {} : { complete: (body: string) => body.includes(tail) }),
  };
}

/** `{"name": ..., "arguments": {...}}` (or `parameters`, as Llama writes it); the arguments may be a JSON string. */
export function jsonCall(t: { lead?: string; trail?: string } = {}): CallCodec {
  return {
    write: (c) => `${t.lead ?? ""}{"name": ${JSON.stringify(c.name)}, "arguments": ${c.raw ?? jsonOf(c.args)}}${t.trail ?? ""}`,
    peek: (partial) => /"name"\s*:\s*"([^"]+)"/.exec(partial)?.[1],
    read(body) {
      try {
        const j = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown; parameters?: unknown };
        const a = j.arguments ?? j.parameters;
        const args = typeof a === "string" ? (JSON.parse(a) as unknown) : a;
        if (typeof j.name === "string" && typeof args === "object" && args !== null && !Array.isArray(args)) return { name: j.name, args: args as Args };
      } catch {
        /* not JSON */
      }
      return undefined;
    },
  };
}

/** `NAME{sep}{JSON}`. `name` writes the name part from the call (an id, for Kimi) and `nameOf` reads it back. */
export function nameThenJson(t: { sep: string; name?: (c: { name: string; id: string }) => string; nameOf?: (text: string) => string }): CallCodec {
  const nameOf = t.nameOf ?? ((s: string) => s.trim());
  return {
    write: (c) => `${t.name === undefined ? c.name : t.name(c)}${t.sep}${c.raw ?? jsonOf(c.args)}`,
    peek(partial) {
      const i = partial.indexOf(t.sep);
      return i < 0 ? undefined : nameOf(partial.slice(0, i));
    },
    read(body) {
      const i = body.indexOf(t.sep);
      if (i < 0) return undefined;
      const name = nameOf(body.slice(0, i));
      const raw = body.slice(i + t.sep.length);
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { name, args: parsed as Args };
      } catch {
        /* the assembler keeps it as text */
      }
      return { name, raw };
    },
    complete: () => true,
  };
}

/** The first codec that can read a body reads it; the first one writes. */
export function anyOf(...codecs: [CallCodec, ...CallCodec[]]): CallCodec {
  return {
    write: (c) => codecs[0].write(c),
    peek: (p) => codecs.map((x) => x.peek(p)).find((n) => n !== undefined),
    read: (b, tools) => codecs.map((x) => x.read(b, tools)).find((r) => r !== undefined),
    ...(codecs[0].complete === undefined ? {} : { complete: codecs[0].complete }),
  };
}

// ---- rendering ----------------------------------------------------------------------------------------------------

export function renderFamily(spec: FamilySpec, input: RenderInput): { prompt: string; stop: string[] } {
  const { context, options } = input;
  const keep = options["keep_reasoning"] !== false;
  const thinking = options["thinking"] === undefined ? spec.think?.default !== false : options["thinking"] !== false;
  const system = [context.system, context.instructions ?? ""].filter((x) => x !== "").join("\n\n").trim();
  let out = spec.head({ system, tools: context.tools, options });
  const turns = context.turns;
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  const ids = new Map<string, { id: string; name: string }>();
  let n = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i] as Turn;
    if (t.role === "user") {
      out += `${spec.user.open}${t.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n").trim()}${spec.user.close}`;
    } else if (t.role === "tool_results") {
      const items = t.results.map((r) => fill(spec.results.item, { content: r.content, id: ids.get(r.call_id)?.id ?? r.call_id, name: ids.get(r.call_id)?.name ?? "" }));
      out += `${spec.results.open ?? ""}${items.join("")}${spec.results.close ?? ""}`;
    } else {
      const blocks = t.blocks as Block[];
      const content = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      const own = t.provider === input.provider && t.model.split("@")[0] === input.model.split("@")[0];
      const reasoning = keep && own ? blocks.flatMap((b) => (b.type === "reasoning" && b.visible !== undefined ? [b.visible] : [])).join("\n").trim() : "";
      const calls = blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      const continued = spec.results.continues === true && turns[i - 1]?.role === "tool_results";
      if (!continued) {
        out += spec.assistant.open;
        const th = spec.think;
        if (th !== undefined) {
          const replay = th.never !== true && i > lastUser && (reasoning !== "" || th.emptyBlock === true);
          out += replay ? `${th.open}${reasoning}${th.close}` : (th.absent ?? "");
        }
      }
      if (content !== "") out += `${spec.assistant.lead ?? ""}${content}`;
      if (calls.length > 0) {
        const c = spec.call;
        out += content !== "" ? (c.gap ?? "") : (c.gapEmpty ?? c.gap ?? "");
        out += c.section?.open ?? "";
        out += calls
          .map((b) => {
            const id = c.id === undefined ? b.call_id : c.id(b.name, n++);
            ids.set(b.call_id, { id, name: b.name });
            return `${c.start}${c.codec.write({ name: b.name, id, args: b.args, ...(b.args_raw === undefined ? {} : { raw: b.args_raw }) })}${c.end ?? ""}`;
          })
          .join(c.between ?? "");
        out += c.section?.close ?? "";
      }
      out += spec.assistant.close;
    }
  }
  const resumed = spec.results.continues === true && turns[turns.length - 1]?.role === "tool_results";
  const th = spec.think;
  out += resumed ? "" : `${spec.assistant.open}${th === undefined ? "" : thinking ? (th.start ?? "") : (th.skip ?? "")}`;
  return { prompt: out, stop: spec.stop ?? [] };
}

// ---- reading ------------------------------------------------------------------------------------------------------

type Mode = "reasoning" | "text" | "call";

export function familyParser(spec: FamilySpec, tools: Tools, prompt: string): Parser {
  const c = spec.call;
  const open = spec.think?.open.trim();
  const close = spec.think?.close.trim();
  const ignored = [c.section?.open, c.section?.close].flatMap((m) => (m === undefined || m.trim() === "" ? [] : [m.trim()]));
  const textMarks = [c.start, ...ignored, ...(open === undefined || open === "" ? [] : [open])];
  const reasoningMarks = close === undefined || close === "" ? [] : [close];
  const callMarks = c.end !== undefined ? [c.end] : [c.start, ...ignored];
  let mode: Mode = open !== undefined && open !== "" && prompt.trimEnd().endsWith(open) ? "reasoning" : "text";
  let buf = "";
  let call = "";
  let started = false;
  const trim = new Trimmer();

  const finish = (out: Emit[]): void => {
    const read = c.codec.read(call, tools);
    if (read === undefined) {
      if (started) out.push({ kind: "call.end", raw: call });
      else out.push({ kind: "text", text: `${c.start}${call}${c.end ?? ""}` });
    } else {
      if (!started) out.push({ kind: "call.start", name: read.name });
      out.push({ kind: "call.end", ...("args" in read ? { args: read.args } : { raw: read.raw }) });
    }
    started = false;
    call = "";
  };

  const run = (final: boolean): Emit[] => {
    const out: Emit[] = [];
    const body = (text: string): void => {
      const t = trim.push(text);
      if (t !== "") out.push({ kind: mode === "reasoning" ? "reasoning" : "text", text: t });
    };
    for (;;) {
      if (mode === "call") {
        const m = nextMarker(buf, callMarks);
        if (m === undefined) {
          const n = final ? buf.length : safeLength(buf, callMarks);
          call += buf.slice(0, n);
          buf = buf.slice(n);
          if (!started) {
            const name = c.codec.peek(call);
            if (name !== undefined) {
              started = true;
              out.push({ kind: "call.start", name });
            }
          }
          return out;
        }
        call += buf.slice(0, m.at);
        buf = buf.slice(m.at + m.marker.length);
        finish(out);
        // Without an end marker, the start of the next call ends this one and opens that one.
        mode = m.marker === c.start ? "call" : "text";
        trim.reset();
        continue;
      }
      const marks = mode === "reasoning" ? reasoningMarks : textMarks;
      const m = nextMarker(buf, marks);
      if (m === undefined) {
        const n = final ? buf.length : safeLength(buf, marks);
        body(buf.slice(0, n));
        buf = buf.slice(n);
        return out;
      }
      body(buf.slice(0, m.at));
      buf = buf.slice(m.at + m.marker.length);
      trim.reset();
      mode = m.marker === c.start ? "call" : m.marker === open ? "reasoning" : "text";
      if (mode === "call") {
        call = "";
        started = false;
      }
    }
  };

  return {
    push(text) {
      buf += text;
      return run(false);
    },
    end() {
      const out = run(true);
      if (mode === "call") {
        if (c.end === undefined) {
          if (call.trim() !== "" || started) finish(out);
        } else if (started) {
          // Cut off inside a call: the arguments that are complete are kept if the call is whole, and the text is kept for the model to see either way.
          const read = c.codec.read(call, tools);
          out.push(read !== undefined && "args" in read && c.codec.complete?.(call) === true ? { kind: "call.end", args: read.args } : { kind: "call.end", raw: call });
        } else if (call !== "") out.push({ kind: "text", text: `${c.start}${call}` });
      }
      mode = "text";
      return out;
    },
  };
}

/** A dialect from its declaration. */
export function defineFamily(spec: FamilySpec): Dialect {
  return { id: spec.id, render: (input) => renderFamily(spec, input), parser: (_options, tools, prompt) => familyParser(spec, tools, prompt) };
}
