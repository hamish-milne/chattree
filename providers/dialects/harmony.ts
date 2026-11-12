import type { Block, Turn } from "../../harness/context-builder.ts";
import type { ToolDefinition } from "../../harness/definitions.ts";
import type { Dialect, Emit, Parser, RenderInput } from "../dialect.ts";
import { builtinPreamble, builtinSpecs, messageOf, type BuiltinSpec } from "./harmony-builtin.ts";
import { parseSchema, toolSchema, type SchemaNode } from "./schema-tree.ts";

/**
 * Harmony, the format gpt-oss was trained on (docs/local-models.md, section 9.1). Rendering reproduces what the model's own chat
 * template produces for plain conversations (the parity tests compare against its output), and departs from it in four deliberate
 * ways, each a lever in the options or a documented fix:
 *   D1  a finished answer is always in the `final` channel, and the reasoning of finished exchanges is dropped (the template puts a
 *       message that has both reasoning and content in `analysis`, which teaches the model to answer there);
 *   D2  several calls in one assistant turn are rendered as call/result pairs in order (the template renders only the first);
 *   D3  nested object and array schemas are declared in full (the template says `any[]`); `schema: "flat"` restores that;
 *   D4  text written before a call (a preamble) is in the `commentary` channel, as the format's own guide has it.
 * The parser also reads a bare body as the argument of a tool with one required string argument (see `harmonyParser`), and
 * `builtin_tools` presents chosen tools as built-ins (harmony-builtin.ts).
 * Options: `keep_reasoning` (default true): reasoning of the unfinished exchange is replayed in `analysis`;
 * `schema`: `"full"` (default) or `"flat"`; and the wording of the system block, which differs between checkpoints and variants:
 * `identity` (the first line; `false` leaves it out), `knowledge_cutoff` (`"2024-06"`; `false` leaves it out) and `date`: `"none"` (default:
 * the date is given in the `environment` injection instead, which keeps the start of the prompt, and so its cache, the same from day to
 * day), `"today"` (the date the request is made on, as the model's own template does) or any text, written as `Current date: TEXT`.
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
  /** The first line of the system block, or undefined for none. */
  identity: string | undefined;
  /** The knowledge cutoff, or undefined for none. */
  cutoff: string | undefined;
  /** What follows `Current date: `: `"today"` stands for the request's date; undefined for no date line. */
  date: string | undefined;
  /** Tools presented as built-ins (`builtin_tools`), by name. */
  builtin: Map<string, BuiltinSpec>;
}

const IDENTITY = "You are ChatGPT, a large language model trained by OpenAI.";

/** An option that is a string, `false` for nothing, or absent for the default. */
const text = (v: unknown, fallback: string | undefined): string | undefined => (v === false ? undefined : typeof v === "string" ? v : fallback);

export function harmonyOptions(o: Record<string, unknown>): HarmonyOptions {
  const date = typeof o["date"] === "string" ? o["date"] : "none";
  return {
    keepReasoning: o["keep_reasoning"] !== false,
    full: o["schema"] !== "flat",
    identity: text(o["identity"], IDENTITY),
    cutoff: text(o["knowledge_cutoff"], "2024-06"),
    date: date === "none" ? undefined : date,
    builtin: builtinSpecs(o["builtin_tools"]),
  };
}

// ---- rendering --------------------------------------------------------------------------------------------------

/** JSON as the template writes it: a space after `,` and `:`. */
export function spacedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(spacedJson).join(", ")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(", ")}}`;
  return JSON.stringify(v) ?? "null";
}

const comment = (text: string): string => text.split("\n").map((l) => `// ${l}`.trimEnd()).join("\n");

const TYPE_NAMES: Record<string, string> = { string: "string", integer: "number", number: "number", boolean: "boolean", null: "null" };

/** A schema as the TypeScript type that the format declares it with. */
function typeOf(n: SchemaNode, full: boolean): string {
  if (n.enum !== undefined) return n.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (n.const !== undefined) return JSON.stringify(n.const.value);
  if (n.union !== undefined) return unique(n.union.map((a) => typeOf(a, full))).join(" | ");
  if (n.types.length === 0) return "any";
  return unique(n.types.map((t) => single(n, t, full))).join(" | ");
}

