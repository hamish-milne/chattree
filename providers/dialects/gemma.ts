import type { AttachmentPart, Block, Turn } from "../../harness/context-builder.ts";
import type { Dialect, Emit, Parser, RenderInput, Rendered } from "../dialect.ts";
import { resultContent, userContent } from "./media.ts";
import { nextMarker, safeLength, Trimmer } from "./scan.ts";
import { argNode, concreteTypes, isNullable, parseSchema, type SchemaNode } from "./schema-tree.ts";

/**
 * The format of Gemma 4: roles `user` and `model` in `<|turn>…<turn|>`, tools declared in the system turn in a compact notation with
 * `<|"|>` as the string quote, calls as `<|tool_call>call:NAME{key:value,…}<tool_call|>` and their results as
 * `<|tool_response>response:NAME{value:…}<tool_response|>` inside the same model turn, thinking in `<|channel>thought\n…<channel|>`.
 * Rendering reproduces the model's own template (parity tests); it departs from it in:
 *   G1  text written before a call stays before it (the template moves it after the results);
 *   G2  an object with no declared properties is declared without any (the template would list its other keys as properties);
 *   G3  an array's `items` is described exactly as a property is, at any depth, and keywords the format has no word for are left out (the
 *       template copies every key of `items` as written: `additionalProperties`, `pattern`, ... with nested types in lower case).
 * The start-of-sequence token is left to the server. Options: `thinking` (default true: `<|think|>` in the system turn);
 * `keep_reasoning` (default true): reasoning of the unfinished exchange is replayed.
 */

const Q = '<|"|>';
type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
/** Jinja's `dictsort`: by key, ignoring case. */
const sorted = (o: Schema): [string, unknown][] => Object.entries(o).sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0));
const upper = (v: unknown): string => String(v).toUpperCase();

