import { editConfig, parseConfig, type ConfigResult } from "../src/config.ts";
import {
  FrameError,
  Git,
  GitError,
  ParseError,
  decodeSpan,
  hashValue,
  acquireLock,
  encodeEntry,
  endsCleanly,
  parseFile,
  scan,
  type DecodeResult,
  type DiffEntry,
  type Host,
  type Identity,
  type LockOptions,
  type MergeTreeResult,
  type Pipeline,
} from "../src/index.ts";
import { BLOBS_DIR, HostBlobStore, RecordingBlobStore, blobRefs } from "./blob-store.ts";
import { harnessConfig, type HarnessConfig } from "./config.ts";
import { FileIndexCache, type IndexCache } from "./index-cache.ts";
import { contextEntries } from "./context.ts";
import { FORMAT, createPipeline, type ChatEntry, type PipelineConfig } from "./entries.ts";
import { createUlid } from "./ulid.ts";

/** The transcript, relative to the repository root. */
export const CHAT_FILE = "chat.yml";
export { BLOBS_DIR };
/** The harness configuration, relative to the repository root. */
export const CONFIG_FILE = "harness.yml";

const GITATTRIBUTES = `# Transcripts are byte-exact: never convert line endings.
* -text
# Branches diverge by appending to the transcript; a merge keeps the receiving branch's version.
${CHAT_FILE} merge=ours
`;

