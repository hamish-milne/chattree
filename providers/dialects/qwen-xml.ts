import type { Block, Turn } from "../../harness/context-builder.ts";
import type { Dialect, Emit, Parser, RenderInput } from "../dialect.ts";
import { spacedJson } from "./harmony.ts";
import { argSchema, coerce, nextMarker, safeLength, Trimmer } from "./scan.ts";

/**
 * The format of Qwen3.5 (and the Qwen3-Coder family): tools as JSON lines in the system turn with a plain-English instruction, calls as
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`, results as `<tool_response>` in a user turn, and
 * thinking in `<think>`. Rendering reproduces the model's own template (parity tests); it departs from it in:
 *   Q1  a tool result is not trimmed (its trailing newline is meaningful, and the harness formats results itself);
 *   Q2  a boolean argument is written `true`/`false` and null as `null`, not as the template's Python `True`/`None`.
 * Options: `thinking` (default true): the prompt ends inside `<think>`, so the model thinks first; false asks for no thinking;
 * `keep_reasoning` (default true): the reasoning of the unfinished exchange is replayed, as the template does (earlier exchanges never are).
 */

const INSTRUCTIONS =
  "\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>";

const argText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "object" && v !== null ? spacedJson(v) : v === null || v === undefined ? "null" : String(v));

export function renderQwen(input: RenderInput): { prompt: string; stop: string[] } {
  const keep = input.options["keep_reasoning"] !== false;
  const thinking = input.options["thinking"] !== false;
  const { context } = input;
  const system = [context.system, context.instructions ?? ""].filter((x) => x !== "").join("\n\n").trim();
  let out = "";
  if (context.tools.length > 0) {
    out += `<|im_start|>system\n# Tools\n\nYou have access to the following functions:\n\n<tools>${context.tools.map((t) => `\n${spacedJson({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })}`).join("")}\n</tools>${INSTRUCTIONS}${system === "" ? "" : `\n\n${system}`}<|im_end|>\n`;
  } else if (system !== "") out += `<|im_start|>system\n${system}<|im_end|>\n`;
  const turns = context.turns;
  const lastUser = turns.map((t) => t.role).lastIndexOf("user");
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i] as Turn;
    if (t.role === "user") out += `<|im_start|>user\n${t.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n\n").trim()}<|im_end|>\n`;
    else if (t.role === "tool_results") out += `<|im_start|>user${t.results.map((r) => `\n<tool_response>\n${r.content}\n</tool_response>`).join("")}<|im_end|>\n`;
    else {
      const blocks = t.blocks as Block[];
      const content = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      const own = t.provider === input.provider && t.model.split("@")[0] === input.model.split("@")[0];
      const reasoning = keep && own ? blocks.flatMap((b) => (b.type === "reasoning" && b.visible !== undefined ? [b.visible] : [])).join("\n").trim() : "";
      const calls = blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      out += i > lastUser ? `<|im_start|>assistant\n<think>\n${reasoning}\n</think>\n\n${content}` : `<|im_start|>assistant\n${content}`;
      calls.forEach((c, k) => {
        out += k === 0 ? (content !== "" ? "\n\n" : "") : "\n";
        out += `<tool_call>\n<function=${c.name}>\n`;
        for (const [name, v] of Object.entries(c.args)) out += `<parameter=${name}>\n${argText(v)}\n</parameter>\n`;
        out += "</function>\n</tool_call>";
      });
      out += "<|im_end|>\n";
    }
  }
  return { prompt: `${out}<|im_start|>assistant\n${thinking ? "<think>\n" : "<think>\n\n</think>\n\n"}`, stop: [] };
}

type Mode = "reasoning" | "text" | "call";
const THINK_END = ["</think>"];
const TEXT_MARKS = ["<tool_call>", "<think>"];

/** One call's text (between `<tool_call>` and `</tool_call>`) read into a name and arguments. */
export function parseQwenCall(body: string, tools: Parameters<typeof argSchema>[0]): { name: string; args: Record<string, unknown> } | undefined {
  const fn = /<function=([^>\n]+)>/.exec(body);
  if (fn === null) {
    try {
      const j = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown };
      if (typeof j.name === "string" && typeof j.arguments === "object" && j.arguments !== null) return { name: j.name, args: j.arguments as Record<string, unknown> };
    } catch {
      /* not JSON either */
    }
    return undefined;
  }
  const name = (fn[1] as string).trim();
  const args: Record<string, unknown> = {};
  for (const m of body.slice(fn.index + fn[0].length).matchAll(/<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/g)) {
    const key = (m[1] as string).trim();
    const text = (m[2] as string).replace(/^\n/, "").replace(/\n$/, "");
    args[key] = coerce(text, argSchema(tools, name, key));
  }
  return { name, args };
}

export function qwenParser(options: Record<string, unknown>, tools: Parameters<typeof argSchema>[0], prompt: string): Parser {
  void options;
  let mode: Mode = prompt.endsWith("<think>\n") ? "reasoning" : "text";
  let buf = "";
  let call = "";
  let started = false;
  const trim = new Trimmer();

  const run = (final: boolean): Emit[] => {
    const out: Emit[] = [];
    const body = (text: string): void => {
      const t = trim.push(text);
      if (t !== "") out.push({ kind: mode === "reasoning" ? "reasoning" : "text", text: t });
    };
    for (;;) {
      if (mode === "call") {
        const end = buf.indexOf("</tool_call>");
        if (end < 0) {
          const n = final ? buf.length : safeLength(buf, ["</tool_call>"]);
          call += buf.slice(0, n);
          buf = buf.slice(n);
          if (!started) {
            const fn = /<function=([^>\n]+)>/.exec(call);
            if (fn !== null) {
              started = true;
              out.push({ kind: "call.start", name: (fn[1] as string).trim() });
            }
          }
          return out;
        }
        call += buf.slice(0, end);
        buf = buf.slice(end + "</tool_call>".length);
        finishCall(out);
        continue;
      }
      const marks = mode === "reasoning" ? THINK_END : TEXT_MARKS;
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
      mode = m.marker === "<tool_call>" ? "call" : m.marker === "<think>" ? "reasoning" : "text";
      if (mode === "call") {
        call = "";
        started = false;
      }
    }
  };

  const finishCall = (out: Emit[]): void => {
    const parsed = parseQwenCall(call, tools);
    if (parsed === undefined) {
      if (started) out.push({ kind: "call.end", raw: call });
      else out.push({ kind: "text", text: `<tool_call>${call}</tool_call>` });
    } else {
      if (!started) out.push({ kind: "call.start", name: parsed.name });
      out.push({ kind: "call.end", args: parsed.args });
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
        // Cut off inside a call: whatever parameters are complete are kept, and the text is kept for the model to see.
        const parsed = started ? parseQwenCall(call, tools) : undefined;
        if (started) out.push(parsed === undefined || !call.includes("</function>") ? { kind: "call.end", raw: call } : { kind: "call.end", args: parsed.args });
        else if (call !== "") out.push({ kind: "text", text: `<tool_call>${call}` });
      }
      mode = "text";
      return out;
    },
  };
}

export const qwenXml: Dialect = { id: "qwen-xml", render: renderQwen, parser: (o, tools, prompt) => qwenParser(o, tools, prompt) };