/** A value in the format's notation. `escapeKeys` quotes the keys of objects. */
export function gemmaValue(v: unknown, escapeKeys: boolean): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return `${Q}${v}${Q}`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[${v.map((x) => gemmaValue(x, escapeKeys)).join(",")}]`;
  if (isMap(v)) return `{${sorted(v).map(([k, x]) => `${escapeKeys ? `${Q}${k}${Q}` : k}:${gemmaValue(x, escapeKeys)}`).join(",")}}`;
  return String(v);
}

const list = (xs: unknown[]): string => `[${xs.map((x) => `${Q}${String(x)}${Q}`).join(",")}]`;
/** The type as the format names it: the first one that is not null, in capitals; undefined when the schema names none. */
const typeName = (n: SchemaNode): string | undefined => {
  const t = concreteTypes(n)[0] ?? (n.types.length > 0 ? "null" : undefined);
  return t === undefined ? undefined : upper(t);
};

/**
 * What the format says of one schema, between the braces: the parts it knows, in its (alphabetical) order. The same for a property and for
 * the `items` of an array, at any depth, so nested arrays and objects read alike. Keywords the format has no word for (`pattern`, `minimum`,
 * `additionalProperties`, ...) are left out rather than passed through: the model was not taught them, and the schema projection already
 * puts the constraints that matter into the description.
 */
function describe(n: SchemaNode): string {
  const type = typeName(n);
  const parts: string[] = [];
  if (n.description !== undefined && n.description !== "") parts.push(`description:${Q}${n.description}${Q}`);
  if (n.enum !== undefined && n.enum.length > 0) parts.push(`enum:${gemmaValue(n.enum, true)}`);
  if (n.items !== undefined && (n.items.types.length > 0 || n.items.properties !== undefined || n.items.description !== undefined || n.items.enum !== undefined)) parts.push(`items:{${describe(n.items)}}`);
  if (isNullable(n)) parts.push("nullable:true");
  if (type === "OBJECT") {
    if (n.properties !== undefined) parts.push(`properties:{${properties(n.properties)}}`);
    if (n.required.length > 0) parts.push(`required:${list(n.required)}`);
  }
  if (type !== undefined) parts.push(`type:${Q}${type}${Q}`);
  return parts.join(",");
}

function properties(props: [string, SchemaNode][]): string {
  return props
    .slice()
    .sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([key, n]) => `${key}:{${describe(n)}}`)
    .join(",");
}

function declaration(t: { name: string; description: string; input_schema: Schema }): string {
  let out = `declaration:${t.name}{description:${Q}${t.description}${Q}`;
  const p = parseSchema(t.input_schema);
  if (Object.keys(t.input_schema).length > 0) {
    out += ",parameters:{";
    if (p.properties !== undefined && p.properties.length > 0) out += `properties:{${properties(p.properties)}},`;
    if (p.required.length > 0) out += `required:${list(p.required)},`;
    if (p.types.length > 0) out += `type:${Q}${upper(p.types[0])}${Q}}`;
  }
  return `${out}}`;
}

const response = (name: string, content: string): string => `<|tool_response>response:${name}{value:${Q}${content}${Q}}<tool_response|>`;

export function renderGemma(input: RenderInput): { prompt: string; stop: string[] } {
  const keep = input.options["keep_reasoning"] !== false;
  const thinking = input.options["thinking"] !== false;
  const { context } = input;
  const system = [context.system, context.instructions ?? ""].filter((x) => x !== "").join("\n\n").trim();
  let out = "";
  if (thinking || context.tools.length > 0 || system !== "") {
    out += `<|turn>system\n${thinking ? "<|think|>\n" : ""}${system}${context.tools.map((t) => `<|tool>${declaration(t)}<tool|>`).join("")}<turn|>\n`;
  }
  const turns = context.turns;
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  const media: AttachmentPart[] = [];
  let open = false; // inside a model turn
  let openAfterResponse = false;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i] as Turn;
    if (t.role === "user") {
      out += `<|turn>user\n${userContent(t.parts, input.marker, media)}<turn|>\n`;
      open = false;
    } else if (t.role === "assistant") {
      if (!open) out += "<|turn>model\n";
      open = true;
      const blocks = t.blocks as Block[];
      const own = t.provider === input.provider && t.model.split("@")[0] === input.model.split("@")[0];
      const reasoning = keep && own && i > lastUser ? blocks.flatMap((b) => (b.type === "reasoning" && b.visible !== undefined ? [b.visible] : [])).join("\n").trim() : "";
      if (reasoning !== "") out += `<|channel>thought\n${reasoning}\n<channel|>`;
      const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      out += text;
      const calls = blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      for (const c of calls) {
        const raw = c.args_raw?.trim();
        const args = raw !== undefined ? (raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1) : raw) : sorted(c.args).map(([k, v]) => `${k}:${gemmaValue(v, false)}`).join(",");
        out += `<|tool_call>call:${c.name}{${args}}<tool_call|>`;
      }
      const next = turns[i + 1];
      const results = new Map((next?.role === "tool_results" ? next.results : []).map((r) => [r.call_id, r]));
      let answered = false;
      for (const c of calls) {
        const r = results.get(c.call_id);
        if (r !== undefined) {
          out += response(c.name, resultContent(r, input.marker, media));
          answered = true;
        }
      }
      const nextNonTool = turns.slice(i + 1).find((x) => x.role !== "tool_results");
      if (nextNonTool?.role === "assistant" && (calls.length === 0 || answered)) {
        openAfterResponse = false; // the turn goes on
      } else if (answered && text === "" && nextNonTool === undefined) {
        openAfterResponse = true; // the model's turn is still open, waiting for it to carry on
      } else {
        out += "<turn|>\n";
        open = false;
        openAfterResponse = false;
      }
    }
  }
  if (open && openAfterResponse) out += thinking ? "<|channel>thought\n" : "";
  else if (!open) out += `<|turn>model\n${thinking ? "" : "<|channel>thought\n<channel|>"}`;
  return { prompt: out, stop: ["<turn|>", "<|tool_response>"], ...(media.length === 0 ? {} : { media }) };
}

// ---- parsing ----------------------------------------------------------------------------------------------------

/** Reads the arguments of a call, `key:value,key:value`, with `<|"|>` as the string quote. Returns undefined if the text is not in that notation. */
export function parseGemmaArgs(text: string): Record<string, unknown> | undefined {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  const key = (): string | undefined => {
    ws();
    if (text.startsWith(Q, i)) {
      const end = text.indexOf(Q, i + Q.length);
      if (end < 0) return undefined;
      const k = text.slice(i + Q.length, end);
      i = end + Q.length;
      return k;
    }
    const m = /^[^\s:,{}[\]]+/.exec(text.slice(i));
    if (m === null) return undefined;
    i += m[0].length;
    return m[0];
  };
  const value = (): { v: unknown } | undefined => {
    ws();
    if (text.startsWith(Q, i)) {
      const end = text.indexOf(Q, i + Q.length);
      if (end < 0) return undefined;
      const s = text.slice(i + Q.length, end);
      i = end + Q.length;
      return { v: s };
    }
    if (text[i] === "[") {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { v: arr };
      }
      for (;;) {
        const x = value();
        if (x === undefined) return undefined;
        arr.push(x.v);
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return { v: arr };
        } else return undefined;
      }
    }
    if (text[i] === "{") {
      i++;
      const o = members("}");
      return o === undefined ? undefined : { v: o };
    }
    const m = /^[^\s,}\]]+/.exec(text.slice(i));
    if (m === null) return undefined;
    i += m[0].length;
    const w = m[0];
    if (w === "true") return { v: true };
    if (w === "false") return { v: false };
    if (w === "null") return { v: null };
    const n = Number(w);
    return { v: Number.isFinite(n) ? n : w };
  };
  const members = (close: string | undefined): Record<string, unknown> | undefined => {
    const o: Record<string, unknown> = {};
    ws();
    if (close !== undefined && text[i] === close) {
      i++;
      return o;
    }
    for (;;) {
      const k = key();
      if (k === undefined) return undefined;
      ws();
      if (text[i] !== ":") return undefined;
      i++;
      const v = value();
      if (v === undefined) return undefined;
      o[k] = v.v;
      ws();
      if (text[i] === ",") i++;
      else if (close === undefined ? i >= text.length : text[i] === close) {
        if (close !== undefined) i++;
        return o;
      } else return undefined;
    }
  };
  return text.trim() === "" ? {} : members(undefined);
}

