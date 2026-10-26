import type { ChatEntry } from "../harness/entries.ts";

/** Entries that can be named: everything but the header, which has no id. */
export const nameable = (entries: readonly ChatEntry[]): ChatEntry[] => entries.filter((e) => e.$tag !== "header");

/**
 * Which entry a word means: a number counts back from the last entry (1 is the last, as in `/show`), anything else is the
 * start of an entry id. Undefined if nothing matches or the prefix is ambiguous.
 */
export function resolveEntry(entries: readonly ChatEntry[], want: string): (ChatEntry & { id: string }) | undefined {
  const all = nameable(entries).filter((e): e is ChatEntry & { id: string } => "id" in e && typeof e.id === "string");
  if (/^\d+$/.test(want)) {
    const n = Number(want);
    return n >= 1 && n <= all.length ? all[all.length - n] : undefined;
  }
  const hits = all.filter((e) => e.id.startsWith(want.toUpperCase()) || e.id.startsWith(want));
  return hits.length === 1 ? hits[0] : undefined;
}
