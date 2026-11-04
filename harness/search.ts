import type { Conversation } from "./conversation.ts";
import { contextEntries } from "./context.ts";
import { inlineBlobs } from "./context-builder.ts";
import type { ChatEntry } from "./entries.ts";
import { byteLength, trimRules, type TrimRule } from "./trim.ts";
import { originOf } from "./thread-tools.ts";

/**
 * Lexical search over the entries of a conversation's threads (docs/tools.md, 4.4). It reads the transcripts as they are and builds no
 * index: the entries of a branch are read once per process and kept by the branch's tip commit. What it finds is returned as references
 * (`thread:entry-id`) that `openEntry` turns back into the entry.
 */

export type Scope = "thread" | "family" | "project";

export interface SearchOptions {
  query: string;
  /** The whole query is a regular expression (case-insensitive). Otherwise every word must occur, and "quoted phrases" occur as written. */
  regex?: boolean;
  scope?: Scope;
  /** Also report what the asking thread's model can see right now (by default that is left out: it is already known). */
  includeVisible?: boolean;
  /** Search the readable reasoning of responses too. */
  reasoning?: boolean;
  limit?: number;
}

export interface Hit {
  ref: string;
  thread: string;
  /** Position among the thread's entries (its own, counted from 1 after its start; for the thread scope, in the whole transcript). */
  n: number;
  kind: Part["kind"];
  /** How the thread stands to the asker. */
  relation: "self" | "parent" | "ancestor" | "child" | "descendant" | "sibling" | "other";
  excerpt: string;
  score: number;
}

export interface SearchResult {
  hits: Hit[];
  /** Matches found before the limit. */
  total: number;
  threads: number;
  /** Things the reader should know: what was cut or skipped. */
  notes: string[];
}

interface Part {
  kind: "user" | "assistant" | "tool call" | "tool result" | "reasoning" | "report";
  text: string;
  /** Whether the model that owns the thread sees this part's text in its context right now, given compaction and trim. */
  visible?: boolean;
}

export const BLOB_LIMIT = 2_000_000;
const MAX_QUERY = 300;

class SearchError extends Error {
  override name = "SearchError";
}
export { SearchError };

const dec = new TextDecoder();
const decoded = (rs: Awaited<ReturnType<Conversation["readEntriesAt"]>>): ChatEntry[] => rs.flatMap((e) => (e.ok ? [e.value] : []));

const cache = new WeakMap<Conversation, Map<string, { tip: string; entries: ChatEntry[] }>>();

/** The entries of a branch as of its tip, read once for each tip. */
async function entriesAt(convo: Conversation, branch: string, tip: string): Promise<ChatEntry[]> {
  const mine = cache.get(convo) ?? new Map<string, { tip: string; entries: ChatEntry[] }>();
  cache.set(convo, mine);
  const have = mine.get(branch);
  if (have?.tip === tip) return have.entries;
  const entries = decoded(await convo.readEntriesAt(tip));
  mine.set(branch, { tip, entries });
  return entries;
}

/** Text that is inline or a blob (up to `BLOB_LIMIT` bytes of it). */
async function textOf(convo: Conversation, t: string | { sha256: string; bytes: number }, notes: Set<string>): Promise<string> {
  if (typeof t === "string") return t;
  const bytes = await convo.store.get(t.sha256);
  if (bytes === undefined) return "";
  if (bytes.length > BLOB_LIMIT) notes.add(`a stored result of ${t.bytes} bytes was searched only in its first ${BLOB_LIMIT}`);
  return dec.decode(bytes.length > BLOB_LIMIT ? bytes.subarray(0, BLOB_LIMIT) : bytes);
}

