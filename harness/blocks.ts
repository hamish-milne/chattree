import type { Block } from "./context-builder.ts";
import type { ChatEntry } from "./entries.ts";

type EntryBlock = Extract<ChatEntry, { $tag: "assistant" }>["blocks"][number];

/** A provider's blocks as the transcript stores them (`assistant.blocks`, `interrupted.partial`). */
export function toEntryBlocks(blocks: readonly Block[]): EntryBlock[] {
  return blocks.map((b): EntryBlock => {
    const ext = b.ext === undefined ? {} : { ext: b.ext };
    if (b.type === "text") return { $tag: "text", text: b.text, ...ext };
    if (b.type === "reasoning") return { $tag: "reasoning", provider: b.provider, payload: b.payload, ...(b.visible === undefined ? {} : { visible: b.visible }), ...ext };
    return { $tag: "tool_call", call_id: b.call_id, name: b.name, args: b.args, ...(b.args_raw === undefined ? {} : { args_raw: b.args_raw }), ...ext };
  });
}
