/** The options, results and reports of the operations of a `Conversation` (see `conversation.ts`). */
/**
 * A conversation: one thread, which is the transcript `chat.yml` committed on a branch of a Git repository, and the
 * `Conversation` handle through which everything that changes it goes. Each append commits the entry together with the
 * workspace changes since the last commit, so the transcript and the files stay in step. Forks, subagents and new
 * threads are branches, each with its own worktree; merges are trunk-wins and recorded as entries. Opening repairs what a
 * crash left (a torn append, uncommitted entries, an unfinished request journal). Every other module reads or writes the
 * thread through this class, and the harness modules that work on a thread (loop, pump, turn) are its callers.
 */

import { type Identity, type LockOptions, type TreeEdit } from "../src/index.ts";
import { type AttachedState, type RestoreResult } from "./attached.ts";
import { LeaseStore, type LeaseOwner } from "./lease.ts";
import { type SecretSource } from "./secrets.ts";
import { type AdapterRegistry, type BuiltProviders } from "../providers/registry.ts";
import { type IndexCache } from "./index-cache.ts";
import { type ChatEntry, type PipelineConfig } from "./entries.ts";
import { type Classifier } from "./setup.ts";
import type { Conversation } from "./conversation.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An entry to append. The id is assigned if omitted (headers have none). */
export type NewEntry = DistributiveOmit<ChatEntry, "id"> & { id?: string };

export interface ConversationOptions {
  /**
   * `enforce` (the default): `harness.yml` is used only while it is the file the user approved for this thread
   * (`approveConfig`, `trust.ts`). Otherwise the thread opens without providers, `readConfig` says why it has none, no
   * grant counts, and the loop refuses (`ConfigNotTrusted`). `ignore` is for hosts that decide for themselves.
   */
  configTrust?: "enforce" | "ignore";
  /** Used as committer, and as author for entries that are neither the user's nor the model's. */
  committer?: Identity;
  /** Author of user entries. Defaults to the committer. */
  user?: Identity;
  /** Large-value threshold and secret patterns for the write pipeline. The blob store is always the repository's `blobs/`. */
  pipeline?: Omit<PipelineConfig, "store">;
  lock?: LockOptions;
  /**
   * Tells whether the process that holds a run lease is gone (the same machine and no such pid): such a lease is taken
   * over at once instead of when its deadline passes. Without it only the deadline says.
   */
  isOwnerDead?: (owner: LeaseOwner) => boolean;
  /** The lease store to use instead of the process's shared one: for tests that stand in for several processes. */
  leases?: LeaseStore;
  /** Clock for ids, commit dates and locks (tests). */
  now?: () => number;
  /** Fix commit dates from `now`. Default: git's own clock. */
  fixedDates?: boolean;
  /**
   * Called for everything that happens to the conversation, in order, after it is committed (see `ConversationEvent`).
   * Handles opened for other branches (forks, subagents) inherit it. Delivery is asynchronous and never delays or
   * fails the operation that caused the event; `flushEvents()` waits for it.
   */
  onEvent?: (event: ConversationEvent) => void | Promise<void>;
  /** Told when `onEvent` throws or rejects. Default: ignored. */
  onEventError?: (error: unknown, event: ConversationEvent) => void;
  /**
   * Where to keep the entry index between runs, so opening a long conversation need not walk its whole history.
   * Default: a file under the repository's git directory. `false` keeps it in memory only.
   */
  indexCache?: IndexCache | false;
  /** What a setup change does beyond what the harness can tell itself (cache, cost, capabilities): the provider adapter's `classify`. */
  classify?: Classifier;
  /**
   * The adapters that may appear in `harness.yml`, and where secrets come from. With it, `create` and `open` validate
   * every provider against its adapter's schema, resolve the environment variables it names (a missing one is an error
   * naming the variable and the provider, here and not at the first request), build the adapters (`convo.providers`),
   * redact every resolved secret from what is written to the transcript, and write the editor schema.
   */
  providers?: { registry: AdapterRegistry; secrets: SecretSource };
  /**
   * How long a request's journal may go without a write before `open` takes its owner to be dead and recovers it
   * (the journal is touched at least every 15 s while a request runs). Default 60 s; 0 recovers any journal at once,
   * which is only right when no other process can be streaming on the branch.
   */
  journalStaleMs?: number;
  /** How long `open` waits for a provider to hand back a stored response while recovering. Default 10 s. */
  recoveryTimeoutMs?: number;
  /** Set by `open` so forks and subagents share the adapters (and their concurrency limits). Not for callers. */
  built?: BuiltProviders;
}

