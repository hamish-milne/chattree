/**
 * What the thread graph view is given: a conversation's commits placed on threads, and what each thread is doing.
 * This is the UI core's picture of `harness/graph.ts` (the controller maps one to the other); it holds plain data
 * only, so it crosses the message boundary as it is. Layout (lanes, folded tool chains) is computed from it in the
 * view, because which chains are folded is view state.
 */
import { Type, type Static } from "typebox";
import { pattern, strictObject } from "../../src/validate.ts";

const count = Type.Integer({ minimum: 0 });

export const THREAD_STATUSES = ["idle", "running", "awaiting", "error", "elsewhere"] as const;
/**
 * What a thread is doing: `running` is a request in flight here, `awaiting` is waiting for the person (an approval
 * or a question), `error` is stopped by a failure, `elsewhere` is held by another process, `idle` is none of these.
 */
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_KINDS = ["main", "fork", "subagent"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** What a commit is: an entry's type, or `other` for snapshots and plain commits. */
export const GRAPH_KINDS = [
  "header",
  "user",
  "assistant",
  "tool_result",
  "approval",
  "compaction",
  "trim",
  "agent_setup",
  "injection",
  "branch_start",
  "subagent_result",
  "fork_merge",
  "job_event",
  "interrupted",
  "other",
] as const;
export type GraphKind = (typeof GRAPH_KINDS)[number];

/** A commit hash as the git layer reports it, full or abbreviated. */
export const hash = pattern(/^[0-9a-f]{7,64}$/, "not a commit hash");

export const graphThread = strictObject({
  name: Type.String({ minLength: 1 }),
  kind: Type.Enum(THREAD_KINDS),
  status: Type.Enum(THREAD_STATUSES),
  tip: hash,
  /** A person-readable label (the first message, or a name the person gave). */
  title: Type.Optional(Type.String()),
  /** The model it runs, as shown in a label. */
  model: Type.Optional(Type.String()),
  /** Where it was forked from. Absent for the main thread. */
  from: Type.Optional(hash),
  /** It has been merged back (a `fork_merge` or `subagent_result` entry exists). */
  merged: Type.Optional(Type.Boolean()),
});
export type GraphThread = Static<typeof graphThread>;

export const graphCommit = strictObject({
  hash,
  parents: Type.Array(hash),
  /** The thread whose first-parent line this commit is on. */
  thread: Type.String({ minLength: 1 }),
  kind: Type.Enum(GRAPH_KINDS),
  /** A short description of the entry, for a label. */
  summary: Type.String(),
  /** When it was committed (ISO 8601). */
  time: Type.String(),
  /** For an assistant entry: how many tool calls it made. This is what lets a chain of calls and results fold into one row. */
  toolCalls: Type.Optional(count),
  /** What the request that produced it cost, when it was priced. */
  usd: Type.Optional(Type.Number({ minimum: 0 })),
});
export type GraphCommit = Static<typeof graphCommit>;

export const graphData = strictObject({
  /** The thread the others hang off. */
  trunk: Type.String({ minLength: 1 }),
  /** Trunk first, then in order of creation. */
  threads: Type.Array(graphThread),
  /** Oldest first, so a commit's parents come before it. */
  commits: Type.Array(graphCommit),
});
export type GraphData = Static<typeof graphData>;
