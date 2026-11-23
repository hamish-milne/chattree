/** Small text helpers that describe entries and merges; no state, no I/O. */
import type { DiffEntry, MergeTreeResult } from "../src/index.ts";
import { BLOBS_DIR } from "./blob-store.ts";
import type { MergeConflict, MergeReport } from "./conversation-types.ts";
import type { ChatEntry } from "./entries.ts";

export const CHAT_FILE = "chat.yml";

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export function oneLine(s: string, max: number): string {
  // Control characters and Unicode line separators become spaces (built from code points to keep this file ASCII).
  let flat = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    flat += c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 ? " " : ch;
  }
  flat = flat.replace(/ +/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : flat;
}

/** Commit subject for an entry: readable in `git log --oneline`. */
// oxlint-disable-next-line typescript/consistent-return -- the switch covers every case; the compiler checks it
export function describeEntry(e: ChatEntry): string {
  switch (e.$tag) {
    case "header":
      return "Start conversation";
    case "user": {
      const first = e.content.find((p) => p.$tag === "text");
      const text = first === undefined ? "(attachment)" : typeof first.text === "string" ? first.text : "(large text)";
      return `user: ${oneLine(text, 60)}`;
    }
    case "assistant": {
      const calls = e.blocks.filter((b) => b.$tag === "tool_call").length;
      return `assistant: ${e.stop_reason}${calls > 0 ? `, ${calls} tool call${calls === 1 ? "" : "s"}` : ""}`;
    }
    case "tool_result":
      return `tool_result: ${oneLine(e.call_id, 40)}${e.is_error ? " (error)" : ""}`;
    case "compaction":
      return "compaction";
    case "trim":
      return `trim${e.by === "auto" ? ": automatic" : ""}`;
    case "agent_setup":
      return `agent_setup: ${e.reason}${e.model === undefined ? "" : ` ${oneLine(e.model.resolved ?? e.model.id, 40)}`}`;
    case "branch_start":
      return `branch_start: ${e.kind}`;
    case "subagent_result":
      return `subagent_result: ${oneLine(e.branch, 40)}`;
    case "fork_merge":
      return `fork_merge: ${oneLine(e.branch, 40)}`;
    case "job_event":
      return `job_event: ${oneLine(e.job, 20)} ${e.status}`;
    case "approval":
      return `approval: ${oneLine(e.call_id, 40)} ${e.allow ? "allowed" : "declined"}`;
    case "injection":
      return `injection: ${oneLine(e.key, 40)}`;
    case "file_touch":
      return `file_touch: ${(e.files ?? []).length} file(s)${e.dropped === undefined ? "" : `, ${e.dropped.length} dropped`}`;
    case "interrupted":
      return `interrupted: ${e.by}`;
  }
}

const CONFLICT_TYPE = /^CONFLICT \((.+)\)$/;

/**
 * Describe a trunk-wins merge: which of the child's changes landed, which were dropped, and why. A file is
 * "discarded" when it conflicted, because the trunk's version of the whole file was taken.
 */
export function summarizeMerge(childChanges: readonly DiffEntry[], merge: MergeTreeResult): Omit<MergeReport, "base"> {
  const own = (p: string): boolean => p === CHAT_FILE || p === BLOBS_DIR || p.startsWith(`${BLOBS_DIR}/`);
  const kinds = new Map<string, Set<string>>();
  const conflicted = new Set<string>(merge.conflictedPaths.filter((p) => !own(p)));
  for (const m of merge.messages) {
    const type = CONFLICT_TYPE.exec(m.type)?.[1];
    if (type === undefined) continue;
    for (const p of m.paths) {
      if (own(p)) continue;
      conflicted.add(p);
      (kinds.get(p) ?? kinds.set(p, new Set()).get(p))?.add(type === "contents" ? "content" : type);
    }
  }
  const changes = childChanges.filter((c) => !own(c.path));
  const touched = new Set(changes.map((c) => c.path));
  const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const discarded = changes
    .filter((c) => conflicted.has(c.path))
    .map((c) => c.path)
    .sort(byPath);
  const landed = changes.filter((c) => !conflicted.has(c.path));
  const conflicts: MergeConflict[] = [];
  for (const [path, ks] of kinds) if (touched.has(path)) for (const kind of ks) conflicts.push({ path, kind });
  conflicts.sort((a, b) => byPath(a.path, b.path) || byPath(a.kind, b.kind));
  return {
    changed: landed
      .filter((c) => c.status !== "A")
      .map((c) => c.path)
      .sort(byPath),
    added: landed
      .filter((c) => c.status === "A")
      .map((c) => c.path)
      .sort(byPath),
    discarded,
    conflicts,
  };
}