/** Something that happened to a conversation. Events are delivered after the change is committed, in order. */
export type ConversationEvent =
  /** An entry was committed (also on a new branch's first entry). `recovered` entries were found uncommitted by `open`. */
  | {
      type: "entry";
      branch: string;
      entry: Appended;
      value: ChatEntry;
      recovered?: true;
      /** Another process appended it (see `Conversation.sync`). */ foreign?: true;
    }
  /**
   * An `agent_setup` entry was committed. For `reason: provider` this is the host's cue to tell the user ("the provider
   * changed the model to X").
   */
  | { type: "setup_changed"; branch: string; entry: Appended; value: Extract<ChatEntry, { $tag: "agent_setup" }> }
  /** Pending workspace changes were committed without an entry. */
  | { type: "snapshot"; branch: string; commit: string }
  /** A fork or subagent branch was created. */
  | { type: "branch"; branch: string; kind: "fork" | "subagent"; parent: string; from: string; start: Appended }
  /** A fork or subagent was merged into `branch`. */
  | { type: "merge"; branch: string; child: string; kind: "subagent" | "fork"; entry: Appended; report: MergeReport }
  /** `open` repaired something a crash left behind. */
  | { type: "recovery"; branch: string; report: RecoveryReport }
  /** The repository was repacked (see `Conversation.maintain`). */
  | { type: "maintenance"; branch: string; report: MaintenanceReport };

/** What `Conversation.activity` reports. */
export type Activity =
  | { state: "idle" }
  | {
      state: "request";
      live: boolean;
      since: number;
      provider: string;
      model: string;
      owner?: { pid?: number; host?: string; session?: string };
      nonce?: string;
      lastWrite?: number;
    };

export interface RepoStats {
  looseObjects: number;
  packs: number;
  /** Bytes on disk taken by loose objects and packs. */
  bytes: number;
}

export interface MaintenanceReport {
  action: "none" | "pack_loose" | "consolidate";
  before: RepoStats;
  after: RepoStats;
}

export interface CreateOptions extends ConversationOptions {
  /** Name of the first branch. Default "main". */
  branch?: string;
  /** Initial `harness.yml` text. Validated and written with the header commit. */
  config?: string;
}

export interface CompactOptions {
  /** The first entry replaced: an id visible in the current context (see `contextEntries`). */
  from: string;
  /** The last entry replaced. */
  to: string;
  summary: string;
  /** The model that wrote the summary. */
  model?: string;
  /** What writing it used, so the ledger counts it. */
  usage?: Record<string, number>;
  /** Who asked for it. Default: the user. */
  by?: "user" | "auto";
}

export interface InterruptOptions {
  by: "user" | "error";
  /** Blocks received before the interruption; may be incomplete (a tool call with partial arguments). */
  partial?: Extract<NewEntry, { $tag: "interrupted" }>["partial"];
  error?: string;
  /** Tokens of the partial response (billed even though it was cut off), in the normalised names of `assistant.usage`. */
  usage?: Record<string, number>;
  /**
   * Runs under the branch lock just before the entry is written; throwing from it stops the write (the turn runner checks
   * its journal is still its own).
   */
  guard?: () => Promise<void>;
}

export interface Appended {
  id: string;
  tag: string;
  commit: string;
  /** Length of the transcript after this entry. */
  offset: number;
}

export interface RecoveryReport {
  /** Bytes of an incomplete entry removed from the end of the transcript. */
  truncatedBytes: number;
  /** Entries that were complete but never committed; each is now committed. */
  recovered: Appended[];
  /**
   * Leftovers of interrupted work that `open` removed (temporary files, stale lock remnants), as repository-relative or
   * `.git/` paths.
   */
  cleaned: string[];
  /** What was done about a request that was in flight when the process died. */
  journal?: JournalRecovery;
}

export interface JournalRecovery {
  /**
   * - `completed`: the stream had finished; its response is now committed.
   * - `retrieved`: the provider still had the response; it was fetched and committed.
   * - `interrupted`: what had been received is committed as an `interrupted` entry (`by: error`).
   * - `already_committed`: the process died after the commit; the journal was only deleted.
   * - `discarded`: nothing worth recording had arrived (or the journal could not be used); it was deleted.
   * - `in_flight`: the journal is recent, so another process may still be running the request; it was left alone.
   */
  outcome: "completed" | "retrieved" | "interrupted" | "already_committed" | "discarded" | "in_flight";
  entries: Appended[];
  note?: string;
}

/** An entry's place in a branch's history. */
export interface EntryRef {
  /** Undefined for the header, which has no id. */
  id: string | undefined;
  tag: string;
  commit: string;
  /** Length of the transcript up to and including this entry. */
  offset: number;
}

export interface ForkOptions {
  /** Branch name. Default `fork/<new ulid>`. */
  name?: string;
  /** Also check the new branch out in a worktree and return a handle for it. Default true. */
  checkout?: boolean;
  /** Where to check it out. Default: `<dir>.branches/<encoded branch name>`. */
  worktree?: string;
  /** How code in attached repositories is meant to come back (see `branch_start.integrate`). Default: shared. */
  integrate?: "share" | "thread" | "parent";
}

