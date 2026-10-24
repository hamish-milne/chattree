import {
  FrameError,
  Git,
  GitError,
  ParseError,
  decodeSpan,
  acquireLock,
  encodeEntry,
  endsCleanly,
  parseFile,
  scan,
  type DecodeResult,
  type Host,
  type Identity,
  type LockOptions,
  type Pipeline,
} from "../src/index.ts";
import { HostBlobStore } from "./blob-store.ts";
import { FORMAT, createPipeline, type ChatEntry, type PipelineConfig } from "./entries.ts";
import { createUlid } from "./ulid.ts";

/** The transcript, relative to the repository root. */
export const CHAT_FILE = "chat.yml";
/** Where blobs live, relative to the repository root. */
export const BLOBS_DIR = "blobs";

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
}

export interface CreateOptions extends ConversationOptions {
  /** Name of the first branch. Default "main". */
  branch?: string;
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
}

const DEFAULT_COMMITTER: Identity = { name: "chattree", email: "chattree@localhost.invalid" };
const enc = new TextEncoder();

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
    case "interrupted":
      return `interrupted: ${e.by}`;
  }
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

  // ---- create / open ---------------------------------------------------------------------------------------

  /** Create a new conversation repository in `dir` (which must not already be a repository) with its header entry. */
  static async create(host: Host, dir: string, opts: CreateOptions = {}): Promise<Conversation> {
    if ((await host.fs.stat(host.path.join(dir, ".git"))) !== undefined) throw new ConversationError(`${dir} is already a git repository`);
    const git = await Git.init(host, dir, { branch: opts.branch ?? "main" });
    await git.setConfig("merge.ours.driver", "true");
    await host.fs.writeAtomic(host.path.join(dir, ".gitattributes"), enc.encode(GITATTRIBUTES));
    const branch = opts.branch ?? "main";
    const convo = await Conversation.#load(host, git, dir, branch, opts, 0, { truncatedBytes: 0, recovered: [] });
    await convo.#transaction(async () => {
      await convo.#appendLocked({ $tag: "header", ...FORMAT });
    });
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
      const { size, report } = await Conversation.#recover(host, git, dir, opts);
      return await Conversation.#load(host, git, dir, branch, opts, size, report);
    } finally {
      await lock.release();
    }
  }

  static async #load(host: Host, git: Git, dir: string, branch: string, opts: ConversationOptions, size: number, report: RecoveryReport): Promise<Conversation> {
    const lockPath = await Conversation.#lockPathFor(host, git, branch);
    return new Conversation(host, git, dir, branch, lockPath, opts, size, report);
  }

  static async #lockPathFor(host: Host, git: Git, branch: string): Promise<string> {
    return host.path.join(await git.commonDir(), "chattree", "locks", `${encodeURIComponent(branch)}.lock`);
  }

  static async #recover(host: Host, git: Git, dir: string, opts: ConversationOptions): Promise<{ size: number; report: RecoveryReport }> {
    const file = host.path.join(dir, CHAT_FILE);
    const committed = await git.readFileAt("HEAD", CHAT_FILE);
    if (committed === undefined) throw new ConversationError(`HEAD has no ${CHAT_FILE}: not a conversation repository`);
    const stat = await host.fs.stat(file);
    if (stat === undefined) throw new ConversationError(`${CHAT_FILE} is missing from the working tree (it is committed at HEAD)`);
    let disk = await host.fs.read(file);
    if (!startsWith(disk, committed)) {
      throw new ConversationError(`${CHAT_FILE} in the working tree does not extend the version at HEAD: it was edited, not appended to. Restore it with git, or commit the edit deliberately.`);
    }

    const report: RecoveryReport = { truncatedBytes: 0, recovered: [] };
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
      }
    }
    return { size: disk.length, report };
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
      ...(opts.fixedDates === true && opts.now !== undefined ? { date: new Date(opts.now()).toISOString() } : {}),
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

  async #appendLocked(input: NewEntry): Promise<Appended> {
    const withId = input.$tag === "header" || input.id !== undefined ? input : { ...input, id: this.#nextId() };
    const entry = await this.pipeline.encode(withId);
    const bytes = encodeEntry(entry);
    const decoded = await this.pipeline.decode(entry);
    if (!decoded.ok) throw new ConversationError("entry failed to decode after encoding");
    const id = (decoded.value as { id?: string }).id ?? "";

    const stat = await this.host.fs.stat(this.#file);
    const before = stat?.size ?? 0;
    if (before !== this.#size) {
      throw new ConversationError(`${CHAT_FILE} is ${before} bytes but this handle expected ${this.#size}: it was changed by something else; reopen the conversation`);
    }
    const tail = before === 0 ? new Uint8Array(0) : await this.host.fs.readRange(this.#file, Math.max(0, before - 2), 2);
    if (!endsCleanly(tail)) throw new ConversationError(`${CHAT_FILE} does not end with a complete entry; reopen the conversation to repair it`);

    try {
      await this.host.fs.append(this.#file, bytes, { sync: true });
      const after = (await this.host.fs.stat(this.#file))?.size ?? 0;
      if (after !== before + bytes.length) throw new ConversationError(`${CHAT_FILE} is ${after} bytes after appending ${bytes.length} to ${before}: something else wrote to it`);
      await this.git.addAll();
      const commit = await this.git.commit(Conversation.#commitFor(decoded.value, id, after, this.#opts));
      this.#size = after;
      return { id, tag: decoded.tag, commit, offset: after };
    } catch (e) {
      await this.#rollback(before);
      throw e;
    }
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

  // ---- reading ---------------------------------------------------------------------------------------------

  /** Every entry in the transcript as of the working tree, decoded and validated. Entries that no longer validate come back with their issues. */
  async readEntries(): Promise<DecodeResult<ChatEntry>[]> {
    const bytes = await this.host.fs.read(this.#file);
    const { entries } = parseFile(bytes);
    return Promise.all(entries.map((e) => this.pipeline.decode(e)));
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
