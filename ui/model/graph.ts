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
  /** This is the thread checked out in the project folder (exactly one thread has it): its files are the ones open in the editor. */
  checkedOut: Type.Optional(Type.Boolean()),
  /** The person put it away (see `Conversation.archive`): the graph leaves it out unless asked. Any new entry on it brings it back. */
  archived: Type.Optional(Type.Boolean()),
  /** It has been merged back (a `fork_merge` or `subagent_result` entry exists). */
  merged: Type.Optional(Type.Boolean()),
  /** Background jobs running on it: how many, and whether any has a time limit (otherwise they are all servers or watchers). Absent when none run. */
  jobs: Type.Optional(strictObject({ count: Type.Integer({ minimum: 1 }), timed: Type.Boolean() })),
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

/** One git repository in the workspace, as the repository picker lists it. */
export const repoEntry = strictObject({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  /** Where it is, shortened for display. */
  path: Type.String(),
  /** Whether it holds a chattree conversation; a repository that does not is listed but cannot be chosen. */
  chattree: Type.Boolean(),
  /** The folder is a repository attached to the conversation above it (ADR 38): its path from there. Choosing it opens that conversation. */
  attachedAs: Type.Optional(Type.String()),
  /** Why it cannot be chosen. */
  reason: Type.Optional(Type.String()),
  /**
   * A workspace folder that can be made into one: `new` makes a git repository in the folder, `adopt` starts the
   * conversation on the checked-out branch of the repository that already holds it (every entry then also commits the
   * working tree's pending changes, which is why the person is asked first). Absent when it cannot be done.
   */
  init: Type.Optional(Type.Enum(["new", "adopt"])),
});
export type RepoEntry = Static<typeof repoEntry>;

export const repoList = strictObject({
  repos: Type.Array(repoEntry),
  /** The repository whose graph is shown. */
  current: Type.Optional(Type.String()),
});
export type RepoList = Static<typeof repoList>;