/** The searchable parts of an entry. */
async function partsOf(convo: Conversation, e: ChatEntry, reasoning: boolean, notes: Set<string>): Promise<Part[]> {
  const read = (t: string | { sha256: string; bytes: number }): Promise<string> => textOf(convo, t, notes);
  const out: Part[] = [];
  switch (e.$tag) {
    case "user":
      for (const p of e.content) if (p.$tag === "text") out.push({ kind: "user", text: await read(p.text) });
      break;
    case "assistant":
      for (const b of e.blocks) {
        if (b.$tag === "text") out.push({ kind: "assistant", text: await read(b.text) });
        else if (b.$tag === "tool_call") out.push({ kind: "tool call", text: `${b.name} ${JSON.stringify(await inlineBlobs(b.args ?? {}, read))}` });
        else if (b.$tag === "reasoning" && reasoning && b.visible !== undefined) out.push({ kind: "reasoning", text: await read(b.visible) });
      }
      break;
    case "tool_result":
      out.push({ kind: "tool result", text: await read(e.full ?? e.content) });
      break;
    case "subagent_result":
    case "fork_merge":
      out.push({ kind: "report", text: await read(e.summary) });
      break;
    default:
      break;
  }
  return out;
}

/** The entry ids the thread's model sees, and the rule that leaves parts of them out. */
function visibility(entries: readonly ChatEntry[]): Map<string, TrimRule | undefined> {
  const visible = contextEntries(entries);
  const rules = trimRules(visible);
  const out = new Map<string, TrimRule | undefined>();
  visible.forEach((e, i) => {
    if ("id" in e && typeof e.id === "string") out.set(e.id, rules[i]);
  });
  return out;
}

/** Whether the asker's model is shown this part of this entry as it stands. */
function shown(e: ChatEntry, part: Part, seen: Map<string, TrimRule | undefined>): boolean {
  if (!("id" in e) || typeof e.id !== "string" || !seen.has(e.id)) return false;
  const rule = seen.get(e.id);
  const bytes = byteLength(part.text);
  if (part.kind === "tool result") return !(rule?.tool_results !== undefined && bytes >= rule.tool_results);
  if (part.kind === "tool call") return !(rule?.tool_args !== undefined && bytes >= rule.tool_args);
  if (part.kind === "reasoning") return rule?.reasoning !== true;
  return true;
}

/** The words and phrases of a plain query. */
export function terms(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) out.push((m[1] ?? m[2] ?? "").toLowerCase());
  return out.filter((t) => t !== "");
}

