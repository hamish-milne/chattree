/**
 * The commit graph as the graph view gets it: `harness/graph.ts` (which commit belongs to which thread, and what each
 * says) plus what is known about each thread from outside the history (its status, whether it was merged or archived, which
 * one is checked out). Pure: the controller reads these and hands them over.
 */

import type { CommitGraph } from "../../harness/graph.ts";
import type { BranchInfo } from "../../harness/conversation.ts";
import { GRAPH_KINDS, type GraphCommit, type GraphData, type GraphKind, type GraphThread, type ThreadStatus } from "../model/graph.ts";

export interface GraphInput {
  graph: CommitGraph;
  branches: readonly BranchInfo[];
  /** Threads that were merged into another (`Conversation.mergedBranches`). */
  merged: ReadonlySet<string>;
  /** The thread checked out in the project folder. */
  checkedOut?: string | undefined;
  /** What each thread is doing; one not listed is `running` if its journal is live and `idle` otherwise. */
  statuses?: ReadonlyMap<string, ThreadStatus>;
  /** Background jobs running on each thread. */
  jobs?: ReadonlyMap<string, { count: number; timed: boolean }>;
  /** A name the person gave a thread; otherwise its first message is the label. */
  titles?: ReadonlyMap<string, string>;
  /** The model each thread runs, as a label. */
  models?: ReadonlyMap<string, string>;
  /** What the request behind a commit cost, by commit hash. */
  usd?: ReadonlyMap<string, number>;
}

const kindOf = (k: string): GraphKind => GRAPH_KINDS.find((g) => g === k) ?? "other";

const USER = /^user: /;

export function mapGraph(i: GraphInput): GraphData {
  const names = new Set(i.graph.branches.map((b) => b.name));
  // Commits reached only through a merge's second parent have no thread of their own: the view cannot place them.
  const placed = i.graph.commits.filter((c) => names.has(c.branch));
  const hashes = new Set(placed.map((c) => c.hash));
  const info = new Map(i.branches.map((b) => [b.name, b]));

  const commits: GraphCommit[] = placed.map((c) => {
    const usd = i.usd?.get(c.hash);
    return {
      hash: c.hash,
      parents: c.parents.filter((p) => hashes.has(p)),
      thread: c.branch,
      kind: kindOf(c.kind),
      summary: c.summary,
      time: c.time,
      ...(c.toolCalls === undefined || c.toolCalls === 0 ? {} : { toolCalls: c.toolCalls }),
      ...(usd === undefined ? {} : { usd }),
    };
  });

  const threads: GraphThread[] = i.graph.branches.map((b) => {
    const own = placed.filter((c) => c.branch === b.name);
    const start = own.find((c) => c.branchKind !== undefined);
    const first = own[0];
    const from = b.name === i.graph.trunk ? undefined : first?.parents[0];
    const label = i.titles?.get(b.name) ?? own.find((c) => c.kind === "user")?.summary.replace(USER, "");
    const model = i.models?.get(b.name);
    const bi = info.get(b.name);
    return {
      name: b.name,
      kind: b.name === i.graph.trunk ? "main" : (start?.branchKind ?? "fork"),
      status: i.statuses?.get(b.name) ?? (bi?.running === true ? "running" : "idle"),
      tip: b.tip,
      ...(label === undefined || label === "" ? {} : { title: label }),
      ...(model === undefined ? {} : { model }),
      ...(from !== undefined && hashes.has(from) ? { from } : {}),
      ...(i.checkedOut === b.name ? { checkedOut: true } : {}),
      ...(bi?.archived === true ? { archived: true } : {}),
      ...(i.merged.has(b.name) ? { merged: true } : {}),
      ...jobsOf(i.jobs?.get(b.name)),
    };
  });
  return { trunk: i.graph.trunk, threads, commits };
}

const jobsOf = (j: { count: number; timed: boolean } | undefined): { jobs?: { count: number; timed: boolean } } =>
  j === undefined ? {} : { jobs: j };
