import type { Block } from "./context-builder.ts";
import type { ChatEntry } from "./entries.ts";
import { usageRecord } from "./ledger.ts";
import type { Completed } from "../providers/types.ts";

type EntryBlock = Extract<ChatEntry, { $tag: "assistant" }>["blocks"][number];

/** A provider's blocks as the transcript stores them (`assistant.blocks`, `interrupted.partial`). */
export function toEntryBlocks(blocks: readonly Block[]): EntryBlock[] {
  return blocks.map((b): EntryBlock => {
    const ext = b.ext === undefined ? {} : { ext: b.ext };
    if (b.type === "text") return { $tag: "text", text: b.text, ...ext };
    if (b.type === "provider_compaction") return { $tag: "provider_compaction", provider: b.provider, payload: b.payload, ...ext };
    if (b.type === "reasoning") return { $tag: "reasoning", provider: b.provider, payload: b.payload, ...(b.visible === undefined ? {} : { visible: b.visible }), ...ext };
    return { $tag: "tool_call", call_id: b.call_id, name: b.name, args: b.args, ...(b.args_raw === undefined ? {} : { args_raw: b.args_raw }), ...ext };
  });
}

/** The `assistant` entry for a response that completed: what the turn runner commits, and what recovery commits for a retrieved or journaled one. */
export function assistantFromCompleted(provider: string, requestedModel: string, c: Completed): Omit<Extract<ChatEntry, { $tag: "assistant" }>, "id"> {
  const ext = { ...(c.observed.response_id === undefined ? {} : { response_id: c.observed.response_id }), ...(c.observed.service_tier === undefined ? {} : { service_tier: c.observed.service_tier }), ...c.ext };
  return {
    $tag: "assistant",
    provider,
    model: c.observed.model ?? requestedModel,
    blocks: toEntryBlocks(c.blocks),
    stop_reason: c.stop_reason,
    usage: usageRecord(c.usage),
    ...(Object.keys(ext).length > 0 ? { ext } : {}),
  };
}