/** A pattern whose shape can take exponential time is refused: a regular expression from a model must not hang the process. */
function safeRegex(query: string): RegExp {
  if (query.length > MAX_QUERY) throw new SearchError(`a regular expression may be at most ${MAX_QUERY} characters`);
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(query) || /\\[1-9]/.test(query) || /\(\?<?[=!]/.test(query)) throw new SearchError("that expression repeats a group, uses a back-reference or looks around, which can take very long: write it more simply, or search for words");
  try {
    return new RegExp(query, "gi");
  } catch (e) {
    throw new SearchError(`not a regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function matcher(opts: SearchOptions): (text: string) => { score: number; at: number } | undefined {
  if (opts.regex === true) {
    const re = safeRegex(opts.query);
    return (text) => {
      re.lastIndex = 0;
      let score = 0;
      let at = -1;
      for (let m = re.exec(text); m !== null && score < 1000; m = re.exec(text)) {
        if (at < 0) at = m.index;
        score++;
        if (m[0] === "") re.lastIndex++;
      }
      return score === 0 ? undefined : { score, at };
    };
  }
  const want = terms(opts.query);
  if (want.length === 0) throw new SearchError("the query is empty");
  return (text) => {
    const low = text.toLowerCase();
    let score = 0;
    let at = -1;
    for (const t of want) {
      const i = low.indexOf(t);
      if (i < 0) return undefined;
      if (at < 0 || i < at) at = i;
      for (let k = i; k >= 0 && score < 1000; k = low.indexOf(t, k + t.length)) score++;
    }
    return { score, at };
  };
}

const EXCERPT = 200;
function excerpt(text: string, at: number): string {
  const from = Math.max(0, at - 60);
  const piece = text.slice(from, from + EXCERPT).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${piece}${from + EXCERPT < text.length ? "…" : ""}`;
}

interface Tree {
  origin: Map<string, string | undefined>;
}

/** How each thread stands to the asker, by origin: itself, ancestors (nearest first), descendants, siblings, the rest. */
function arrange(asker: string, tree: Tree, branches: readonly string[]): Map<string, { relation: Hit["relation"]; rank: number }> {
  const out = new Map<string, { relation: Hit["relation"]; rank: number }>();
  out.set(asker, { relation: "self", rank: 0 });
  const chain: string[] = [];
  for (let at = tree.origin.get(asker); at !== undefined && !chain.includes(at) && chain.length < 50; at = tree.origin.get(at)) chain.push(at);
  chain.forEach((b, i) => out.set(b, { relation: i === 0 ? "parent" : "ancestor", rank: 1 + i }));
  const depth = (b: string): number | undefined => {
    for (let at = tree.origin.get(b), d = 1; at !== undefined && d < 50; at = tree.origin.get(at), d++) if (at === asker) return d;
    return undefined;
  };
  for (const b of branches) {
    if (out.has(b)) continue;
    const d = depth(b);
    if (d !== undefined) out.set(b, { relation: d === 1 ? "child" : "descendant", rank: 100 + d });
  }
  const mine = tree.origin.get(asker);
  for (const b of branches) if (!out.has(b) && mine !== undefined && tree.origin.get(b) === mine) out.set(b, { relation: "sibling", rank: 200 });
  for (const b of branches) if (!out.has(b)) out.set(b, { relation: "other", rank: 300 });
  return out;
}

/** The unarchived branches (and the asker's own, whatever its state) with their entries, and the thread tree they form. */
async function load(convo: Conversation, asker: string, notes: Set<string>) {
  const infos = await convo.listBranches();
  const live = infos.filter((b) => !b.archived || b.name === asker);
  const byBranch = new Map<string, ChatEntry[]>();
  const origin = new Map<string, string | undefined>();
  for (const b of live) {
    try {
      const entries = await entriesAt(convo, b.name, b.tip);
      byBranch.set(b.name, entries);
      origin.set(b.name, originOf(entries));
    } catch {
      notes.add(`thread ${b.name} could not be read and was skipped`);
    }
  }
  return { infos: live, byBranch, tree: { origin } };
}

/** Which threads a scope covers, for the asker. */
function inScope(scope: Scope, asker: string, order: Map<string, { relation: Hit["relation"]; rank: number }>): Set<string> {
  const names = [...order.entries()].filter(([name, o]) => (scope === "project" ? true : scope === "family" ? o.relation !== "other" : name === asker)).map(([n]) => n);
  return new Set(names);
}

/** Search the threads `scope` covers for the asker (default: its own), closest threads first. */
export async function search(convo: Conversation, asker: string, opts: SearchOptions): Promise<SearchResult> {
  const notes = new Set<string>();
  const scope = opts.scope ?? "thread";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const match = matcher(opts);
  const { byBranch, tree } = await load(convo, asker, notes);
  const mine = byBranch.get(asker);
  if (mine === undefined) throw new SearchError(`thread ${asker} is not a branch of this conversation`);
  const order = arrange(asker, tree, [...byBranch.keys()]);
  const covered = inScope(scope, asker, order);
  const seen = visibility(mine);

  // An entry belongs to the thread that wrote it: a branch holds the entries of the threads it came from before its own start, so each
  // thread's own part is what follows its last `branch_start`. The thread scope also covers what the asker inherited.
  const own = new Map<string, ChatEntry[]>();
  const owner = new Map<string, string>();
  for (const [name, entries] of byBranch) {
    const mineOnly = entries.slice(entries.findLastIndex((e) => e.$tag === "branch_start") + 1);
    own.set(name, mineOnly);
    for (const e of mineOnly) if ("id" in e && typeof e.id === "string" && !owner.has(e.id)) owner.set(e.id, name);
  }
  const candidates: { thread: string; n: number; e: ChatEntry }[] = [];
  if (scope === "thread") {
    for (const [n, e] of mine.entries()) candidates.push({ thread: "id" in e && typeof e.id === "string" ? (owner.get(e.id) ?? asker) : asker, n, e });
  } else {
    for (const name of covered) for (const [n, e] of (own.get(name) as ChatEntry[]).entries()) candidates.push({ thread: name, n: n + 1, e });
  }
  const hits: Hit[] = [];
  const claimed = new Set<string>();
  for (const { thread, n, e } of candidates) {
    if (!("id" in e) || typeof e.id !== "string" || claimed.has(e.id)) continue;
    let best: { score: number; at: number; part: Part; text: string } | undefined;
    let total = 0;
    for (const part of await partsOf(convo, e, opts.reasoning === true, notes)) {
      if (opts.includeVisible !== true && shown(e, part, seen)) continue;
      const m = match(part.text);
      if (m === undefined) continue;
      total += m.score;
      if (best === undefined || m.score > best.score) best = { ...m, part, text: part.text };
    }
    if (best === undefined) continue;
    claimed.add(e.id);
    hits.push({ ref: `${thread}:${e.id}`, thread, n, kind: best.part.kind, relation: (order.get(thread) ?? { relation: "other" }).relation, excerpt: excerpt(best.text, best.at), score: total });
  }
  const rank = (h: Hit): number => (order.get(h.thread)?.rank ?? 999);
  hits.sort((a, b) => rank(a) - rank(b) || (a.thread === b.thread ? b.score - a.score || b.ref.localeCompare(a.ref) : 0));
  return { hits: hits.slice(0, limit), total: hits.length, threads: covered.size, notes: [...notes] };
}

/** `thread:entry-id` (the id may be a prefix of at least 6 characters). */
export function parseRef(ref: string): { thread: string; id: string } | undefined {
  const at = ref.lastIndexOf(":");
  if (at <= 0) return undefined;
  const thread = ref.slice(0, at);
  const id = ref.slice(at + 1).toUpperCase();
  return /^[0-9A-Z]{6,26}$/.test(id) ? { thread, id } : undefined;
}

const OPEN_LIMIT = 12_000;

/** An entry in full (long text cut at a bounded size, large results named so the `read` tool can open them), from a reference. */
export async function openEntry(convo: Conversation, ref: string): Promise<{ text: string } | { error: string }> {
  const r = parseRef(ref);
  if (r === undefined) return { error: `${ref} is not a reference: it looks like thread:entry-id, as search results give it` };
  const tip = (await convo.listBranches()).find((b) => b.name === r.thread)?.tip;
  if (tip === undefined) return { error: `there is no thread ${r.thread}` };
  const entries = await entriesAt(convo, r.thread, tip);
  const hits = entries.filter((e) => "id" in e && typeof e.id === "string" && e.id.startsWith(r.id));
  if (hits.length !== 1) return { error: hits.length === 0 ? `thread ${r.thread} has no entry ${r.id}` : `${r.id} matches ${hits.length} entries of ${r.thread}: give more of the id` };
  const e = hits[0] as ChatEntry & { id: string };
  const notes = new Set<string>();
  const parts = await partsOf(convo, e, true, notes);
  let used = 0;
  const lines: string[] = [];
  for (const p of parts) {
    const room = Math.max(0, OPEN_LIMIT - used);
    const cut = p.text.length > room;
    lines.push(`${p.kind}: ${cut ? p.text.slice(0, room) : p.text}${cut ? `\n… (${p.text.length - room} more characters)` : ""}`);
    used += Math.min(p.text.length, room);
  }
  const blobs = blobNames(e);
  return { text: `${r.thread}:${e.id} (${e.$tag})\n${lines.length === 0 ? "(nothing to show as text)" : lines.join("\n")}${blobs.length > 0 ? `\n(stored output can be read with the read tool: ${blobs.map((s) => `blob:${s}`).join(", ")})` : ""}${[...notes].map((n) => `\n(${n})`).join("")}` };
}

function blobNames(e: ChatEntry): string[] {
  if (e.$tag === "tool_result") return [e.full?.sha256, typeof e.content === "object" ? e.content.sha256 : undefined].filter((x): x is string => x !== undefined);
  return [];
}

/** The thread a reference names. */
export const refThread = (ref: string): string | undefined => parseRef(ref)?.thread;
