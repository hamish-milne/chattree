import { readFileSync } from "node:fs";
import type { Block, ModelContext, Turn } from "../../harness/context-builder.ts";

export const fixture = (family: string, name: string) => ({ request: JSON.parse(readFileSync(new URL(`../fixtures/templates/${family}/${name}.request.json`, import.meta.url), "utf8")) as Request, prompt: readFileSync(new URL(`../fixtures/templates/${family}/${name}.prompt.txt`, import.meta.url), "utf8") });

export interface Request {
  messages: { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
  tools: { function: { name: string; description: string; parameters: Record<string, unknown> } }[];
}

/** The chat-completions request of a fixture, as the context the harness would fold. */
export function contextOf(r: Request): ModelContext {
  const turns: Turn[] = [];
  let system = "";
  for (const m of r.messages) {
    if (m.role === "system") system = m.content ?? "";
    else if (m.role === "user") turns.push({ role: "user", parts: [{ type: "text", text: m.content ?? "" }] });
    else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.reasoning_content !== undefined) blocks.push({ type: "reasoning", provider: "local-models", visible: m.reasoning_content });
      if (m.content !== null && m.content !== "") blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) blocks.push({ type: "tool_call", call_id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments) as Record<string, unknown> });
      turns.push({ role: "assistant", provider: "local-models", model: "gpt-oss@abcd1234", blocks });
    } else {
      const last = turns[turns.length - 1];
      const result = { call_id: m.tool_call_id as string, is_error: false, content: m.content ?? "", truncated: false };
      if (last?.role === "tool_results") last.results.push(result);
      else turns.push({ role: "tool_results", results: [result] });
    }
  }
  return { system, instructions: undefined, turns, tools: r.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })), cacheHints: [] };
}