export class ConversationError extends Error {
  override name = "ConversationError";
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An entry to append. The id is assigned if omitted (headers have none). */
export type NewEntry = DistributiveOmit<ChatEntry, "id"> & { id?: string };

export interface ConversationOptions {
  /** Used as committer, and as author for entries that are neither the user's nor the model's. */
  committer?: Identity;
  /** Author of user entries. Defaults to the committer. */
  user?: Identity;
  /** Large-value threshold and secret patterns for the write pipeline. The blob store is always the repository's `blobs/`. */
  pipeline?: Omit<PipelineConfig, "store">;
  lock?: LockOptions;
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
}

/** Something that happened to a conversation. Events are delivered after the change is committed, in order. */
export type ConversationEvent =
  /** An entry was committed (also on a new branch's first entry). `recovered` entries were found uncommitted by `open`. */
  | { type: "entry"; branch: string; entry: Appended; value: ChatEntry; recovered?: true }
  /** Pending workspace changes were committed without an entry. */
  | { type: "snapshot"; branch: string; commit: string }
  /** A fork or subagent branch was created. */
  | { type: "branch"; branch: string; kind: "fork" | "subagent"; parent: string; from: string; start: Appended }
  /** A fork or subagent was merged into `branch`. */
  | { type: "merge"; branch: string; child: string; kind: "subagent" | "fork"; entry: Appended; report: MergeReport }
  /** `open` repaired something a crash left behind. */
  | { type: "recovery"; branch: string; report: RecoveryReport };

export interface CreateOptions extends ConversationOptions {
  /** Name of the first branch. Default "main". */
  branch?: string;
  /** Initial `harness.yml` text. Validated, written, and recorded as the first `config_changed`. */
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
}

export interface InterruptOptions {
  by: "user" | "error";
  /** Blocks received before the interruption; may be incomplete (a tool call with partial arguments). */
  partial?: Extract<NewEntry, { $tag: "interrupted" }>["partial"];
  error?: string;
}

export interface ConfigStatus {
  /** Hash of the validated `harness.yml`, or undefined if the file is missing or invalid. */
  current: string | undefined;
  /** The last hash recorded by a `config_changed` entry on this branch (the hash of an empty config if none). */
  recorded: string;
  inSync: boolean;
  /** Why the file could not be read, if it could not. */
  issues: { path: string; message: string }[];
}

export interface ConfigChange {
  /** False if the configuration's data did not change (a comment-only edit changes the file but records nothing). */
  changed: boolean;
  hash: string;
  entry: Appended | undefined;
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
  /** Leftovers of interrupted work that `open` removed (temporary files, stale lock remnants), as repository-relative or `.git/` paths. */
  cleaned: string[];
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
}

export interface ForkResult {
  branch: string;
  /** The first commit on the new branch: the fork point plus its `branch_start` entry. */
  start: Appended;
  /** The commit the branch was forked from. */
  from: string;
  /** A handle on the new branch's worktree (when `checkout` is not false). */
  conversation: Conversation | undefined;
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
}
export type SubagentOutcome = MergeOutcome;

export interface MergeForkOptions {
  /** What was discussed and decided in the fork. */
  summary: string;
  /** Remove the fork's worktree once it is merged (its branch and history stay). Default false. */
  removeWorktree?: boolean;
}

export interface BlobGcOptions {
  /** Report what would be removed without removing anything. */
  dryRun?: boolean;
}

export interface BlobGcReport {
  /** Unreferenced blob files that were never committed. */
  untracked: { path: string; bytes: number }[];
  /** Unreferenced blob files that had been committed (by a later entry's commit, after a failed append). They are removed in a new commit. */
  tracked: { path: string; bytes: number }[];
  /** The commit that removed the tracked ones, if there were any. */
  commit: string | undefined;
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
}

const DEFAULT_COMMITTER: Identity = { name: "chattree", email: "chattree@localhost.invalid" };
const enc = new TextEncoder();
const dec = new TextDecoder();

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function oneLine(s: string, max: number): string {
  // Control characters and Unicode line separators become spaces (built from code points to keep this file ASCII).
  let flat = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    flat += c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 ? " " : ch;
  }
  flat = flat.replace(/ +/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 3).join("")}...` : flat;
}

/** Commit subject for an entry: readable in `git log --oneline`. */
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
    case "config_changed":
      return "config changed";
    case "branch_start":
      return `branch_start: ${e.kind}`;
    case "subagent_result":
      return `subagent_result: ${oneLine(e.branch, 40)}`;
    case "fork_merge":
      return `fork_merge: ${oneLine(e.branch, 40)}`;
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
  const discarded = changes.filter((c) => conflicted.has(c.path)).map((c) => c.path).sort(byPath);
  const landed = changes.filter((c) => !conflicted.has(c.path));
  const conflicts: MergeConflict[] = [];
  for (const [path, ks] of kinds) if (touched.has(path)) for (const kind of ks) conflicts.push({ path, kind });
  conflicts.sort((a, b) => byPath(a.path, b.path) || byPath(a.kind, b.kind));
  return {
    changed: landed.filter((c) => c.status !== "A").map((c) => c.path).sort(byPath),
    added: landed.filter((c) => c.status === "A").map((c) => c.path).sort(byPath),
    discarded,
    conflicts,
  };
}

/**
 * One branch of a conversation repository. Every mutation is a transaction: serialize within the process,
 * take the branch's lock file, check the transcript is exactly as we last left it, write, stage, commit; if
 * anything fails the transcript is restored from HEAD.
 */
export class Conversation {
  readonly host: Host;
  readonly git: Git;
  readonly dir: string;
  readonly branch: string;
  readonly pipeline: Pipeline<ChatEntry>;
  readonly store: HostBlobStore;
  /** What the last `open` had to repair. */
  readonly recovery: RecoveryReport;

  readonly #opts: ConversationOptions;
  readonly #file: string;
  readonly #lockPath: string;
  readonly #nextId: () => string;
  #size: number;
  #queue: Promise<unknown> = Promise.resolve();
  #head: string | undefined;
  #idx: { tip: string; refs: EntryRef[] } | undefined;
  #cache: IndexCache | undefined;
  #cacheReady = false;
  #delivery: Promise<void> = Promise.resolve();

  private constructor(host: Host, git: Git, dir: string, branch: string, lockPath: string, opts: ConversationOptions, size: number, recovery: RecoveryReport) {
    this.host = host;
    this.git = git;
    this.dir = dir;
    this.branch = branch;
    this.#opts = opts;
    this.#lockPath = lockPath;
    this.#file = host.path.join(dir, CHAT_FILE);
    this.#size = size;
    this.recovery = recovery;
    this.store = new HostBlobStore(host, host.path.join(dir, BLOBS_DIR));
    this.pipeline = createPipeline({ ...opts.pipeline, store: this.store });
    this.#nextId = createUlid(opts.now);
  }

  /** Learn where HEAD is, so the entry index can be extended incrementally. */
  async #init(): Promise<this> {
    this.#head = await this.git.head();
    return this;
  }

  // ---- events ----------------------------------------------------------------------------------------------

  #emit(event: ConversationEvent): void {
    const handler = this.#opts.onEvent;
    if (handler === undefined) return;
    this.#delivery = this.#delivery.then(async () => {
      try {
        await handler(event);
      } catch (e) {
        try {
          this.#opts.onEventError?.(e, event);
        } catch {
          /* a failing error handler must not stop delivery */
        }
      }
    });
  }

  #emitEntry(branch: string, entry: Appended, value: ChatEntry, recovered = false): void {
    this.#emit({ type: "entry", branch, entry, value, ...(recovered ? { recovered: true as const } : {}) });
  }

  /** Resolves when every event emitted so far has been delivered to `onEvent`. */
  async flushEvents(): Promise<void> {
    await this.#delivery;
  }

  // ---- create / open ---------------------------------------------------------------------------------------

  /** Create a new conversation repository in `dir` (which must not already be a repository) with its header entry. */
  static async create(host: Host, dir: string, opts: CreateOptions = {}): Promise<Conversation> {
    if ((await host.fs.stat(host.path.join(dir, ".git"))) !== undefined) throw new ConversationError(`${dir} is already a git repository`);
    const git = await Git.init(host, dir, { branch: opts.branch ?? "main" });
    await git.setConfig("merge.ours.driver", "true");
    await host.fs.writeAtomic(host.path.join(dir, ".gitattributes"), enc.encode(GITATTRIBUTES));
    const branch = opts.branch ?? "main";
    const convo = await Conversation.#load(host, git, dir, branch, opts, 0, { truncatedBytes: 0, recovered: [], cleaned: [] });
    await convo.#transaction(async () => {
      await convo.#appendLocked({ $tag: "header", ...FORMAT });
    });
    if (opts.config !== undefined) await convo.setConfigText(opts.config);
    return convo;
  }

  /**
   * Open the conversation checked out in `dir`, repairing what a crash can leave behind: an incomplete entry at
   * the end of the transcript is removed, and complete entries that were never committed are committed.
   */
  static async open(host: Host, dir: string, opts: ConversationOptions = {}): Promise<Conversation> {
    const git = await Git.open(host, { cwd: dir });
    const branch = await git.currentBranch();
    if (branch === undefined) throw new ConversationError("HEAD is detached; check out the conversation's branch first");
    const gitDir = await git.gitDir();
    if ((await host.fs.stat(host.path.join(gitDir, "MERGE_HEAD"))) !== undefined) throw new ConversationError("a merge is in progress; finish or abort it first");
    const lockPath = await Conversation.#lockPathFor(host, git, branch);
    const lock = await acquireLock(host.fs, lockPath, { ...opts.lock, ...(opts.now === undefined ? {} : { now: opts.now }) });
    try {
      const cleaned = await Conversation.#tidy(host, git, dir, opts);
      const { size, report, recoveredEntries } = await Conversation.#recover(host, git, dir, opts);
      report.cleaned = cleaned;
      const convo = await Conversation.#load(host, git, dir, branch, opts, size, report);
      if (report.truncatedBytes > 0 || report.recovered.length > 0 || report.cleaned.length > 0) convo.#emit({ type: "recovery", branch, report });
      for (const [i, r] of report.recovered.entries()) convo.#emitEntry(branch, r, recoveredEntries[i] as ChatEntry, true);
      return convo;
    } finally {
      await lock.release();
    }
  }

  static async #load(host: Host, git: Git, dir: string, branch: string, opts: ConversationOptions, size: number, report: RecoveryReport): Promise<Conversation> {
    const lockPath = await Conversation.#lockPathFor(host, git, branch);
    return new Conversation(host, git, dir, branch, lockPath, opts, size, report).#init();
  }

  static async #lockPathFor(host: Host, git: Git, branch: string): Promise<string> {
    return host.path.join(await git.commonDir(), "chattree", "locks", `${encodeURIComponent(branch)}.lock`);
  }

  /**
   * Remove what an interrupted process leaves lying around: half-written temporary files (which would otherwise
   * be committed with the next entry), temporary git indexes, and lock files set aside by a takeover. Only
   * files that match our own naming and are not recent are touched.
   */
  static async #tidy(host: Host, git: Git, dir: string, opts: ConversationOptions): Promise<string[]> {
    const cleaned: string[] = [];
    const now = (opts.now ?? Date.now)();
    const older = async (path: string, ms: number): Promise<boolean> => {
      const mtime = (await host.fs.stat(path))?.mtimeMs;
      return mtime !== undefined && now - mtime > ms; // unknown or future times are left alone
    };
    const drop = async (path: string, label: string): Promise<void> => {
      if (await host.fs.remove(path).catch(() => false)) cleaned.push(label);
    };
    // Temporary files from atomic writes: only ever ours, and only in the working tree at the moment of a crash.
    const tmp = /\.tmp-[0-9a-f]{12}$/;
    for (const name of await host.fs.readdir(dir).catch(() => [] as string[])) {
      if (tmp.test(name)) await drop(host.path.join(dir, name), name);
    }
    for (const rel of (await git.listFiles([BLOBS_DIR], "untracked")).filter((p) => tmp.test(p))) await drop(host.path.join(dir, ...rel.split("/")), rel);
    const common = await git.commonDir();
    const gitTmp = host.path.join(common, "chattree", "tmp");
    for (const name of await host.fs.readdir(gitTmp).catch(() => [] as string[])) {
      if (/^index-[0-9a-f-]{36}$/.test(name) && (await older(host.path.join(gitTmp, name), 10 * 60_000))) await drop(host.path.join(gitTmp, name), `.git/chattree/tmp/${name}`);
    }
    const locks = host.path.join(common, "chattree", "locks");
    const staleAfter = opts.lock?.staleAfterMs ?? 30_000;
    for (const name of await host.fs.readdir(locks).catch(() => [] as string[])) {
      if (/\.lock\.stale-[0-9a-f]{8}$/.test(name) && (await older(host.path.join(locks, name), staleAfter))) await drop(host.path.join(locks, name), `.git/chattree/locks/${name}`);
    }
    return cleaned;
  }

  static async #recover(host: Host, git: Git, dir: string, opts: ConversationOptions): Promise<{ size: number; report: RecoveryReport; recoveredEntries: ChatEntry[] }> {
    const file = host.path.join(dir, CHAT_FILE);
    const committed = await git.readFileAt("HEAD", CHAT_FILE);
    if (committed === undefined) throw new ConversationError(`HEAD has no ${CHAT_FILE}: not a conversation repository`);
    const stat = await host.fs.stat(file);
    if (stat === undefined) throw new ConversationError(`${CHAT_FILE} is missing from the working tree (it is committed at HEAD)`);
    let disk = await host.fs.read(file);
    if (!startsWith(disk, committed)) {
      throw new ConversationError(`${CHAT_FILE} in the working tree does not extend the version at HEAD: it was edited, not appended to. Restore it with git, or commit the edit deliberately.`);
    }

    const report: RecoveryReport = { truncatedBytes: 0, recovered: [], cleaned: [] };
    const recoveredEntries: ChatEntry[] = [];
    let framed;
    try {
      framed = scan(disk);
    } catch (e) {
      if (e instanceof FrameError) throw new ConversationError(`${CHAT_FILE} is damaged: ${e.message}`);
      throw e;
    }
    if (framed.truncated) {
      report.truncatedBytes = disk.length - framed.validLength;
      await host.fs.truncate(file, framed.validLength);
      disk = disk.subarray(0, framed.validLength);
    }

    const pipeline = createPipeline(opts.pipeline ?? {});
    const pending = framed.spans.filter((s) => s.end > committed.length);
    if (pending.length > 0) {
      // Blobs written for these entries before the crash belong in the first recovery commit.
      if ((await host.fs.stat(host.path.join(dir, BLOBS_DIR))) !== undefined) await git.add([BLOBS_DIR]);
      // Validate everything first so a bad entry leaves the repository untouched.
      const decoded: { id: string; tag: string; entry: ChatEntry; end: number }[] = [];
      for (const span of pending) {
        const idx = framed.spans.indexOf(span);
        let parsed;
        try {
          parsed = decodeSpan(disk, span);
        } catch (e) {
          if (e instanceof ParseError) throw new ConversationError(`uncommitted entry ${idx + 1} in ${CHAT_FILE} is not valid: ${e.message}; fix or remove it`);
          throw e;
        }
        const r = await pipeline.decode(parsed);
        if (!r.ok) throw new ConversationError(`uncommitted entry ${idx + 1} in ${CHAT_FILE} is not valid (${r.issues.map((i) => `${i.path || "entry"}: ${i.message}`).join("; ")}); fix or remove it`);
        decoded.push({ id: (r.value as { id?: string }).id ?? "", tag: r.tag, entry: r.value, end: span.end });
      }
      for (const d of decoded) {
        await git.stageContent(CHAT_FILE, await git.hashObject(disk.subarray(0, d.end)));
        const commit = await git.commit(Conversation.#commitFor(d.entry, d.id, d.end, opts, true));
        report.recovered.push({ id: d.id, tag: d.tag, commit, offset: d.end });
        recoveredEntries.push(d.entry);
      }
    }
    return { size: disk.length, report, recoveredEntries };
  }

  // ---- commits ---------------------------------------------------------------------------------------------

  static #commitFor(entry: ChatEntry, id: string, offset: number, opts: ConversationOptions, recovered = false) {
    const committer = opts.committer ?? DEFAULT_COMMITTER;
    let author: Identity = committer;
    if (entry.$tag === "user") author = opts.user ?? committer;
    else if (entry.$tag === "assistant") author = { name: entry.model, email: `${slug(entry.provider)}@models.chattree.invalid` };
    const trailers: [string, string][] = [["Chattree-Kind", entry.$tag]];
    if (id !== "") trailers.push(["Chattree-Entry", id]);
    trailers.push(["Chattree-Offset", String(offset)]);
    if (recovered) trailers.push(["Chattree-Recovered", "true"]);
    return {
      message: describeEntry(entry),
      trailers,
      author,
      committer,
      ...Conversation.#dateOpt(opts),
    };
  }

  // ---- mutations -------------------------------------------------------------------------------------------

  #transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const lock = await acquireLock(this.host.fs, this.#lockPath, { ...this.#opts.lock, ...(this.#opts.now === undefined ? {} : { now: this.#opts.now }) });
      try {
        return await fn();
      } finally {
        await lock.release();
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Append one entry and commit it, together with whatever changed in the working tree since the last commit
   * (files the agent wrote, new blobs). Entries are appended in call order.
   */
  append(entry: NewEntry): Promise<Appended> {
    return this.#transaction(() => this.#appendLocked(entry));
  }

  /**
   * Append many entries, each its own commit, with a fixed number of git processes instead of a few per entry
   * (importing a transcript, replaying a session). Pending workspace changes are committed first as a snapshot,
   * so the entry commits hold only the transcript and its blobs. All entries are written to the transcript
   * before any is committed, as with `append`, so a crash leaves them for `open` to commit; the commits are
   * then written in one `git fast-import` and the branch moves once, so either all of them are in the history
   * or none is. Cost grows with the transcript's size times the number of entries, as with separate appends.
   */
  appendMany(inputs: readonly NewEntry[]): Promise<Appended[]> {
    return this.#transaction(() => this.#appendManyLocked(inputs));
  }

  async #appendManyLocked(inputs: readonly NewEntry[]): Promise<Appended[]> {
    if (inputs.length === 0) return [];
    await this.#snapshotLocked();
    const before = await this.#assertIntact();
    const head = await this.git.head();
    if (head === undefined) throw new ConversationError("the conversation has no commits");

    // Encode everything first: an entry that does not validate must leave nothing behind.
    const items: { id: string; tag: string; value: ChatEntry; bytes: Uint8Array; blobs: Map<string, Uint8Array> }[] = [];
    for (const input of inputs) {
      const recorder = new RecordingBlobStore(this.store);
      const pipeline = createPipeline({ ...this.#opts.pipeline, store: recorder });
      const withId = input.$tag === "header" || input.id !== undefined ? input : { ...input, id: this.#nextId() };
      const entry = await pipeline.encode(withId);
      const decoded = await pipeline.decode(entry);
      if (!decoded.ok) throw new ConversationError(`${input.$tag} entry failed to decode after encoding`);
      items.push({ id: (decoded.value as { id?: string }).id ?? "", tag: decoded.tag, value: decoded.value, bytes: encodeEntry(entry), blobs: recorder.blobs });
    }
    const total = items.reduce((n, i) => n + i.bytes.length, 0);
    const existing = await this.host.fs.read(this.#file);
    const full = new Uint8Array(before + total);
    full.set(existing.subarray(0, before));
    let at = before;
    const ends: number[] = [];
    for (const i of items) {
      full.set(i.bytes, at);
      at += i.bytes.length;
      ends.push(at);
    }

    let commits: string[];
    try {
      for (const item of items) for (const data of item.blobs.values()) await this.store.put(data);
      await this.host.fs.append(this.#file, full.subarray(before), { sync: true });
      const after = (await this.host.fs.stat(this.#file))?.size ?? 0;
      if (after !== full.length) throw new ConversationError(`${CHAT_FILE} is ${after} bytes after appending, expected ${full.length}: something else wrote to it`);
      const committer = this.#opts.committer ?? DEFAULT_COMMITTER;
      const seenBlobs = new Set<string>();
      commits = await this.git.importCommits(
        `refs/heads/${this.branch}`,
        head,
        items.map((item, k) => {
          const c = Conversation.#commitFor(item.value, item.id, ends[k] as number, this.#opts);
          // A blob goes in with the first entry that refers to it, as it would with separate appends.
          const blobFiles = [...item.blobs].map(([hash, data]) => ({ path: HostBlobStore.relativePath(hash), data })).filter((b) => !seenBlobs.has(b.path));
          for (const b of blobFiles) seenBlobs.add(b.path);
          const files = [{ path: CHAT_FILE, data: full.subarray(0, ends[k]) }, ...blobFiles];
          return { message: c.message, trailers: c.trailers, author: c.author, committer: c.committer ?? committer, ...("date" in c && c.date !== undefined ? { date: c.date } : {}), files };
        }),
      );
    } catch (e) {
      if ((await this.git.head().catch(() => undefined)) === head) await this.#rollback(before);
      throw e;
    }
    this.#size = full.length;
    // The commits bypassed the index; bring it back in line. If this fails the next staging heals it.
    await this.git.syncIndex().catch(() => undefined);
    const out: Appended[] = [];
    for (const [k, item] of items.entries()) {
      const a = { id: item.id, tag: item.tag, commit: commits[k] as string, offset: ends[k] as number };
      out.push(a);
      this.#advance(a.commit, { id: item.id === "" ? undefined : item.id, tag: item.tag, commit: a.commit, offset: a.offset });
      this.#emitEntry(this.branch, a, item.value);
    }
    return out;
  }

  async #appendLocked(input: NewEntry): Promise<Appended> {
    const withId = input.$tag === "header" || input.id !== undefined ? input : { ...input, id: this.#nextId() };
    const entry = await this.pipeline.encode(withId);
    const bytes = encodeEntry(entry);
    const decoded = await this.pipeline.decode(entry);
    if (!decoded.ok) throw new ConversationError("entry failed to decode after encoding");
    const id = (decoded.value as { id?: string }).id ?? "";

    const before = await this.#assertIntact();

    try {
      await this.host.fs.append(this.#file, bytes, { sync: true });
      const after = (await this.host.fs.stat(this.#file))?.size ?? 0;
      if (after !== before + bytes.length) throw new ConversationError(`${CHAT_FILE} is ${after} bytes after appending ${bytes.length} to ${before}: something else wrote to it`);
      await this.git.addAll();
      const commit = await this.git.commit(Conversation.#commitFor(decoded.value, id, after, this.#opts));
      this.#size = after;
      this.#advance(commit, { id: id === "" ? undefined : id, tag: decoded.tag, commit, offset: after });
      const appended = { id, tag: decoded.tag, commit, offset: after };
      this.#emitEntry(this.branch, appended, decoded.value);
      return appended;
    } catch (e) {
      await this.#rollback(before);
      throw e;
    }
  }

  /** The transcript must be exactly as this handle left it and end with a complete entry. Returns its length. */
  async #assertIntact(): Promise<number> {
    const size = (await this.host.fs.stat(this.#file))?.size ?? 0;
    if (size !== this.#size) {
      throw new ConversationError(`${CHAT_FILE} is ${size} bytes but this handle expected ${this.#size}: it was changed by something else; reopen the conversation`);
    }
    const tail = size === 0 ? new Uint8Array(0) : await this.host.fs.readRange(this.#file, Math.max(0, size - 2), 2);
    if (!endsCleanly(tail)) throw new ConversationError(`${CHAT_FILE} does not end with a complete entry; reopen the conversation to repair it`);
    return size;
  }

  /** Record a new commit on this branch: keeps the entry index and head current. */
  #advance(commit: string, ref?: EntryRef): void {
    if (this.#idx !== undefined && this.#idx.tip === this.#head) {
      if (ref !== undefined) this.#idx.refs.push(ref);
      this.#idx.tip = commit;
    }
    this.#head = commit;
  }

  /** Undo a failed append: restore the transcript from HEAD (a no-op if the commit did in fact land). */
  async #rollback(expectedBefore: number): Promise<void> {
    try {
      await this.git.restore([CHAT_FILE]);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      // Without a HEAD (a failed first commit) there is nothing to restore from: cut the file back instead.
      await this.host.fs.truncate(this.#file, expectedBefore);
    }
    this.#size = (await this.host.fs.stat(this.#file))?.size ?? 0;
  }

  // ---- other events ----------------------------------------------------------------------------------------

  /** Record that the turn was cut short, keeping whatever had been received. */
  interrupt(opts: InterruptOptions): Promise<Appended> {
    return this.append({ $tag: "interrupted", by: opts.by, partial: opts.partial ?? [], ...(opts.error === undefined ? {} : { error: opts.error }) });
  }

  /**
   * Record a compaction: entries `from` through `to` are replaced, in what the model sees, by `summary`. Nothing
   * is rewritten (see `contextEntries`). Both ends must be visible in the current context, so a range can
   * never start or end inside something already compacted; it can contain earlier summaries whole.
   */
  compact(opts: CompactOptions): Promise<Appended> {
    return this.#transaction(async () => {
      const entries = await this.readEntries();
      const values: ChatEntry[] = [];
      for (const [i, e] of entries.entries()) {
        if (!e.ok) throw new ConversationError(`entry ${i + 1} no longer validates, so the context cannot be computed; cannot compact`);
        values.push(e.value);
      }
      const visible = contextEntries(values).map((e) => ("id" in e ? e.id : undefined));
      const a = visible.indexOf(opts.from);
      const b = visible.indexOf(opts.to);
      if (a < 0) throw new ConversationError(`${opts.from} is not an entry in the current context`);
      if (b < 0) throw new ConversationError(`${opts.to} is not an entry in the current context`);
      if (a > b) throw new ConversationError("a compaction must run from an earlier entry to a later one");
      return this.#appendLocked({
        $tag: "compaction",
        replaces: { from: opts.from, to: opts.to },
        summary: opts.summary,
        ...(opts.model === undefined ? {} : { model: opts.model }),
      });
    });
  }

  // ---- configuration ---------------------------------------------------------------------------------------

  /** The hash a branch with no configuration records as its starting point. */
  static async emptyConfigHash(): Promise<string> {
    return hashValue(new Map());
  }

  /** The last configuration hash this branch's transcript recorded. */
  async #recordedConfigHash(): Promise<string> {
    let hash = await Conversation.emptyConfigHash();
    for (const e of await this.readEntries()) if (e.ok && e.value.$tag === "config_changed") hash = e.value.new;
    return hash;
  }

  /** Read and validate `harness.yml`. Undefined if there is no such file. */
  async readConfig(): Promise<ConfigResult<HarnessConfig> | undefined> {
    const path = this.host.path.join(this.dir, CONFIG_FILE);
    if ((await this.host.fs.stat(path)) === undefined) return undefined;
    return parseConfig(dec.decode(await this.host.fs.read(path)), harnessConfig);
  }

  /** Whether the file on disk is the configuration the transcript last recorded. */
  async configStatus(): Promise<ConfigStatus> {
    const [recorded, current] = [await this.#recordedConfigHash(), await this.readConfig()];
    const hash = current?.ok === true ? current.hash : undefined;
    const empty = await Conversation.emptyConfigHash();
    return {
      current: hash,
      recorded,
      inSync: current === undefined ? recorded === empty : hash === recorded,
      issues: current?.ok === false ? current.issues : [],
    };
  }

  /**
   * Replace `harness.yml` with `text` (validated against the schema, comments kept as written) and record the
   * change. A `config_changed` entry holds the previous and new hashes of the validated data, so the
   * transcript says which configuration each part of the conversation ran under. If the data is unchanged
   * (only comments or layout differ) the file is updated and nothing is recorded; if the file was edited by
   * hand since the last record, calling this with its own text records that edit.
   */
  setConfigText(text: string): Promise<ConfigChange> {
    return this.#transaction(() => this.#applyConfig(text));
  }

  /** Edit `harness.yml` through its comment-preserving document, then record the change as `setConfigText` does. */
  changeConfig(edit: Parameters<typeof editConfig>[2]): Promise<ConfigChange> {
    return this.#transaction(async () => {
      const path = this.host.path.join(this.dir, CONFIG_FILE);
      const exists = (await this.host.fs.stat(path)) !== undefined;
      const before = exists ? dec.decode(await this.host.fs.read(path)) : "";
      const r = await editConfig(before, harnessConfig, edit);
      if (!r.ok) throw new ConversationError(`invalid configuration: ${r.issues.map((i) => `${i.path || "file"}: ${i.message}`).join("; ")}`);
      return this.#applyConfig(r.text);
    });
  }

  async #applyConfig(text: string): Promise<ConfigChange> {
    const parsed = await parseConfig(text, harnessConfig);
    if (!parsed.ok) throw new ConversationError(`invalid configuration: ${parsed.issues.map((i) => `${i.path || "file"}: ${i.message}`).join("; ")}`);
    const path = this.host.path.join(this.dir, CONFIG_FILE);
    const previous = (await this.host.fs.stat(path)) === undefined ? undefined : await this.host.fs.read(path);
    const recorded = await this.#recordedConfigHash();
    const bytes = enc.encode(text);
    const same = previous !== undefined && previous.length === bytes.length && previous.every((b, i) => b === bytes[i]);
    if (!same) await this.host.fs.writeAtomic(path, bytes);
    if (parsed.hash === recorded) return { changed: false, hash: parsed.hash, entry: undefined };
    try {
      const entry = await this.#appendLocked({ $tag: "config_changed", old: recorded, new: parsed.hash });
      return { changed: true, hash: parsed.hash, entry };
    } catch (e) {
      if (!same) {
        if (previous === undefined) await this.host.fs.remove(path).catch(() => false);
        else await this.host.fs.writeAtomic(path, previous).catch(() => undefined);
      }
      throw e;
    }
  }

  // ---- branches --------------------------------------------------------------------------------------------

  /**
   * Start a new branch from an earlier entry of this one (default: the latest), with a `branch_start` entry as
   * its first entry. The branch is built directly in git, without a checkout, in one step: the fork point's
   * tree plus the extended transcript, so either the branch exists complete or it does not exist. It is then
   * checked out in its own worktree unless `checkout` is false. The workspace files are those of the fork
   * point, so forking rewinds files as well as the conversation; uncommitted changes here are not carried.
   * To "edit" a past message, fork before it and append the new message to the fork.
   */
  async fork(at?: string | EntryRef, opts: ForkOptions = {}): Promise<ForkResult> {
    const ref = await this.#resolveEntry(at);
    const name = opts.name ?? `fork/${this.#nextId()}`;
    await this.#assertNewBranch(name);
    const marker: NewEntry = { $tag: "branch_start", kind: "fork", from: { branch: this.branch, commit: ref.commit }, context: "inherit" };
    return this.#newBranch(name, ref.commit, marker, opts);
  }

  async #resolveEntry(at: string | EntryRef | undefined): Promise<EntryRef> {
    const refs = await this.index();
    let ref: EntryRef | undefined;
    if (at === undefined) ref = refs.at(-1);
    else if (typeof at === "string") ref = refs.find((r) => r.id === at);
    else ref = refs.find((r) => r.commit === at.commit);
    if (ref === undefined) throw new ConversationError(at === undefined ? "the conversation has no entries" : `no such entry on branch ${this.branch}: ${typeof at === "string" ? at : at.commit}`);
    return ref;
  }

  async #assertNewBranch(name: string): Promise<void> {
    if (!(await this.git.isValidBranchName(name))) throw new ConversationError(`invalid branch name: ${JSON.stringify(name)}`);
    if ((await this.git.revParse(`refs/heads/${name}`)) !== undefined) throw new ConversationError(`branch ${name} already exists`);
  }

  async #newBranch(name: string, from: string, marker: NewEntry, opts: { checkout?: boolean; worktree?: string }): Promise<ForkResult> {
    const start = await this.#startBranch(name, from, marker);
    let conversation: Conversation | undefined;
    if (opts.checkout !== false) conversation = await this.#checkoutBranch(name, opts.worktree);
    return { branch: name, start, from, conversation };
  }

  /**
   * Encode an entry that is about to be committed straight into git (a branch start, a merge): its bytes and
   * any blobs it creates, held in memory so they can go into that commit's tree instead of a worktree.
   */
  async #prepare(input: NewEntry): Promise<{ id: string; tag: string; value: ChatEntry; bytes: Uint8Array; blobs: Map<string, Uint8Array> }> {
    const store = new RecordingBlobStore(this.store);
    const pipeline = createPipeline({ ...this.#opts.pipeline, store });
    const withId = input.$tag === "header" || input.id !== undefined ? input : { ...input, id: this.#nextId() };
    const entry = await pipeline.encode(withId);
    const decoded = await pipeline.decode(entry);
    if (!decoded.ok) throw new ConversationError(`${input.$tag} entry failed to decode after encoding`);
    return { id: (decoded.value as { id?: string }).id ?? "", tag: decoded.tag, value: decoded.value, bytes: encodeEntry(entry), blobs: store.blobs };
  }

  static #blobEdits(blobs: ReadonlyMap<string, Uint8Array>): { path: string; data: Uint8Array }[] {
    return [...blobs].map(([hash, data]) => ({ path: HostBlobStore.relativePath(hash), data }));
  }

  /**
   * Make a branch at `from` whose first new entry is `marker`. Nothing is written until the final, atomic
   * step of creating the branch, so a crash leaves at worst an unreachable commit.
   */
  async #startBranch(name: string, from: string, marker: NewEntry): Promise<Appended> {
    const prepared = await this.#prepare(marker);
    const prefix = await this.git.readFileAt(from, CHAT_FILE);
    if (prefix === undefined) throw new ConversationError(`${CHAT_FILE} does not exist at ${from}`);
    const data = new Uint8Array(prefix.length + prepared.bytes.length);
    data.set(prefix);
    data.set(prepared.bytes, prefix.length);
    const commit = await this.git.commitOnto(from, [{ path: CHAT_FILE, data }, ...Conversation.#blobEdits(prepared.blobs)], Conversation.#commitFor(prepared.value, prepared.id, data.length, this.#opts));
    await this.git.createBranch(name, commit);
    const start = { id: prepared.id, tag: prepared.tag, commit, offset: data.length };
    this.#emitEntry(name, start, prepared.value);
    if (marker.$tag === "branch_start") this.#emit({ type: "branch", branch: name, kind: marker.kind, parent: marker.from.branch, from, start });
    return start;
  }

  // ---- subagents -------------------------------------------------------------------------------------------

  /**
   * Commit whatever changed in the working tree since the last commit, as a snapshot commit that is not an
   * entry. Resolves to the commit, or undefined if the tree was clean.
   */
  snapshot(): Promise<string | undefined> {
    return this.#transaction(() => this.#snapshotLocked());
  }

  async #snapshotLocked(): Promise<string | undefined> {
    const size = await this.#assertIntact();
    if (await this.git.isClean()) return undefined;
    await this.git.addAll();
    const committer = this.#opts.committer ?? DEFAULT_COMMITTER;
    const commit = await this.git.commit({
      message: "workspace snapshot",
      trailers: [["Chattree-Offset", String(size)], ["Chattree-Snapshot", "true"]],
      author: committer,
      committer,
      ...Conversation.#dateOpt(this.#opts),
    });
    this.#advance(commit);
    this.#emit({ type: "snapshot", branch: this.branch, commit });
    return commit;
  }

  static #dateOpt(opts: ConversationOptions): { date?: string } {
    return opts.fixedDates === true && opts.now !== undefined ? { date: new Date(opts.now()).toISOString() } : {};
  }

  /**
   * Start a subagent: a new branch from the current state of this one (pending workspace changes are
   * snapshotted first so the subagent sees them) whose first entry is a `branch_start` with a fresh-context
   * marker and the brief. The subagent works on the returned conversation, in its own worktree, and its
   * entries stay on its own branch. Merge its work back with `finishSubagent`.
   */
  async spawnSubagent(opts: SpawnOptions): Promise<ForkResult> {
    let from: string;
    if (opts.from === undefined) {
      await this.snapshot();
      const head = await this.git.head();
      if (head === undefined) throw new ConversationError("the conversation has no commits");
      from = head;
    } else {
      from = (await this.#resolveEntry(opts.from)).commit;
    }
    const name = opts.name ?? `sub/${this.#nextId()}`;
    await this.#assertNewBranch(name);
    const marker: NewEntry = { $tag: "branch_start", kind: "subagent", from: { branch: this.branch, commit: from }, context: "fresh", brief: opts.brief, call_id: opts.callId };
    return this.#newBranch(name, from, marker, opts);
  }

  /**
   * Merge a subagent's branch into this one and record the result. Policy: the trunk wins. Everything the
   * child changed that does not conflict is merged; any file that conflicts (content, modify/delete,
   * file/directory, ...) takes this branch's version in full; the transcript always keeps this branch's.
   * The outcome says exactly what landed and what was dropped.
   *
   * The merge is computed in memory and committed as a merge commit that is also the `subagent_result`
   * entry's commit (this branch's first parent, the child's tip second), then this branch is fast-forwarded
   * onto it. Pending workspace changes here are snapshotted first, so the working tree is clean for the move.
   */
  async finishSubagent(child: Conversation | string, opts: FinishOptions): Promise<MergeOutcome> {
    return this.#mergeBranch(child, opts.removeWorktree === true, (m) => ({
      $tag: "subagent_result",
      call_id: opts.callId,
      branch: m.branch,
      tip: m.tip,
      summary: opts.summary,
      files: m.files,
      merge: m.merge,
    }));
  }

  /**
   * Merge a fork back into this branch, the same way as a subagent (trunk wins, the transcript keeps this
   * branch's entries, one merge commit that is also the entry's commit) and record a `fork_merge` entry:
   * the fork's branch, where it diverged, a summary of what was discussed and decided there, and what
   * changed in the files. The fork's own conversation stays on its branch. A fork can be merged again after
   * it has moved on; each merge reports only what is new since the last.
   */
  async mergeFork(fork: Conversation | string, opts: MergeForkOptions): Promise<MergeOutcome> {
    return this.#mergeBranch(fork, opts.removeWorktree === true, (m) => ({
      $tag: "fork_merge",
      branch: m.branch,
      tip: m.tip,
      summary: opts.summary,
      files: m.files,
      merge: m.merge,
    }));
  }

  async #mergeBranch(
    child: Conversation | string,
    removeWorktree: boolean,
    build: (m: { branch: string; tip: string; files: { changed: string[]; added: string[]; discarded: string[] }; merge: { policy: "trunk"; base: string; conflicts: MergeConflict[] } }) => NewEntry,
  ): Promise<MergeOutcome> {
    const childBranch = typeof child === "string" ? child : child.branch;
    if (childBranch === this.branch) throw new ConversationError("a branch cannot be merged into itself");
    if (typeof child !== "string") await child.snapshot();

    const outcome = await this.#transaction(async () => {
      const size = await this.#assertIntact();
      await this.#snapshotLocked();
      const head = await this.git.head();
      const tip = await this.git.revParse(`refs/heads/${childBranch}`);
      if (head === undefined) throw new ConversationError("the conversation has no commits");
      if (tip === undefined) throw new ConversationError(`no such branch: ${childBranch}`);
      if (await this.git.isAncestor(tip, head)) throw new ConversationError(`branch ${childBranch} is already merged into ${this.branch}`);
      const base = await this.git.mergeBase(head, tip);
      if (base === undefined) throw new ConversationError(`branches ${this.branch} and ${childBranch} have no common history`);

      const merged = await this.git.mergeTree(head, tip);
      const childChanges = await this.git.diff(base, tip, [".", `:(exclude)${CHAT_FILE}`, `:(exclude)${BLOBS_DIR}`]);
      const summary = summarizeMerge(childChanges, merged);

      const prepared = await this.#prepare(
        build({
          branch: childBranch,
          tip,
          files: { changed: summary.changed, added: summary.added, discarded: summary.discarded },
          merge: { policy: "trunk", base, conflicts: summary.conflicts },
        }),
      );
      const transcript = await this.git.readFileAt(head, CHAT_FILE);
      if (transcript === undefined || transcript.length !== size) throw new ConversationError(`${CHAT_FILE} at HEAD does not match the working tree; reopen the conversation`);
      const data = new Uint8Array(transcript.length + prepared.bytes.length);
      data.set(transcript);
      data.set(prepared.bytes, transcript.length);

      const tree = await this.git.rewriteTree(merged.tree, [
        ...merged.conflictedPaths.filter((p) => p !== CHAT_FILE).map((path) => ({ path, from: head })),
        { path: CHAT_FILE, data },
        ...Conversation.#blobEdits(prepared.blobs),
      ]);
      const commit = await this.git.commitTree(tree, [head, tip], Conversation.#commitFor(prepared.value, prepared.id, data.length, this.#opts));
      await this.git.fastForward(commit);
      const after = (await this.host.fs.stat(this.#file))?.size ?? 0;
      if (after !== data.length) throw new ConversationError(`${CHAT_FILE} is ${after} bytes after the merge, expected ${data.length}`);
      this.#size = after;
      this.#advance(commit, { id: prepared.id, tag: prepared.tag, commit, offset: after });
      const entry = { id: prepared.id, tag: prepared.tag, commit, offset: after };
      const report = { ...summary, base };
      this.#emitEntry(this.branch, entry, prepared.value);
      this.#emit({ type: "merge", branch: this.branch, child: childBranch, kind: prepared.value.$tag === "fork_merge" ? "fork" : "subagent", entry, report });
      return { entry, report, childTip: tip };
    });
    if (removeWorktree) await this.removeWorktree(childBranch);
    return outcome;
  }

  // ---- housekeeping ----------------------------------------------------------------------------------------

  /**
   * Remove the worktree of a branch that is merged into this one (its branch and history stay). Refuses if the
   * branch is not merged or its worktree has uncommitted changes, unless `force`. Resolves to the removed
   * path, or undefined if the branch had no worktree.
   */
  async removeWorktree(branch: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
    if (branch === this.branch) throw new ConversationError("cannot remove the worktree this handle is using");
    const wt = (await this.git.worktrees()).find((w) => w.branch === `refs/heads/${branch}`);
    if (wt === undefined) return undefined;
    if (wt.path === this.dir) throw new ConversationError("cannot remove the worktree this handle is using");
    if (opts.force !== true) {
      const [tip, head] = [await this.git.revParse(`refs/heads/${branch}`), await this.git.head()];
      if (tip === undefined || head === undefined || !(await this.git.isAncestor(tip, head))) throw new ConversationError(`branch ${branch} is not merged into ${this.branch}; keep its worktree or pass force`);
    }
    try {
      await this.git.removeWorktree(wt.path, opts.force === true ? { force: true } : {});
    } catch (e) {
      if (e instanceof GitError && opts.force !== true) throw new ConversationError(`the worktree of ${branch} has uncommitted or untracked changes; commit them, or pass force: ${e.message}`);
      throw e;
    }
    await this.git.pruneWorktrees();
    return wt.path;
  }

  /** Remove the worktrees of every branch merged into this one that has nothing uncommitted in it; report what was kept and why. */
  async pruneWorktrees(): Promise<WorktreeCleanup> {
    const report: WorktreeCleanup = { removed: [], kept: [] };
    for (const wt of await this.git.worktrees()) {
      const branch = wt.branch?.startsWith("refs/heads/") === true ? wt.branch.slice("refs/heads/".length) : undefined;
      if (branch === undefined || branch === this.branch || wt.path === this.dir) continue;
      try {
        if ((await this.removeWorktree(branch)) !== undefined) report.removed.push({ branch, path: wt.path });
      } catch (e) {
        if (e instanceof ConversationError) report.kept.push({ branch, path: wt.path, reason: e.message });
        else throw e;
      }
    }
    await this.git.pruneWorktrees();
    return report;
  }

  /**
   * Remove blob files the transcript does not refer to. They come from appends that failed after their large
   * values were written: such files are either still untracked or, if a later commit swept them up, tracked
   * but unreferenced. Referenced blobs are never touched; history is not rewritten (older commits keep
   * whatever they had). Refuses if any entry no longer validates, since it could hide a reference.
   */
  gcBlobs(opts: BlobGcOptions = {}): Promise<BlobGcReport> {
    return this.#transaction(async () => {
      await this.#assertIntact();
      const wanted = new Set<string>();
      for (const [i, e] of (await this.readEntries()).entries()) {
        if (!e.ok) throw new ConversationError(`entry ${i + 1} no longer validates, so its blob references are unknown; refusing to collect blobs`);
        for (const hash of blobRefs(e.value).keys()) wanted.add(HostBlobStore.relativePath(hash));
      }
      const sizeOf = async (path: string): Promise<number> => (await this.host.fs.stat(this.host.path.join(this.dir, ...path.split("/"))))?.size ?? 0;
      const orphans = async (which: "tracked" | "untracked") => {
        const out: { path: string; bytes: number }[] = [];
        for (const path of (await this.git.listFiles([BLOBS_DIR], which)).filter((p) => !wanted.has(p)).sort()) out.push({ path, bytes: await sizeOf(path) });
        return out;
      };
      const report: BlobGcReport = { untracked: await orphans("untracked"), tracked: await orphans("tracked"), commit: undefined };
      if (opts.dryRun === true) return report;
      for (const o of [...report.untracked, ...report.tracked]) await this.host.fs.remove(this.host.path.join(this.dir, ...o.path.split("/")));
      if (report.tracked.length > 0) {
        const paths = report.tracked.map((o) => o.path);
        await this.git.add(paths);
        const committer = this.#opts.committer ?? DEFAULT_COMMITTER;
        report.commit = await this.git.commit({
          message: "remove unreferenced blobs",
          trailers: [["Chattree-Offset", String(this.#size)], ["Chattree-Gc", "true"]],
          author: committer,
          committer,
          paths,
          ...Conversation.#dateOpt(this.#opts),
        });
        this.#advance(report.commit);
      }
      return report;
    });
  }

  /**
   * Finish all background work for this handle: deliver pending events and end any long-running git processes
   * it started. The handle stays usable (sessions are started on demand).
   */
  async close(): Promise<void> {
    await this.flushEvents();
    await this.git.closeSessions();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #defaultWorktree(name: string): string {
    return this.host.path.join(`${this.dir}.branches`, encodeURIComponent(name));
  }

  async #checkoutBranch(name: string, at?: string): Promise<Conversation> {
    const path = at ?? this.#defaultWorktree(name);
    const existing = (await this.git.worktrees()).find((w) => w.branch === `refs/heads/${name}`);
    if (existing !== undefined) return Conversation.open(this.host, existing.path, this.#opts);
    await this.git.addWorktree(path, { branch: name });
    return Conversation.open(this.host, path, this.#opts);
  }

  /** All local branches with their tips and where each is checked out. */
  async listBranches(): Promise<BranchInfo[]> {
    const [branches, worktrees] = await Promise.all([this.git.branches(), this.git.worktrees()]);
    return branches.map((b) => ({
      name: b.ref.slice("refs/heads/".length),
      tip: b.hash,
      worktree: worktrees.find((w) => w.branch === b.ref)?.path,
    }));
  }

  /** A handle on another branch, checking it out in a worktree first if it has none. */
  async openBranch(name: string, opts: { worktree?: string } = {}): Promise<Conversation> {
    if ((await this.git.revParse(`refs/heads/${name}`)) === undefined) throw new ConversationError(`no such branch: ${name}`);
    return this.#checkoutBranch(name, opts.worktree);
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  /** Every entry in the transcript as of the working tree, decoded and validated. Entries that no longer validate come back with their issues. */
  async readEntries(): Promise<DecodeResult<ChatEntry>[]> {
    const bytes = await this.host.fs.read(this.#file);
    const { entries } = parseFile(bytes);
    return Promise.all(entries.map((e) => this.pipeline.decode(e)));
  }

  /**
   * Every entry on a branch, oldest first, with the commit that holds it: the index behind forking and
   * reading history. Built from the commit trailers with one `git log` and then kept current as this handle
   * appends. Follows first parents, so a branch's index includes the history it was forked from.
   * With a revision other than this branch's HEAD the result is computed once and not cached.
   */
  async index(rev?: string): Promise<readonly EntryRef[]> {
    if (rev !== undefined && rev !== "HEAD") return this.#indexOf(rev);
    const head = await this.git.head();
    if (head === undefined) return [];
    if (this.#idx?.tip === head) return this.#idx.refs.slice();
    // Start from what we have, or what the cache kept from an earlier run.
    let have = this.#idx;
    if (have === undefined) {
      have = await this.#loadCachedIndex();
    }
    // Extend it if its tip is on this branch's first-parent line; otherwise rebuild.
    if (have !== undefined && have.tip === head) {
      this.#idx = { tip: head, refs: have.refs };
    } else if (have !== undefined && (await this.#onBranchLine(have.tip, head))) {
      const added = await this.#indexOf(head, have.tip);
      this.#idx = { tip: head, refs: [...have.refs, ...added] };
      await this.#saveCachedIndex();
    } else {
      this.#idx = { tip: head, refs: await this.#indexOf(head) };
      await this.#saveCachedIndex();
    }
    this.#head = head;
    return this.#idx.refs.slice();
  }

  async #onBranchLine(ancestor: string, head: string): Promise<boolean> {
    try {
      return await this.git.isAncestor(ancestor, head);
    } catch (e) {
      if (e instanceof GitError) return false; // the cached tip no longer exists
      throw e;
    }
  }

  async #indexCache(): Promise<IndexCache | undefined> {
    if (!this.#cacheReady) {
      const o = this.#opts.indexCache;
      this.#cache = o === false ? undefined : (o ?? (await FileIndexCache.forRepository(this.host, this.git)));
      this.#cacheReady = true;
    }
    return this.#cache;
  }

  async #loadCachedIndex(): Promise<{ tip: string; refs: EntryRef[] } | undefined> {
    try {
      const cached = await (await this.#indexCache())?.load(this.branch);
      return cached === undefined ? undefined : { tip: cached.tip, refs: cached.refs.map((r) => ({ ...r })) };
    } catch {
      return undefined; // a broken cache is just a missing one
    }
  }

  async #saveCachedIndex(): Promise<void> {
    if (this.#idx === undefined) return;
    try {
      await (await this.#indexCache())?.save(this.branch, { tip: this.#idx.tip, refs: this.#idx.refs });
    } catch {
      /* the cache is an optimisation */
    }
  }

  /** Write the current entry index to the cache now (it is otherwise saved when `index()` has to do work). */
  async flushIndex(): Promise<void> {
    await this.index();
    await this.#saveCachedIndex();
  }

  async #indexOf(rev: string, after?: string): Promise<EntryRef[]> {
    const range = after === undefined ? rev : `${after}..${rev}`;
    const commits = await this.git.log(range, { firstParent: true });
    const refs: EntryRef[] = [];
    for (const c of commits) {
      const kind = c.trailers["Chattree-Kind"]?.[0];
      const offset = Number(c.trailers["Chattree-Offset"]?.[0]);
      if (kind === undefined || !Number.isSafeInteger(offset)) continue; // not an entry commit
      refs.push({ id: c.trailers["Chattree-Entry"]?.[0], tag: kind, commit: c.hash, offset });
    }
    return refs.reverse();
  }

  /** Find an entry on this branch by id. */
  async findEntry(id: string): Promise<EntryRef | undefined> {
    return (await this.index()).find((r) => r.id === id);
  }

  /** Entries up to and including `ref`, read from the working-tree transcript without running git. `ref` must come from this branch's index. */
  async readEntriesUpTo(ref: EntryRef): Promise<DecodeResult<ChatEntry>[]> {
    if (ref.offset > this.#size) throw new ConversationError(`entry ${ref.id ?? ref.tag} is beyond the end of the transcript`);
    const bytes = await this.host.fs.readRange(this.#file, 0, ref.offset);
    return Promise.all(parseFile(bytes).entries.map((e) => this.pipeline.decode(e)));
  }

  /** Every entry as of any revision (a branch name, commit hash or ref), without touching the worktree. */
  async readEntriesAt(rev: string): Promise<DecodeResult<ChatEntry>[]> {
    const bytes = await this.git.readFileAt(rev, CHAT_FILE);
    if (bytes === undefined) throw new ConversationError(`${CHAT_FILE} does not exist at ${rev}`);
    return Promise.all(parseFile(bytes).entries.map((e) => this.pipeline.decode(e)));
  }

  /** The raw transcript bytes. */
  readTranscript(): Promise<Uint8Array> {
    return this.host.fs.read(this.#file);
  }

  /** Current length of the transcript as this handle last wrote it. */
  get size(): number {
    return this.#size;
  }
}
