import type { CommitInfo } from "../src/index.ts";
import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";

/** One commit of a conversation repository, placed on the branch that owns it. */
export interface GraphCommit {
  hash: string;
  parents: string[];
  /** The branch whose first-parent line this commit is on. */
  branch: string;
  subject: string;
  /** A short human description of the entry (its content), or the subject when there is none. */
  summary: string;
  /** What the commit is: an entry's type, or `snapshot`, or `fork-point` for plain commits. */
  kind: string;
  /** The entry's id, for entry commits. */
  entry: string | undefined;
  /** Chattree-Offset: the transcript's size at this commit. */
  offset: number | undefined;
  recovered: boolean;
}

export interface CommitGraph {
  /** The branch the rest hang off. */
  trunk: string;
  /** Branches, trunk first, then in order of creation. */
  branches: { name: string; tip: string }[];
  /** Oldest first. */
  commits: GraphCommit[];
}

const flat = (t: unknown): string => (typeof t === "string" ? t : "[large text]").replace(/\s+/g, " ").trim();

/** A few words on what an entry contains, for labels. */
export function summarizeEntry(e: ChatEntry | undefined, fallback: string): string {
  if (e === undefined) return fallback;
  switch (e.$tag) {
    case "user":
      return `user: ${flat(e.content.find((p) => p.$tag === "text")?.text)}`;
    case "assistant": {
      const call = e.blocks.find((b) => b.$tag === "tool_call");
      if (call?.$tag === "tool_call") return `assistant: calls ${call.name}`;
      return `assistant: ${flat(e.blocks.find((b) => b.$tag === "text")?.text)}`;
    }
    case "tool_result":
      return `tool result${typeof e.content === "string" ? `: ${flat(e.content)}` : " (large, stored as a blob)"}`;
    case "compaction":
      return `compaction: ${flat(e.summary)}`;
    case "agent_setup":
      return `setup (${e.reason})${e.model === undefined ? "" : `: ${e.model.resolved ?? e.model.id}`}`;
    case "branch_start":
      return e.kind === "subagent" ? `subagent starts: ${flat(e.brief)}` : "fork starts";
    case "subagent_result":
      return `subagent done: ${flat(e.summary)}`;
    case "fork_merge":
      return `fork merged: ${flat(e.summary)}`;
    case "interrupted":
      return `interrupted by ${e.by}`;
    case "header":
      return "conversation starts";
  }
}

/** Read every commit reachable from any branch and decide which branch each belongs to. */
export async function readCommitGraph(convo: Conversation, trunk = convo.branch): Promise<CommitGraph> {
  const branches = await convo.listBranches();
  const byHash = new Map<string, CommitInfo>();
  for (const b of branches) for (const c of await convo.git.log(b.name)) byHash.set(c.hash, c);

  // Branches in the order they were created: by the date of the first commit that is theirs alone is not
  // known yet, so use the tip's author date, which is when they were last touched, then name.
  const order = [...branches].sort((a, b) => {
    if (a.name === trunk) return -1;
    if (b.name === trunk) return 1;
    const da = byHash.get(a.tip)?.authorDate ?? "";
    const db = byHash.get(b.tip)?.authorDate ?? "";
    return da === db ? a.name.localeCompare(b.name) : da < db ? -1 : 1;
  });

  const owner = new Map<string, string>();
  for (const b of order) {
    for (let h: string | undefined = b.tip; h !== undefined && !owner.has(h); h = byHash.get(h)?.parents[0]) owner.set(h, b.name);
  }

  // What each entry says, from the transcript at every branch tip.
  const values = new Map<string, ChatEntry>();
  for (const b of branches) for (const e of await convo.readEntriesAt(b.name)) if (e.ok && "id" in e.value) values.set(e.value.id, e.value);

  const commits: GraphCommit[] = [];
  for (const c of byHash.values()) {
    const kind = c.trailers["Chattree-Kind"]?.[0] ?? (c.trailers["Chattree-Snapshot"] !== undefined ? "snapshot" : c.trailers["Chattree-Gc"] !== undefined ? "gc" : c.trailers["Chattree-Archived"] !== undefined ? "archive" : "commit");
    const offset = Number(c.trailers["Chattree-Offset"]?.[0]);
    commits.push({
      hash: c.hash,
      parents: c.parents,
      branch: owner.get(c.hash) ?? "(unreachable)",
      subject: c.subject,
      summary: summarizeEntry(values.get(c.trailers["Chattree-Entry"]?.[0] ?? ""), c.subject),
      kind,
      entry: c.trailers["Chattree-Entry"]?.[0],
      offset: Number.isFinite(offset) ? offset : undefined,
      recovered: c.trailers["Chattree-Recovered"] !== undefined,
    });
  }
  // Oldest first: parents before children.
  const placed = new Set<string>();
  const sorted: GraphCommit[] = [];
  const index = new Map(commits.map((c) => [c.hash, c]));
  const visit = (c: GraphCommit): void => {
    const stack: GraphCommit[] = [c];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as GraphCommit;
      if (placed.has(top.hash)) {
        stack.pop();
        continue;
      }
      const pending = top.parents.map((p) => index.get(p)).filter((p): p is GraphCommit => p !== undefined && !placed.has(p.hash));
      if (pending.length === 0) {
        placed.add(top.hash);
        sorted.push(top);
        stack.pop();
      } else stack.push(...pending);
    }
  };
  for (const b of order) visit(index.get(b.tip) as GraphCommit);
  return { trunk, branches: order.map((b) => ({ name: b.name, tip: b.tip })), commits: sorted };
}

