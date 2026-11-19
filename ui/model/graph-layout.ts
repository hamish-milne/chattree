/**
 * Lays a thread graph out for drawing: which rows there are (newest first), which lane each sits in, and the edges
 * between them. Runs of tool calls and their results fold into one row unless the person expanded them. Pure and
 * deterministic: the same data and expansion give the same layout, so it is tested without a view.
 *
 * Lanes are packed: the trunk is lane 0, a thread takes the lowest free lane when its first commit appears, and a
 * thread that was merged back gives its lane up at the merge, so a long conversation does not grow wider.
 */
import { nth } from "../../src/nth.ts";
import type { GraphCommit, GraphData } from "./graph.ts";

/** One commit shown as a row. */
export interface CommitRow {
  type: "commit";
  /** The commit hash. */
  id: string;
  lane: number;
  thread: string;
  commit: GraphCommit;
  /** This row is the tip of that thread (it carries the thread's status). */
  tipOf: string | undefined;
  /** The id of the expanded fold this row belongs to, so the view can show a way to collapse it. */
  foldId: string | undefined;
}

/** Several commits (a chain of tool calls and results) shown as one row. */
export interface FoldRow {
  type: "fold";
  /** `fold:` and the hash of its oldest commit; stable while the chain grows at the tip. */
  id: string;
  lane: number;
  thread: string;
  /** The commits it stands for, oldest first. */
  commits: GraphCommit[];
  /** How many tool calls the chain made. */
  calls: number;
  tipOf: string | undefined;
}

export type GraphRow = CommitRow | FoldRow;

/** A line from a newer row to the older row it follows from. */
export interface GraphEdge {
  /** Indexes into `rows`; `from` is above `to`. */
  from: number;
  to: number;
  fromLane: number;
  toLane: number;
  /** The thread the line is coloured as: the child's, except a merge, which is coloured as the thread merged in. */
  thread: string;
  /**
   * Where the line changes lane. A fork leaves its parent's lane at the parent (`bottom`); a merge leaves its own
   * lane at the merge commit (`top`). Irrelevant when the lanes are equal.
   */
  bend: "bottom" | "top";
}

export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  lanes: number;
  /** The row that shows a commit (a folded commit is shown by its fold). */
  rowOf: ReadonlyMap<string, number>;
}

/** The kinds that can be part of a chain of tool calls after the assistant entry that made them. */
const IN_CHAIN = new Set(["tool_result", "approval", "job_event"]);

const callsOf = (c: GraphCommit): number => c.toolCalls ?? 0;

/** Groups of consecutive commits on one thread that make a chain: tool calls, results, more calls, more results. */
function chains(data: GraphData): GraphCommit[][] {
  // A commit another thread (or a merge's second parent) points at has to stay a row's end, or the line to it has
  // nowhere to land.
  const pointedAt = new Set<string>();
  const byHash = new Map(data.commits.map((c) => [c.hash, c]));
  for (const c of data.commits) {
    for (const [i, p] of c.parents.entries()) {
      const parent = byHash.get(p);
      if (i > 0 || (parent !== undefined && parent.thread !== c.thread)) pointedAt.add(p);
    }
  }
  const out: GraphCommit[][] = [];
  const byThread = new Map<string, GraphCommit[]>();
  for (const c of data.commits) {
    const list = byThread.get(c.thread);
    if (list === undefined) byThread.set(c.thread, [c]);
    else list.push(c);
  }
  for (const commits of byThread.values()) {
    let run: GraphCommit[] = [];
    const flush = (): void => {
      if (run.length >= 2) out.push(run);
      run = [];
    };
    for (const c of commits) {
      const starts = c.kind === "assistant" && callsOf(c) > 0;
      const continues = run.length > 0 && (IN_CHAIN.has(c.kind) || starts);
      if (starts || continues) {
        if (run.length === 0 || continues) run.push(c);
        // A commit that others point at ends the chain it is in.
        if (pointedAt.has(c.hash)) flush();
      } else flush();
    }
    flush();
  }
  return out;
}

export function layoutGraph(data: GraphData, expanded: ReadonlySet<string> = new Set()): GraphLayout {
  const tipOf = new Map(data.threads.map((t) => [t.tip, t.name]));
  const chainOf = new Map<string, GraphCommit[]>();
  for (const run of chains(data)) for (const c of run) chainOf.set(c.hash, run);

  // Rows, oldest first. A folded chain becomes one row at the position of its newest commit.
  const rowsOldest: GraphRow[] = [];
  const emitted = new Set<GraphCommit[]>();
  for (const c of data.commits) {
    const run = chainOf.get(c.hash);
    const last = run === undefined ? undefined : nth(run, run.length - 1);
    const foldId = run === undefined ? undefined : `fold:${nth(run, 0).hash}`;
    if (run !== undefined && foldId !== undefined && !expanded.has(foldId)) {
      if (c !== last || emitted.has(run)) continue;
      emitted.add(run);
      rowsOldest.push({
        type: "fold",
        id: foldId,
        lane: 0,
        thread: c.thread,
        commits: run,
        calls: run.reduce((n, x) => n + callsOf(x), 0),
        tipOf: tipOf.get(c.hash),
      });
    } else rowsOldest.push({ type: "commit", id: c.hash, lane: 0, thread: c.thread, commit: c, tipOf: tipOf.get(c.hash), foldId });
  }

  // Lanes, oldest first.
  const laneOf = new Map<string, number>([[data.trunk, 0]]);
  const free = (): number => {
    const used = new Set(laneOf.values());
    let l = 1;
    while (used.has(l)) l++;
    return l;
  };
  let lanes = 1;
  const hashesOf = (r: GraphRow): GraphCommit[] => (r.type === "fold" ? r.commits : [r.commit]);
  const byHash = new Map(data.commits.map((c) => [c.hash, c]));
  for (const r of rowsOldest) {
    if (!laneOf.has(r.thread)) laneOf.set(r.thread, free());
    r.lane = laneOf.get(r.thread) ?? 0;
    lanes = Math.max(lanes, r.lane + 1);
    // A merge gives up the lane of the thread it took in, once that thread's last commit has been reached.
    for (const c of hashesOf(r)) {
      for (const p of c.parents.slice(1)) {
        const merged = byHash.get(p);
        if (merged !== undefined && merged.thread !== data.trunk && merged.thread !== c.thread && tipOf.get(p) === merged.thread)
          laneOf.delete(merged.thread);
      }
    }
  }

  const rows = rowsOldest.reverse();
  const rowOf = new Map<string, number>();
  for (const [i, r] of rows.entries()) for (const c of hashesOf(r)) rowOf.set(c.hash, i);

  const edges: GraphEdge[] = [];
  for (const c of data.commits) {
    const from = rowOf.get(c.hash);
    if (from === undefined) continue;
    const fromRow = nth(rows, from);
    for (const [i, p] of c.parents.entries()) {
      const to = rowOf.get(p);
      if (to === undefined || to === from) continue;
      const toRow = nth(rows, to);
      const parent = byHash.get(p);
      edges.push({
        from,
        to,
        fromLane: fromRow.lane,
        toLane: toRow.lane,
        thread: i > 0 && parent !== undefined ? parent.thread : c.thread,
        bend: i > 0 ? "top" : "bottom",
      });
    }
  }
  return { rows, edges, lanes, rowOf };
}
