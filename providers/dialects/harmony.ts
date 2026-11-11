import type { Block, Turn } from "../../harness/context-builder.ts";
import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect, Emit, Parser, RenderInput } from "../dialect.ts";

/**
 * Harmony, the format gpt-oss was trained on (docs/local-models.md, section 9.1). Rendering reproduces what the model's own chat
 * template produces for plain conversations (the parity tests compare against its output), and departs from it in four deliberate
 * ways, each a lever in the options or a documented fix:
 *   D1  a finished answer is always in the `final` channel, and the reasoning of finished exchanges is dropped (the template puts a
 *       message that has both reasoning and content in `analysis`, which teaches the model to answer there);
 *   D2  several calls in one assistant turn are rendered as call/result pairs in order (the template renders only the first);
 *   D3  nested object and array schemas are declared in full (the template says `any[]`); `schema: "flat"` restores that;
 *   D4  text written before a call (a preamble) is in the `commentary` channel, as the format's own guide has it.
 * Options: `keep_reasoning` (default true): reasoning of the unfinished exchange is replayed in `analysis`;
 * `schema`: `"full"` (default) or `"flat"`.
 */

const START = "<|start|>";
const END = "<|end|>";
const MESSAGE = "<|message|>";
const CALL = "<|call|>";
const RETURN = "<|return|>";
const CHANNEL = "<|channel|>";
const CONSTRAIN = "<|constrain|>";

export interface HarmonyOptions {
  keepReasoning: boolean;
  full: boolean;
}

export function harmonyOptions(o: Record<string, unknown>): HarmonyOptions {
  return { keepReasoning: o["keep_reasoning"] !== false, full: o["schema"] !== "flat" };
}

// ---- rendering --------------------------------------------------------------------------------------------------

type Schema = Record<string, unknown>;

/** JSON as the template writes it: a space after `,` and `:`. */
export function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  return JSON.stringify(v) ?? "null";
}

const comment = (text: string): string => text.split("\n").map((l) => `// ${l}`.trimEnd()).join("\n");

function typeOf(s: unknown, full: boolean): string {
  if (typeof s !== "object" || s === null) return "any";
  const sc = s as Schema;
  if (Array.isArray(sc["enum"])) return (sc["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in sc) return JSON.stringify(sc["const"]);
  const alt = sc["anyOf"] ?? sc["oneOf"];
  if (Array.isArray(alt)) return unique((alt as unknown[]).map((a) => typeOf(a, full))).join(" | ");
  const t = sc["type"];
  if (Array.isArray(t)) return unique((t as string[]).map((x) => typeOf({ ...sc, type: x }, full))).join(" | ");
  switch (t) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = sc["items"];
      const inner = typeOf(items, full);
      if (!full && inner !== "string" && inner !== "number" && inner !== "boolean") return "any[]";
      return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
    }
    case "object":
      return full && typeof sc["properties"] === "object" && sc["properties"] !== null ? `{\n${properties(sc, full)}\n}` : "object";
    default:
      return "any";
  }
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** The lines of an object's properties: a comment for each description, then `name?: type,`. */
function properties(s: Schema, full: boolean): string {
  const props = Object.entries((s["properties"] ?? {}) as Record<string, unknown>);
  const required = new Set(Array.isArray(s["required"]) ? (s["required"] as string[]) : []);
  return props
    .map(([name, p]) => {
      const desc = typeof p === "object" && p !== null && typeof (p as Schema)["description"] === "string" ? `${comment((p as Schema)["description"] as string)}\n` : "";
      return `${desc}${name}${required.has(name) ? "" : "?"}: ${typeOf(p, full)},`;
    })
    .join("\n");
}

function declaration(t: ToolDefinition, full: boolean): string {
  const desc = t.description === "" ? "" : `${comment(t.description)}\n`;
  const props = (t.input_schema["properties"] ?? {}) as Record<string, unknown>;
  if (Object.keys(props).length === 0) return `${desc}type ${t.name} = () => any;`;
  return `${desc}type ${t.name} = (_: {\n${properties(t.input_schema, full)}\n}) => any;`;
}

function systemBlock(input: RenderInput, hasTools: boolean): string {
  const effort = input.effort === "low" || input.effort === "high" ? input.effort : "medium";
  const lines = ["You are ChatGPT, a large language model trained by OpenAI.", "Knowledge cutoff: 2024-06", `Current date: ${input.date}`, "", `Reasoning: ${effort}`, "", "# Valid channels: analysis, commentary, final. Channel must be included for every message."];
  if (hasTools) lines.push("Calls to these tools must go to the commentary channel: 'functions'.");
  return `${START}system${MESSAGE}${lines.join("\n")}${END}`;
}

function developerBlock(input: RenderInput, o: HarmonyOptions): string {
  const parts: string[] = [];
  const instructions = [input.context.system, input.context.instructions ?? ""].filter((x) => x !== "").join("\n\n");
  if (instructions !== "") parts.push(`# Instructions\n\n${instructions}`);
  if (input.context.tools.length > 0) parts.push(`# Tools\n\n## functions\n\nnamespace functions {\n\n${input.context.tools.map((t) => declaration(t, o.full)).join("\n\n")}\n\n} // namespace functions`);
  return parts.length === 0 ? "" : `${START}developer${MESSAGE}${parts.join("\n\n")}${END}`;
}

const message = (channel: string, body: string, end = END): string => `${START}assistant${CHANNEL}${channel}${MESSAGE}${body}${end}`;

/** Whether reasoning that this turn wrote is replayed to this request's model. */
const sameModel = (t: Extract<Turn, { role: "assistant" }>, input: RenderInput): boolean => t.provider === input.provider && t.model.split("@")[0] === input.model.split("@")[0];

export function renderHarmony(input: RenderInput): { prompt: string; stop: string[] } {
  const o = harmonyOptions(input.options);
  const turns = input.context.turns;
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  let out = systemBlock(input, input.context.tools.length > 0) + developerBlock(input, o);
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i] as Turn;
    if (t.role === "user") {
      out += `${START}user${MESSAGE}${t.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n")}${END}`;
    } else if (t.role === "assistant") {
      const next = turns[i + 1];
      const results = new Map((next?.role === "tool_results" ? next.results : []).map((r) => [r.call_id, r]));
      const hasCalls = t.blocks.some((b) => b.type === "tool_call");
      const replay = o.keepReasoning && hasCalls && i > lastUser && sameModel(t, input);
      for (const b of t.blocks as Block[]) {
        if (b.type === "reasoning") {
          if (replay && b.visible !== undefined && b.visible !== "") out += message("analysis", b.visible);
        } else if (b.type === "text") {
          if (b.text !== "") out += message(hasCalls ? "commentary" : "final", b.text);
        } else if (b.type === "tool_call") {
          out += message(`commentary to=functions.${b.name} ${CONSTRAIN}json`, b.args_raw ?? spacedJson(b.args), CALL);
          const r = results.get(b.call_id);
          if (r !== undefined) out += `${START}functions.${b.name} to=assistant${CHANNEL}commentary${MESSAGE}${r.content}${END}`;
        }
      }
    }
    // A tool_results turn was written out with the calls it answers.
  }
  return { prompt: `${out}${START}assistant`, stop: [] };
}