/** One of a schema's types. */
function single(n: SchemaNode, type: string, full: boolean): string {
  if (type === "array") {
    const inner = n.items === undefined ? "any" : typeOf(n.items, full);
    if (!full && inner !== "string" && inner !== "number" && inner !== "boolean") return "any[]";
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }
  if (type === "object") return full && n.properties !== undefined ? `{\n${properties(n, full)}\n}` : "object";
  return TYPE_NAMES[type] ?? "any";
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** The lines of an object's properties: a comment for each description, then `name?: type,`. */
function properties(n: SchemaNode, full: boolean): string {
  const required = new Set(n.required);
  return (n.properties ?? [])
    .map(([name, p]) => `${p.description === undefined ? "" : `${comment(p.description)}\n`}${name}${required.has(name) ? "" : "?"}: ${typeOf(p, full)},`)
    .join("\n");
}

function declaration(t: ToolDefinition, full: boolean): string {
  const desc = t.description === "" ? "" : `${comment(t.description)}\n`;
  const root = parseSchema(t.input_schema);
  if ((root.properties ?? []).length === 0) return `${desc}type ${t.name} = () => any;`;
  return `${desc}type ${t.name} = (_: {\n${properties(root, full)}\n}) => any;`;
}

function systemBlock(input: RenderInput, o: HarmonyOptions, hasTools: boolean, builtins: readonly (readonly [string, BuiltinSpec])[]): string {
  const effort = input.effort === "low" || input.effort === "high" ? input.effort : "medium";
  const head = [o.identity, o.cutoff === undefined ? undefined : `Knowledge cutoff: ${o.cutoff}`, o.date === undefined ? undefined : `Current date: ${o.date === "today" ? input.date : o.date}`].filter((l) => l !== undefined).join("\n");
  const calls = hasTools ? "\nCalls to these tools must go to the commentary channel: 'functions'." : "";
  const tools = builtins.length === 0 ? "" : `# Tools\n\n${builtins.map(([, b]) => b.prose).join("\n\n")}\n\n`;
  return `${START}system${MESSAGE}${head === "" ? "" : `${head}\n\n`}Reasoning: ${effort}

${tools}# Valid channels: analysis, commentary, final. Channel must be included for every message.${calls}${END}`;
}

function developerBlock(input: RenderInput, o: HarmonyOptions, functions: readonly ToolDefinition[], builtins: readonly (readonly [string, BuiltinSpec])[]): string {
  const parts: string[] = [];
  const how = builtins.length === 0 ? "" : builtinPreamble(builtins, functions.length > 0);
  const instructions = [input.context.system, input.context.instructions ?? "", how].filter((x) => x !== "").join("\n\n");
  if (instructions !== "") parts.push(`# Instructions\n\n${instructions}`);
  if (functions.length > 0) parts.push(`# Tools\n\n## functions\n\nnamespace functions {\n\n${functions.map((t) => declaration(t, o.full)).join("\n\n")}\n\n} // namespace functions`);
  return parts.length === 0 ? "" : `${START}developer${MESSAGE}${parts.join("\n\n")}${END}`;
}

const message = (channel: string, body: string, end = END): string => `${START}assistant${CHANNEL}${channel}${MESSAGE}${body}${end}`;

/** Whether reasoning that this turn wrote is replayed to this request's model. */
const sameModel = (t: Extract<Turn, { role: "assistant" }>, input: RenderInput): boolean => t.provider === input.provider && t.model.split("@")[0] === input.model.split("@")[0];

export function renderHarmony(input: RenderInput): { prompt: string; stop: string[] } {
  const o = harmonyOptions(input.options);
  const turns = input.context.turns;
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  const functions = input.context.tools.filter((t) => !o.builtin.has(t.name));
  const builtins = input.context.tools.flatMap((t) => (o.builtin.has(t.name) ? [[t.name, o.builtin.get(t.name) as BuiltinSpec] as const] : []));
  let out = systemBlock(input, o, functions.length > 0, builtins) + developerBlock(input, o, functions, builtins);
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
          const spec = o.builtin.get(b.name);
          const r = results.get(b.call_id);
          if (spec !== undefined) {
            // A built-in: on analysis, the recipient its name, the message the bare text, and the result from the tool on analysis.
            const given = b.args[spec.arg];
            out += message(`analysis to=${b.name} code`, typeof given === "string" ? given : (b.args_raw ?? spacedJson(b.args)), CALL);
            if (r !== undefined) out += `${START}${b.name} to=assistant${CHANNEL}analysis${MESSAGE}${r.content}${END}`;
            continue;
          }
          out += message(`commentary to=functions.${b.name} ${CONSTRAIN}json`, b.args_raw ?? spacedJson(b.args), CALL);
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
 * A call whose body is not JSON, to a tool whose only required argument is a string, takes the whole body as that argument: the model was
 * trained to send code to its `python` tool as the bare message, and does so for any tool that is called that (`python` with a `code` argument).
 *
 * Reads the model's output after `<|start|>assistant`: messages of `<|channel|>NAME[ to=RECIPIENT][ <|constrain|>json]<|message|>BODY`
 * ended by `<|end|>`, `<|call|>` or `<|return|>`. A message with a `functions.` recipient is a call whatever its channel (the model
 * sometimes calls from `analysis`); `analysis` is reasoning; everything else is text. Output that does not start like a message at all
 * is taken as plain text, so a model that ignores the format still answers.
 */
export function harmonyParser(tools: readonly { name: string; input_schema: Record<string, unknown> }[] = [], builtin: ReadonlyMap<string, BuiltinSpec> = new Map()): Parser {
  let buf = "";
  let mode: Mode = "header";
  let header = "";
  let args = "";
  let sawStart = false;
  let callName = "";

  const emitBody = (text: string, out: Emit[]): void => {
    if (text === "") return;
    if (mode === "call") {
      args += text;
      out.push({ kind: "call.args", delta: text });
    } else out.push({ kind: mode === "reasoning" ? "reasoning" : "text", text });
  };

  /** The one argument that a bare (non-JSON) body belongs to, if the tool has just one required argument and it is a string. */
  const bareArgument = (name: string): string | undefined => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) return undefined;
    const schema = toolSchema(tool);
    const only = schema.required.length === 1 ? schema.required[0] : undefined;
    return only !== undefined && schema.properties?.find(([k]) => k === only)?.[1].types.includes("string") === true ? only : undefined;
  };

  const isObjectJson = (text: string): boolean => {
    try {
      const v = JSON.parse(text) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  };

  const closeMessage = (out: Emit[]): void => {
    const spec = mode === "call" ? builtin.get(callName) : undefined;
    if (mode === "call" && spec !== undefined) {
      const m = messageOf(callName, spec, args);
      out.push("text" in m ? { kind: "call.end", args: { [spec.arg]: m.text } } : { kind: "call.end", raw: args, error: m.error });
    } else if (mode === "call") {
      const key = isObjectJson(args) ? undefined : bareArgument(callName);
      out.push(key === undefined ? { kind: "call.end", raw: args } : { kind: "call.end", args: { [key]: args } });
    }
    args = "";
  };

  const openMessage = (h: string, out: Emit[]): void => {
    const recipient = /\bto=([^\s<]+)/.exec(h)?.[1];
    const channel = /<\|channel\|>([a-z]+)/.exec(h)?.[1];
    if (recipient !== undefined && recipient !== "assistant" && recipient !== "user") {
      mode = "call";
      args = "";
      callName = recipient.startsWith("functions.") ? recipient.slice("functions.".length) : recipient;
      out.push({ kind: "call.start", name: callName });
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

export const harmony: Dialect = { id: "harmony", render: renderHarmony, parser: (options, tools) => harmonyParser(tools, harmonyOptions(options).builtin) };