export interface ForkResult {
  branch: string;
  /** The first commit on the new branch: the fork point plus its `branch_start` entry. */
  start: Appended;
  /** The commit the branch was forked from. */
  from: string;
  /** A handle on the new branch's worktree (when `checkout` is not false). */
  conversation: Conversation | undefined;
  /** What was done to give the worktree its own copy of each attached repository (ADR 38). */
  attached?: RestoreResult[];
}

export interface SpawnOptions {
  /** The task, as the subagent's first message. */
  brief: string;
  /** The tool call in this conversation that started the subagent. */
  callId: string;
  /** Branch name. Default `sub/<new ulid>`. */
  name?: string;
  /** Branch from this entry instead of the current state of the workspace. */
  from?: string | EntryRef;
  checkout?: boolean;
  worktree?: string;
  /** How code in attached repositories is meant to come back (see `branch_start.integrate`). Default: shared. */
  integrate?: "share" | "thread" | "parent";
}

export interface FinishOptions {
  /** What the subagent reports back. */
  summary: string;
  /** The tool call that started the subagent. */
  callId: string;
  /** Remove the subagent's worktree once it is merged (its branch and history stay). Default false. */
  removeWorktree?: boolean;
}

export interface MergeConflict {
  path: string;
  /** Git's conflict kind: `content`, `modify/delete`, `file/directory`, `add/add`, ... */
  kind: string;
}

export interface MergeReport {
  /** Child changes that were merged into this branch, as modified/deleted paths. */
  changed: string[];
  /** Child additions that were merged. */
  added: string[];
  /** Files the child changed whose version was dropped because this branch's version won a conflict. */
  discarded: string[];
  conflicts: MergeConflict[];
  /** The commit the child diverged from. */
  base: string;
}

export interface MergeOutcome {
  /** The `subagent_result` or `fork_merge` entry, committed as a merge commit. */
  entry: Appended;
  report: MergeReport;
  /** The tip of the child's branch that was merged. */
  childTip: string;
  /** What came of the code in attached repositories (ADR 38); empty when none changed. */
  code: CodeResult[];
  /** What was done to the receiving thread's checkouts of them. */
  attached: RestoreResult[];
}

/** One attached repository's code in a merge, as recorded in the merge entry. */
export interface CodeResult {
  path: string;
  outcome: "merged_state" | "fast_forward" | "left";
  branch?: string;
  note: string;
}
export type SubagentOutcome = MergeOutcome;

export interface CodePlan {
  /** Edits to the merged tree: the gitlinks as the decision has them, and the record. */
  edits: TreeEdit[];
  results: CodeResult[];
  /** The states the receiving thread's checkouts are put to once the merge is in. */
  apply: AttachedState[];
}

export interface MergeForkOptions {
  /** What was discussed and decided in the fork. */
  summary: string;
  /** Remove the fork's worktree once it is merged (its branch and history stay). Default false. */
  removeWorktree?: boolean;
  /** The `merge` tool call this merge answers (the entry then stands in for the call's result). */
  callId?: string;
}

export interface BlobGcOptions {
  /** Report what would be removed without removing anything. */
  dryRun?: boolean;
}

export interface BlobGcReport {
  /** Unreferenced blob files that were never committed. */
  untracked: { path: string; bytes: number }[];
  /**
   * Unreferenced blob files that had been committed (by a later entry's commit, after a failed append). They are removed
   * in a new commit.
   */
  tracked: { path: string; bytes: number }[];
  /** The commit that removed the tracked ones, if there were any. */
  commit: string | undefined;
}

export interface SwitchWorkspaceOptions {
  /** What to do with unsaved changes in either folder: `snapshot` saves them on the thread they belong to. Without it, they stop the switch. */
  uncommitted?: "snapshot";
  /** Git-ignored files: swap them between the folders (`move`) or leave them. Default: `workspace.switch.ignored` in harness.yml, else `move`. */
  ignored?: "move" | "leave";
}

export interface SwitchWorkspaceResult {
  /** The thread the project folder was on, and the one it is on now. */
  from: string;
  to: string;
  /** The project folder, and where `from` is checked out now (undefined when `to` had no worktree to trade with). */
  project: string;
  fromWorktree: string | undefined;
  /** Snapshots taken on the way. */
  snapshots: { branch: string; commit: string }[];
  /** Ignored entries traded, and those left with the reason. */
  moved: string[];
  left: { name: string; reason: string }[];
  /** What was done to the attached repositories (ADR 38); empty when there are none. */
  attached: RestoreResult[];
}

export interface WorktreeCleanup {
  removed: { branch: string; path: string }[];
  kept: { branch: string; path: string; reason: string }[];
}

export interface BranchInfo {
  name: string;
  tip: string;
  /** Where the branch is checked out, if anywhere. */
  worktree: string | undefined;
  /** The newest commit is an archive marker (see `Conversation.archive`): hide the thread from default listings. */
  archived: boolean;
  /** When the newest commit was made (ISO 8601), the thread's last activity. */
  lastActivity: string;
  /** A request is in flight on the branch (its journal is live). */
  running: boolean;
}
