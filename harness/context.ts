import type { ChatEntry } from "./entries.ts";

/**
 * The entries a model should be shown, given a branch's full transcript. The transcript itself is never
 * rewritten; this is how the recorded events are read:
 *
 * - A subagent branch starts with a `branch_start` whose context is `fresh`: nothing before the last such
 *   marker is visible, and the marker (with its brief) is the first entry.
 * - A `compaction` replaces the entries from `replaces.from` to `replaces.to` with its summary, shown where
 *   the replaced range began. A compaction can itself be named in a later one, as either end of its range:
 *   a summary stands where its own range began and ends where its own range ended, so "everything from the
 *   last summary up to here" is expressible. The earlier summary then disappears into the later one.
 *
 * A compaction that refers to ids it cannot find, to a range that is not entirely before it, or to entries
 * before the last fresh marker (another context's entries) is ignored rather than guessed at. Everything
 * else (including `subagent_result`, `fork_merge` and `interrupted`) passes through unchanged.
 */
export function contextEntries(entries: readonly ChatEntry[]): ChatEntry[] {
  let start = 0;
  entries.forEach((e, i) => {
    if (e.$tag === "branch_start" && e.context === "fresh") start = i;
  });

  // Where each id sits in the visible sequence: [first position, last position]. A compaction stands for its range.
  const span = new Map<string, [number, number]>();
  const covered = new Array<boolean>(entries.length).fill(false);
  const active: { from: number; entry: ChatEntry; swallowed: boolean }[] = [];

  for (let i = start; i < entries.length; i++) {
    const e = entries[i] as ChatEntry;
    if (e.$tag !== "compaction") {
      if ("id" in e && typeof e.id === "string") span.set(e.id, [i, i]);
      continue;
    }
    const first = span.get(e.replaces.from);
    const last = span.get(e.replaces.to);
    if (first !== undefined && last !== undefined && first[0] <= last[1]) {
      const [from, to] = [first[0], last[1]];
      for (let k = from; k <= to; k++) covered[k] = true;
      for (const earlier of active) if (earlier.from >= from && earlier.from <= to) earlier.swallowed = true;
      active.push({ from, entry: e, swallowed: false });
      span.set(e.id, [from, to]);
    }
  }

  const anchors = new Map<number, ChatEntry[]>();
  for (const a of active) if (!a.swallowed) anchors.set(a.from, [...(anchors.get(a.from) ?? []), a.entry]);

  const out: ChatEntry[] = [];
  for (let i = start; i < entries.length; i++) {
    const e = entries[i] as ChatEntry;
    for (const a of anchors.get(i) ?? []) out.push(a);
    if (covered[i] || e.$tag === "compaction") continue;
    out.push(e);
  }
  return out;
}
