import type { UiEvent } from "../model/protocol.ts";
import type { Block } from "../model/transcript.ts";

/**
 * The events that take a view showing `shown` to showing `next`: a block that kept its id and changed is an `update`; from
 * the first place the ids part, what was shown is swapped for what is now (`replace`), or the new blocks are added at the
 * end (`append`). Nothing when they are the same. The controller reads the thread again whenever something happened to it
 * and sends this, so a turn of its own, a turn in another window and an edit by hand all reach the view the same way.
 */
export function diffBlocks(shown: readonly Block[], next: readonly Block[]): UiEvent[] {
  const out: UiEvent[] = [];
  let i = 0;
  while (i < shown.length && i < next.length && shown[i]?.id === next[i]?.id) {
    const b = next[i];
    if (b !== undefined && JSON.stringify(b) !== JSON.stringify(shown[i])) out.push({ type: "chat.update", block: b });
    i++;
  }
  const from = shown[i];
  if (from !== undefined) out.push({ type: "chat.replace", from: from.id, blocks: next.slice(i) });
  else if (i < next.length) out.push({ type: "chat.append", blocks: next.slice(i) });
  return out;
}