// ---- parsing ----------------------------------------------------------------------------------------------------

const TOKEN = /^<\|[a-z_]+\|>/;
const TERMINATORS = new Set([END, CALL, RETURN, START]);

type Mode = "header" | "text" | "reasoning" | "call" | "done";

/**
 * Reads the model's output after `<|start|>assistant`: messages of `<|channel|>NAME[ to=RECIPIENT][ <|constrain|>json]<|message|>BODY`
 * ended by `<|end|>`, `<|call|>` or `<|return|>`. A message with a `functions.` recipient is a call whatever its channel (the model
 * sometimes calls from `analysis`); `analysis` is reasoning; everything else is text. Output that does not start like a message at all
 * is taken as plain text, so a model that ignores the format still answers.
 */
export function harmonyParser(): Parser {
  let buf = "";
  let mode: Mode = "header";
  let header = "";
  let args = "";
  let sawStart = false;

  const emitBody = (text: string, out: Emit[]): void => {
    if (text === "") return;
    if (mode === "call") {
      args += text;
      out.push({ kind: "call.args", delta: text });
    } else out.push({ kind: mode === "reasoning" ? "reasoning" : "text", text });
  };

  const closeMessage = (out: Emit[]): void => {
    if (mode === "call") out.push({ kind: "call.end", raw: args });
    args = "";
  };

  const openMessage = (h: string, out: Emit[]): void => {
    const recipient = /\bto=([^\s<]+)/.exec(h)?.[1];
    const channel = /<\|channel\|>([a-z]+)/.exec(h)?.[1];
    if (recipient !== undefined && recipient !== "assistant" && recipient !== "user") {
      mode = "call";
      args = "";
      out.push({ kind: "call.start", name: recipient.startsWith("functions.") ? recipient.slice("functions.".length) : recipient });
    } else mode = channel === "analysis" ? "reasoning" : "text";
  };

  const run = (final: boolean): Emit[] => {
    const out: Emit[] = [];
    for (;;) {
      if (mode === "done") {
        buf = "";
        return out;
      }
      if (mode === "header") {
        if (!sawStart && header === "" && buf.trim() !== "" && !buf.trimStart().startsWith("<|") && !"<|".startsWith(buf.trimStart())) {
          sawStart = true;
          mode = "text"; // bare text: the model is not using the format
          continue;
        }
        const i = buf.indexOf(MESSAGE);
        if (i < 0) {
          if (final) buf = "";
          return out;
        }
        sawStart = true;
        header += buf.slice(0, i);
        buf = buf.slice(i + MESSAGE.length);
        openMessage(header, out);
        header = "";
        continue;
      }
      // Reading a body: text up to the next special token.
      const i = buf.indexOf("<|");
      if (i < 0) {
        const hold = !final && buf.endsWith("<") ? 1 : 0;
        emitBody(buf.slice(0, buf.length - hold), out);
        buf = buf.slice(buf.length - hold);
        return out;
      }
      emitBody(buf.slice(0, i), out);
      buf = buf.slice(i);
      const tok = TOKEN.exec(buf)?.[0];
      if (tok === undefined) {
        if (!final && buf.length < 24) return out; // a token not complete yet
        emitBody(buf.slice(0, 2), out); // not a token: plain text
        buf = buf.slice(2);
        continue;
      }
      if (!TERMINATORS.has(tok)) {
        emitBody(tok, out);
        buf = buf.slice(tok.length);
        continue;
      }
      buf = buf.slice(tok.length);
      closeMessage(out);
      if (tok === START) {
        mode = "header";
        header = "";
      } else mode = tok === END ? "header" : "done";
    }
  };

  return {
    push(text) {
      buf += text;
      return run(false);
    },
    end() {
      const out = run(true);
      closeMessage(out);
      mode = "done";
      return out;
    },
  };
}

export const harmony: Dialect = { id: "harmony", render: renderHarmony, parser: () => harmonyParser() };
