import type { ChatEntry } from "../harness/entries.ts";
import type { Engine } from "./engine.ts";
import { formatEntry } from "./output.ts";

const RECENT = 10;

/** What the user should see when a thread opens: the exchange since their last message (at most ten entries), clipped. */
export async function recentEntries(engine: Engine): Promise<string[]> {
  const entries = (await engine.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : [])).filter((e): e is ChatEntry => e.$tag !== "agent_setup");
  let from = entries.length - RECENT;
  const lastUser = entries.map((e) => e.$tag).lastIndexOf("user");
  if (lastUser >= 0) from = Math.max(from, lastUser);
  const out: string[] = [];
  for (const e of entries.slice(Math.max(0, from))) {
    const t = await formatEntry(engine.convo, e, { thinking: engine.state.thinking, max: 600 });
    if (t !== undefined) out.push(t);
  }
  return out;
}

