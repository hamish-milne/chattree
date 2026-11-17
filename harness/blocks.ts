import type { Block } from "./context-builder.ts";
import type { ChatEntry } from "./entries.ts";
import { usageRecord } from "./ledger.ts";
import type { Completed } from "../providers/types.ts";

/**
 * Conversion from the provider-neutral blocks a turn produces to the entry shapes the transcript commits. Live turns,
 * recovered responses and interrupted partials all go through here, so they are stored in the same shape. Optional
 * fields are written only when present, so entries carry no empty keys.
 */

type EntryBlock = Extract<ChatEntry, { $tag: "assistant" }>["blocks"][number];

/**
 * A provider's blocks as the transcript stores them (`assistant.blocks`, `interrupted.partial`). Any block type not
 * handled below falls through to `tool_call`, so a new block type needs its own branch here or it is stored wrongly.
 */
export function toEntryBlocks(blocks: readonly Block[]): EntryBlock[] {
  return blocks.map((b): EntryBlock => {
    const ext = b.ext === undefined ? {} : { ext: b.ext };
    if (b.type === "text") return { $tag: "text", text: b.text, ...ext };
    if (b.type === "provider_compaction") return { $tag: "provider_compaction", provider: b.provider, payload: b.payload, ...ext };
    if (b.type === "reasoning")
      return {
        $tag: "reasoning",
        provider: b.provider,
        ...(b.payload === undefined ? {} : { payload: b.payload }),
        ...(b.visible === undefined ? {} : { visible: b.visible }),
        ...ext,
      };
    return {
      $tag: "tool_call",
      call_id: b.call_id,
      name: b.name,
      args: b.args,
      ...(b.args_raw === undefined ? {} : { args_raw: b.args_raw }),
      ...ext,
    };
  });
}

/**
 * The `assistant` entry for a response that completed: what the turn runner commits, and what recovery commits for a
 * retrieved or journaled one. `model` is the one the provider reports serving when it reports one, since it can differ
 * from the model that was asked for; the requested name is the fallback.
 */
export function assistantFromCompleted(
  provider: string,
  requestedModel: string,
  c: Completed,
): Omit<Extract<ChatEntry, { $tag: "assistant" }>, "id"> {
  const ext = {
    ...(c.observed.response_id === undefined ? {} : { response_id: c.observed.response_id }),
    ...(c.observed.service_tier === undefined ? {} : { service_tier: c.observed.service_tier }),
    ...c.ext,
  };
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