export interface MermaidOptions {
  /** Longest label, in characters. Default 40. */
  maxLabel?: number;
  /** Show snapshot commits. Default true. */
  snapshots?: boolean;
}

const TAGGED: Record<string, string> = {
  compaction: "compaction",
  agent_setup: "setup",
  interrupted: "interrupted",
  subagent_result: "subagent result",
  fork_merge: "fork merge",
  branch_start: "start",
  header: "header",
  gc: "blob gc",
};

const clean = (s: string): string => s.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "'").replace(/\s+/g, " ").trim();
const branchId = (name: string): string => `"${name.replace(/[^A-Za-z0-9_./-]/g, "-")}"`;

/**
 * A Mermaid `gitGraph` of the conversation. Each entry commit is labelled with its number and summary, flagged
 * where it is a structural event (compaction, config change, interruption, merge), and snapshots and
 * crash-recovered commits are marked. A branch is drawn beside the commit it started from, whole, even if the
 * trunk moved on while it ran; a merge joins the branch's final state.
 */
export function toMermaid(graph: CommitGraph, opts: MermaidOptions = {}): string {
  const max = opts.maxLabel ?? 40;
  const showSnapshots = opts.snapshots ?? true;
  const byHash = new Map(graph.commits.map((c) => [c.hash, c]));
  const chain = new Map<string, GraphCommit[]>();
  for (const b of graph.branches) chain.set(b.name, []);
  for (const c of graph.commits) chain.get(c.branch)?.push(c);
  const number = new Map(graph.commits.map((c, i) => [c.hash, i + 1]));

  // Branches hang off the commit their first commit's parent points at.
  const children = new Map<string, string[]>();
  for (const b of graph.branches) {
    if (b.name === graph.trunk) continue;
    const first = chain.get(b.name)?.[0];
    const parent = first?.parents[0];
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), b.name]);
  }

  const lines = ["---", `config:`, `  gitGraph:`, `    mainBranchName: ${graph.trunk.replace(/[^A-Za-z0-9_-]/g, "-")}`, `    showCommitLabel: true`, `    rotateCommitLabel: true`, "---", "gitGraph"];
  const label = (c: GraphCommit): string => {
    const what = c.kind === "snapshot" ? "workspace snapshot" : c.summary;
    const text = clean(`${number.get(c.hash)} ${what}`);
    return text.length > max ? `${text.slice(0, max - 1)}~` : text;
  };
  const mainName = (b: string): string => (b === graph.trunk ? graph.trunk.replace(/[^A-Za-z0-9_-]/g, "-") : branchId(b));

  const emitted = new Set<string>();
  const emit = (branch: string): void => {
    for (const c of chain.get(branch) ?? []) {
      if ((c.kind !== "snapshot" && c.kind !== "gc" && c.kind !== "archive") || showSnapshots) {
        const tag = c.recovered ? "recovered" : c.kind === "snapshot" ? undefined : TAGGED[c.kind];
        const type = c.recovered ? "REVERSE" : c.kind === "snapshot" || c.kind === "gc" || c.kind === "archive" ? "REVERSE" : c.parents.length > 1 || c.kind === "compaction" || c.kind === "agent_setup" || c.kind === "interrupted" ? "HIGHLIGHT" : "NORMAL";
        const attrs = `id: "${label(c)}"${tag === undefined ? "" : ` tag: "${tag}"`} type: ${type}`;
        const second = c.parents[1] === undefined ? undefined : byHash.get(c.parents[1]);
        if (second !== undefined && second.branch !== branch) lines.push(`  merge ${mainName(second.branch)} ${attrs}`);
        else lines.push(`  commit ${attrs}`);
      }
      emitted.add(c.hash);
      for (const child of children.get(c.hash) ?? []) {
        lines.push(`  branch ${branchId(child)}`, `  checkout ${branchId(child)}`);
        emit(child);
        lines.push(`  checkout ${mainName(branch)}`);
      }
    }
  };
  emit(graph.trunk);
  return `${lines.join("\n")}\n`;
}