type Mode = "reasoning" | "text" | "call";
const TEXT_MARKS = ["<|channel>", "<|tool_call>", "<turn|>", "<|tool_response>"];
const END_THOUGHT = ["<channel|>"];

export function gemmaParser(options: Record<string, unknown>, tools: Parameters<typeof argNode>[0], prompt: string): Parser {
  void options;
  let mode: Mode = prompt.endsWith("<|channel>thought\n") ? "reasoning" : "text";
  let buf = "";
  let call = "";
  let started = false;
  let done = false;
  let skipThought = false; // `thought\n` right after `<|channel>`
  const trim = new Trimmer();

  const run = (final: boolean): Emit[] => {
    const out: Emit[] = [];
    const body = (text: string): void => {
      const t = trim.push(text);
      if (t !== "") out.push({ kind: mode === "reasoning" ? "reasoning" : "text", text: t });
    };
    for (;;) {
      if (done) {
        buf = "";
        return out;
      }
      if (skipThought) {
        if (!final && "thought\n".startsWith(buf) && buf.length < 8) return out;
        buf = buf.replace(/^thought\n?/, "");
        skipThought = false;
      }
      if (mode === "call") {
        const end = buf.indexOf("<tool_call|>");
        if (end < 0) {
          const n = final ? buf.length : safeLength(buf, ["<tool_call|>"]);
          call += buf.slice(0, n);
          buf = buf.slice(n);
          if (!started) {
            const h = /^call:([^{\s]+)\{/.exec(call);
            if (h !== null) {
              started = true;
              out.push({ kind: "call.start", name: h[1] as string });
            }
          }
          return out;
        }
        call += buf.slice(0, end);
        buf = buf.slice(end + "<tool_call|>".length);
        finish(out);
        continue;
      }
      const marks = mode === "reasoning" ? END_THOUGHT : TEXT_MARKS;
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
      if (m.marker === "<channel|>") mode = "text";
      else if (m.marker === "<|channel>") {
        mode = "reasoning";
        skipThought = true;
      } else if (m.marker === "<|tool_call>") {
        mode = "call";
        call = "";
        started = false;
      } else done = true; // the turn is over, or the model is asking for a result it must not make up
    }
  };

  const finish = (out: Emit[]): void => {
    const h = /^call:([^{\s]+)\{([\s\S]*)\}$/.exec(call.trim());
    if (h === null) {
      if (started) out.push({ kind: "call.end", raw: call });
      else out.push({ kind: "text", text: `<|tool_call>${call}<tool_call|>` });
    } else {
      const name = h[1] as string;
      const args = parseGemmaArgs(h[2] as string);
      if (!started) out.push({ kind: "call.start", name });
      out.push(args === undefined ? { kind: "call.end", raw: h[2] as string } : { kind: "call.end", args });
    }
    mode = "text";
    started = false;
    call = "";
  };

  return {
    push(text) {
      buf += text;
      return run(false);
    },
    end() {
      const out = run(true);
      if (mode === "call") {
        if (started) out.push({ kind: "call.end", raw: call.replace(/^call:[^{]*\{/, "") });
        else if (call !== "") out.push({ kind: "text", text: `<|tool_call>${call}` });
      }
      mode = "text";
      return out;
    },
  };
}

export const gemma: Dialect = { id: "gemma", render: renderGemma, parser: (o, tools, prompt) => gemmaParser(o, tools, prompt) };
