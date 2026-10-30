import { GitError } from "../errors.ts";
import type { ExecResult, Host } from "../host.ts";
import { CatFileSession, assertObjectName, type ObjectReader } from "./cat-file.ts";
import { MIN_GIT_VERSION, compareVersions, formatVersion, parseGitVersion, type GitVersion } from "./version.ts";

const dec = new TextDecoder("utf-8", { fatal: false });
const enc = new TextEncoder();

export interface Identity {
  name: string;
  email: string;
}

export interface GitOptions {
  /** Working directory of the repository or worktree (a host path). */
  cwd: string;
  /** Run the repository's hooks. Default false: the harness commits on its own and user hooks must not interfere. */
  hooks?: boolean;
  /** Override the minimum supported git version (default: see MIN_GIT_VERSION). */
  minVersion?: GitVersion;
  /** Program to run. Default "git". */
  program?: string;
}

export interface RunOptions {
  stdin?: Uint8Array;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Exit codes that are not errors (0 is always accepted). */
  ok?: readonly number[];
  /** The command only reads: tell git not to take optional locks (so it never races a writer). */
  readOnly?: boolean;
}

export interface StatusEntry {
  /** `"??"` untracked, `"!!"` ignored, `"UU"`-style codes for unmerged paths, otherwise the two-letter XY status. */
  code: string;
  path: string;
}

export interface CommitInfo {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Strict ISO 8601. */
  authorDate: string;
  committerName: string;
  committerEmail: string;
  subject: string;
  trailers: Record<string, string[]>;
}

export interface RefInfo {
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  hash: string;
}

export interface WorktreeInfo {
  path: string;
  head: string | undefined;
  /** Full ref name, undefined when detached or bare. */
  branch: string | undefined;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface DiffEntry {
  /** `A` added, `M` modified, `D` deleted, `T` type changed. */
  status: string;
  path: string;
}

export interface CommitOptions {
  message: string;
  /** Appended as a trailer block. Keys are `Token-Like-This`, values single-line. */
  trailers?: ReadonlyArray<readonly [key: string, value: string]>;
  author?: Identity;
  committer?: Identity;
  /** Fixes both author and committer dates (ISO 8601). For tests and reproducible history. */
  date?: string;
  allowEmpty?: boolean;
  /** Commit only these paths (as they are in the worktree), leaving anything else staged out of the commit. */
  paths?: readonly string[];
}

export interface ImportCommit extends Omit<CommitOptions, "allowEmpty" | "author" | "committer"> {
  author: Identity;
  committer: Identity;
  /** The files this commit writes (it keeps the rest of its parent's tree). Paths are plain, relative and `/`-separated. */
  files: ReadonlyArray<{ path: string; data: Uint8Array }>;
}

export interface ObjectInfo {
  /** The object id. */
  oid: string;
  type: string;
  size: number;
}

export interface MergeMessage {
  /** Paths the message is about. */
  paths: string[];
  /** Git's label, e.g. `Auto-merging`, `CONFLICT (contents)`, `CONFLICT (modify/delete)`. */
  type: string;
  message: string;
}

export interface MergeTreeResult {
  /** The merged tree. When there are conflicts it holds placeholders (conflict markers, one side's version). */
  tree: string;
  clean: boolean;
  /** Paths in the tree that are left in a conflicted state. */
  conflictedPaths: string[];
  messages: MergeMessage[];
}

/** A change to a tree, applied to a temporary index. */
export type TreeEdit =
  | { path: string; data: Uint8Array; mode?: string }
  /** Remove the path (and everything below it). */
  | { path: string; remove: true }
  /** Make the path (and everything below it) exactly as it is in `from`, removing it if `from` lacks it. */
  | { path: string; from: string };

const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** Reject anything that could be read as an option or that cannot be part of a ref or path argument. */
function assertSafeArg(what: string, value: string): void {
  if (value === "" || value.startsWith("-") || value.includes("\u0000")) throw new GitError(`invalid ${what}: ${JSON.stringify(value)}`);
}

/**
 * A typed wrapper over the git command line. It runs through a `Host`, so it works wherever the host does,
 * and it fixes the settings that would otherwise let a user's configuration change behaviour: no prompts,
 * no pager or editor, no hooks, no signing, no auto-gc, no line-ending conversion, C locale.
 */
const knownVersions = new WeakMap<Host, Map<string, GitVersion>>();

export class Git {
  readonly #sessions = new Set<CatFileSession>();
  #known: Promise<{ git: string; common: string }> | undefined;
  #shared: Promise<ObjectReader> | undefined;
  #sharedBusy = 0;
  #sharedIdle: ReturnType<typeof setTimeout> | undefined;
  readonly host: Host;
  readonly cwd: string;
  readonly version: GitVersion;
  readonly #opts: GitOptions;

  private constructor(host: Host, opts: GitOptions, version: GitVersion) {
    this.host = host;
    this.cwd = opts.cwd;
    this.version = version;
    this.#opts = opts;
  }

  /** Check that git runs and is recent enough, and return a handle for `opts.cwd`. The version is asked once per host and program (starting a process is the slow part). */
  static async open(host: Host, opts: GitOptions): Promise<Git> {
    const program = opts.program ?? "git";
    let known = knownVersions.get(host);
    let version = known?.get(program);
    if (version === undefined) {
      let r: ExecResult;
      try {
        r = await host.exec(program, ["version"], { cwd: opts.cwd, env: { LC_ALL: "C" } });
      } catch (e) {
        throw new GitError(`cannot run ${program}: ${e instanceof Error ? e.message : String(e)}`);
      }
      version = r.exitCode === 0 ? parseGitVersion(dec.decode(r.stdout)) : undefined;
      if (version === undefined) throw new GitError(`cannot determine the git version (exit ${r.exitCode}): ${dec.decode(r.stderr).trim()}`);
      if (known === undefined) knownVersions.set(host, (known = new Map()));
      known.set(program, version);
    }
    const min = opts.minVersion ?? MIN_GIT_VERSION;
    if (compareVersions(version, min) < 0) {
      throw new GitError(`git ${formatVersion(version)} is too old: ${formatVersion(min)} or newer is required (see docs/git-integration.md, D7)`);
    }
    return new Git(host, opts, version);
  }

  /** Create the directory if needed, `git init` it, and return a handle. */
  static async init(host: Host, dir: string, opts: Omit<GitOptions, "cwd"> & { branch?: string }): Promise<Git> {
    await host.fs.mkdir(dir);
    const { branch, ...rest } = opts;
    const git = await Git.open(host, { ...rest, cwd: dir });
    const initial = branch ?? "main";
    assertSafeArg("branch name", initial);
    await git.run(["init", `--initial-branch=${initial}`, "--quiet"]);
    return git;
  }

  /** The same repository settings at another working directory (for example a linked worktree). */
  withCwd(cwd: string): Git {
    return new Git(this.host, { ...this.#opts, cwd }, this.version);
  }

  #base(): string[] {
    const args = [
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "core.quotepath=false",
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgsign=false",
      "-c", "tag.gpgsign=false",
      "-c", "gc.auto=0",
      "-c", "maintenance.auto=false",
      "-c", "advice.detachedHead=false",
    ];
    if (this.#opts.hooks !== true) args.push("-c", `core.hooksPath=${this.host.nullDevice}`);
    return args;
  }

  /** Run a git command. Throws `GitError` on any exit code other than 0 or those in `opts.ok`. */
  async run(args: readonly string[], opts: RunOptions = {}): Promise<ExecResult> {
    const env: Record<string, string> = {
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_PAGER: "cat",
      GIT_MERGE_AUTOEDIT: "no",
      ...(opts.readOnly === true ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
      ...opts.env,
    };
    const execOpts = {
      cwd: this.cwd,
      env,
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    };
    const r = await this.host.exec(this.#opts.program ?? "git", [...this.#base(), ...args], execOpts);
    if (r.exitCode !== 0 && !(opts.ok ?? []).includes(r.exitCode)) {
      const stderr = dec.decode(r.stderr).trim();
      throw new GitError(`git ${args.slice(0, 2).join(" ")} failed (exit ${r.exitCode})${stderr === "" ? "" : `: ${stderr}`}`, { args, exitCode: r.exitCode, stderr });
    }
    return r;
  }

  /** stdout as text with the final newline removed. */
  async text(args: readonly string[], opts: RunOptions = {}): Promise<string> {
    return dec.decode((await this.run(args, opts)).stdout).replace(/\n$/, "");
  }

  // ---- configuration -------------------------------------------------------------------------------------

  /** Set a repository-local config value. */
  async setConfig(key: string, value: string): Promise<void> {
    assertSafeArg("config key", key);
    await this.run(["config", "--local", "--", key, value]);
  }

  async getConfig(key: string): Promise<string | undefined> {
    assertSafeArg("config key", key);
    const r = await this.run(["config", "--get", "--", key], { ok: [1], readOnly: true });
    return r.exitCode === 1 ? undefined : dec.decode(r.stdout).replace(/\n$/, "");
  }

  // ---- revisions ------------------------------------------------------------------------------------------

  /** The commit a revision names, or undefined if it does not exist. */
  async revParse(rev: string): Promise<string | undefined> {
    assertSafeArg("revision", rev);
    assertObjectName(rev);
    const fast = await this.#objects((o) => o.info(`${rev}^{commit}`));
    if (fast !== undefined) return fast.value?.oid;
    const r = await this.run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { ok: [1], readOnly: true });
    return r.exitCode === 1 ? undefined : dec.decode(r.stdout).trim();
  }

  /** HEAD's commit, undefined in a repository with no commits yet. */
  head(): Promise<string | undefined> {
    return this.revParse("HEAD");
  }

  /** The checked-out branch's short name, undefined when HEAD is detached. */
  async currentBranch(): Promise<string | undefined> {
    const name = await this.text(["branch", "--show-current"], { readOnly: true });
    return name === "" ? undefined : name;
  }

  /** Absolute path of this worktree's git directory. */
  gitDir(): Promise<string> {
    return this.#dirs().then((d) => d.git);
  }

  /** Absolute path of the git directory shared by all worktrees. */
  commonDir(): Promise<string> {
    return this.#dirs().then((d) => d.common);
  }

  /** Where the repository lives does not change under a handle, so both directories are asked for once, in one command (a failure is not remembered). */
  #dirs(): Promise<{ git: string; common: string }> {
    if (this.#known === undefined) {
      const p = this.text(["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"], { readOnly: true }).then((out) => {
        const [git, common] = out.split("\n");
        if (git === undefined || common === undefined) throw new GitError(`unexpected output from git rev-parse: ${JSON.stringify(out)}`);
        return { git: this.hostPath(git), common: this.hostPath(common) };
      });
      this.#known = p;
      p.catch(() => (this.#known = undefined));
    }
    return this.#known;
  }

  /** git prints paths with `/` even on Windows; hand a drive-letter or UNC path back with backslashes, the way the host spells it. */
  hostPath(p: string): string {
    return /^(?:[A-Za-z]:\/|\/\/)/.test(p) ? p.replace(/\//g, "\\") : p;
  }

  /** Is `ancestor` reachable from `descendant` (or equal to it)? */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    assertSafeArg("revision", ancestor);
    assertSafeArg("revision", descendant);
    const r = await this.run(["merge-base", "--is-ancestor", ancestor, descendant], { ok: [1], readOnly: true });
    return r.exitCode === 0;
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    assertSafeArg("revision", a);
    assertSafeArg("revision", b);
    const r = await this.run(["merge-base", a, b], { ok: [1], readOnly: true });
    return r.exitCode === 1 ? undefined : dec.decode(r.stdout).trim();
  }

  // ---- files ----------------------------------------------------------------------------------------------

  /** A file's content as of a revision, without touching the worktree. Undefined if the file does not exist there. */
  async readFileAt(rev: string, path: string): Promise<Uint8Array | undefined> {
    assertSafeArg("revision", rev);
    if (path === "" || path.includes("\u0000")) throw new GitError(`invalid path: ${JSON.stringify(path)}`);
    const fast = await this.#objects(async (o) => {
      const info = await o.info(`${rev}:${path}`);
      return info === undefined ? undefined : info.type === "blob" ? await o.read(info.oid) : null; // null: not a file, let git explain
    });
    if (fast !== undefined && fast.value !== null) return fast.value;
    const found = await this.run(["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { ok: [1], readOnly: true });
    if (found.exitCode === 1) return undefined;
    const sha = dec.decode(found.stdout).trim();
    return (await this.run(["cat-file", "blob", sha], { readOnly: true })).stdout;
  }

  /** Paths with changes in the worktree or index, including untracked files. Empty means clean. */
  async status(): Promise<StatusEntry[]> {
    const r = await this.run(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"], { readOnly: true });
    const out: StatusEntry[] = [];
    for (const rec of dec.decode(r.stdout).split("\u0000")) {
      if (rec === "") continue;
      const kind = rec[0];
      if (kind === "1") out.push({ code: rec.slice(2, 4), path: rec.split(" ").slice(8).join(" ") });
      else if (kind === "u") out.push({ code: rec.slice(2, 4), path: rec.split(" ").slice(10).join(" ") });
      else if (kind === "?" || kind === "!") out.push({ code: kind + kind, path: rec.slice(2) });
    }
    return out;
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0;
  }

  /**
   * Stage every change in the worktree, including deletions (respecting .gitignore). A file another handle is writing (a blob lands as
   * `<name>.tmp-<hex>` and is renamed into place) can be gone between git listing it and reading it: that is retried, a few times.
   */
  async addAll(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.run(["add", "--all"]);
        return;
      } catch (e) {
        if (attempt >= 5 || !isVanishedTempFile(e)) throw e;
        await new Promise((r) => setTimeout(r, 20 * attempt));
      }
    }
  }

  /** Write bytes to the object database and return the blob's hash. Does not touch the worktree or index. */
  async hashObject(data: Uint8Array): Promise<string> {
    const r = await this.run(["hash-object", "-w", "--stdin"], { stdin: data });
    return dec.decode(r.stdout).trim();
  }

  /** Stage a blob (from `hashObject`) as `path` without touching the worktree file: used to commit a prefix of a file. */
  async stageContent(path: string, blob: string, mode = "100644"): Promise<void> {
    assertSafeArg("path", path);
    assertSafeArg("object", blob);
    await this.run(["update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`]);
  }

  /** Stage the given paths, including deletions. */
  async add(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["add", "--all", "--", ...paths]);
  }

  static #message(opts: CommitOptions): string {
    if (opts.message.includes("\u0000")) throw new GitError("commit message contains a NUL");
    let message = opts.message.replace(/\n+$/, "");
    if (opts.trailers !== undefined && opts.trailers.length > 0) {
      for (const [k, v] of opts.trailers) {
        if (!TRAILER_KEY.test(k)) throw new GitError(`invalid trailer key ${JSON.stringify(k)}`);
        if (!NO_CONTROL.test(v) || v.trim() === "") throw new GitError(`invalid trailer value for ${k}: must be one line, no control characters`);
      }
      message += `\n\n${opts.trailers.map(([k, v]) => `${k}: ${v.trim()}`).join("\n")}`;
    }
    return `${message}\n`;
  }

  static #identityEnv(opts: CommitOptions): Record<string, string> {
    const env: Record<string, string> = {};
    if (opts.author !== undefined) {
      env["GIT_AUTHOR_NAME"] = opts.author.name;
      env["GIT_AUTHOR_EMAIL"] = opts.author.email;
    }
    if (opts.committer !== undefined) {
      env["GIT_COMMITTER_NAME"] = opts.committer.name;
      env["GIT_COMMITTER_EMAIL"] = opts.committer.email;
    }
    if (opts.date !== undefined) {
      env["GIT_AUTHOR_DATE"] = opts.date;
      env["GIT_COMMITTER_DATE"] = opts.date;
    }
    return env;
  }

  /** Commit everything staged. Returns the new commit's hash. */
  async commit(opts: CommitOptions): Promise<string> {
    const message = Git.#message(opts);
    // The summary line git prints names the new commit; with abbreviation off it is the full hash, which saves a process.
    const args = ["-c", "core.abbrev=no", "commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-F", "-"];
    if (opts.allowEmpty === true) args.push("--allow-empty");
    if (opts.paths !== undefined) args.push("--only", "--", ...opts.paths);
    const r = await this.run(args, { stdin: enc.encode(message), env: Git.#identityEnv(opts) });
    const hash = /^\[[^\]]*? ([0-9a-f]{40,64})\]/.exec(dec.decode(r.stdout))?.[1] ?? (await this.head());
    if (hash === undefined) throw new GitError("commit succeeded but HEAD does not resolve");
    return hash;
  }

  /**
   * Create a commit whose tree is `parent`'s tree with the given files replaced or added, without touching
   * any worktree, the real index or any branch. The commit is unreachable until something points at it.
   * This is how a branch is started from an earlier commit with its first entry already in place.
   */
  async commitOnto(parent: string, files: ReadonlyArray<{ path: string; data: Uint8Array; mode?: string }>, opts: CommitOptions): Promise<string> {
    assertSafeArg("revision", parent);
    const tree = await this.rewriteTree(await this.treeOf(parent), files.map((f) => ({ path: f.path, data: f.data, ...(f.mode === undefined ? {} : { mode: f.mode }) })));
    return this.commitTree(tree, [parent], opts);
  }

  /**
   * Look up many objects in one command. `specs` are anything git accepts as an object name, such as
   * `<commit>:path`. Missing objects come back as undefined, in the order asked.
   */
  async objectInfo(specs: readonly string[]): Promise<(ObjectInfo | undefined)[]> {
    if (specs.length === 0) return [];
    for (const sp of specs) assertObjectName(sp);
    const r = await this.run(["cat-file", "--batch-check"], { stdin: enc.encode(`${specs.join("\n")}\n`), readOnly: true });
    const lines = dec.decode(r.stdout).split("\n");
    return specs.map((_, i) => {
      const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(lines[i] ?? "");
      return m === null ? undefined : { oid: m[1] as string, type: m[2] as string, size: Number(m[3]) };
    });
  }

  /** The content of many blobs in one command, in the order asked; undefined for any that is missing. */
  async readObjects(specs: readonly string[]): Promise<(Uint8Array | undefined)[]> {
    if (specs.length === 0) return [];
    for (const sp of specs) assertObjectName(sp);
    const out = (await this.run(["cat-file", "--batch"], { stdin: enc.encode(`${specs.join("\n")}\n`), readOnly: true })).stdout;
    const results: (Uint8Array | undefined)[] = [];
    let at = 0;
    for (let i = 0; i < specs.length; i++) {
      let nl = at;
      while (nl < out.length && out[nl] !== 10) nl++;
      const header = dec.decode(out.subarray(at, nl));
      const m = /^[0-9a-f]{40,64} \S+ (\d+)$/.exec(header);
      if (m === null) {
        results.push(undefined); // "<name> missing"
        at = nl + 1;
        continue;
      }
      const size = Number(m[1]);
      results.push(out.subarray(nl + 1, nl + 1 + size));
      at = nl + 1 + size + 1;
    }
    return results;
  }

  /**
   * A session for reading many objects one after another: a single `git cat-file --batch-command` process
   * when the host can keep one running (`Host.spawn`), otherwise one short process per request. Close it when
   * done.
   */
  async catFile(): Promise<ObjectReader> {
    return this.#catFile(this.cwd, {});
  }

  async #catFile(cwd: string, env: Record<string, string>): Promise<ObjectReader> {
    if (this.host.spawn === undefined) return fallbackReader(this);
    const proc = await this.host.spawn(this.#opts.program ?? "git", [...this.#base(), "cat-file", "--batch-command"], {
      cwd,
      env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
    });
    const session: CatFileSession = new CatFileSession(proc, { onClosed: () => void this.#sessions.delete(session) });
    this.#sessions.add(session);
    return session;
  }

  /**
   * Answer a question about objects from a `cat-file` process that stays running between questions, and closes itself after a
   * second of silence (so nobody has to close it). Starting git is the slow part, most of all on Windows, and the same few
   * questions (what commit is HEAD, what is in the transcript at this commit) are asked again and again. Undefined means "not
   * available": the host cannot keep a process, or it failed, and the caller asks the ordinary way.
   */
  async #objects<T>(ask: (reader: ObjectReader) => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.host.spawn === undefined) return undefined;
    clearTimeout(this.#sharedIdle);
    this.#sharedBusy++;
    try {
      // It runs in the repository's shared git directory, not the worktree: Windows will not delete a directory a process is running in,
      // and a worktree can be removed while the reader is still idle. GIT_DIR makes it answer for this worktree (its HEAD) all the same.
      this.#shared ??= Promise.all([this.commonDir(), this.gitDir()]).then(([common, dir]) => this.#catFile(common, { GIT_DIR: dir }));
      return { value: await ask(await this.#shared) };
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      const dead = this.#shared;
      this.#shared = undefined;
      void dead?.then((r) => r.close()).catch(() => undefined);
      return undefined;
    } finally {
      if (--this.#sharedBusy === 0) {
        // Not unref'd: while the process runs it keeps the program alive anyway, and a timer that may not fire would leave it running.
        this.#sharedIdle = setTimeout(() => {
          const r = this.#shared;
          this.#shared = undefined;
          void r?.then((x) => x.close()).catch(() => undefined);
        }, 1000);
      }
    }
  }

  /** Close every `catFile` session still open on this handle. Safe to call at any time. */
  async closeSessions(): Promise<void> {
    clearTimeout(this.#sharedIdle);
    this.#shared = undefined;
    await Promise.all([...this.#sessions].map((s) => s.close().catch(() => undefined)));
  }

  /** Files under `paths`: those git tracks (in the index), or those it does not (and has not been told to ignore). */
  async listFiles(paths: readonly string[], which: "tracked" | "untracked"): Promise<string[]> {
    const args = which === "tracked" ? ["ls-files", "-z", "--cached", "--"] : ["ls-files", "-z", "--others", "--exclude-standard", "--"];
    const r = await this.run([...args, ...paths], { readOnly: true });
    return dec.decode(r.stdout).split("\u0000").filter((p) => p !== "");
  }

  /** Make the index match HEAD, leaving the working tree alone. Used after commits were written without the index. */
  async syncIndex(): Promise<void> {
    await this.run(["reset", "--quiet", "--mixed", "HEAD", "--"]);
  }

  /**
   * Write a chain of commits onto `ref` with one `git fast-import` process, however many there are, and return
   * their hashes. The first commit's parent is `parent` (none if undefined); each next one follows the one
   * before. The ref moves once, when the stream ends, so a failure leaves it where it was. The index and
   * working tree are not touched (see `syncIndex`).
   */
  async importCommits(ref: string, parent: string | undefined, commits: readonly ImportCommit[]): Promise<string[]> {
    if (commits.length === 0) return [];
    assertSafeArg("ref", ref);
    const parts: Uint8Array[] = [];
    const text = (t: string): void => void parts.push(enc.encode(t));
    const data = (b: Uint8Array): void => {
      text(`data ${b.length}\n`);
      parts.push(b);
      text("\n");
    };
    const ident = (kind: string, who: Identity, when: string): void => {
      if (!/^[^<>\n\u0000]+$/.test(who.name) || !/^[^<>\n\u0000 ]+$/.test(who.email)) throw new GitError(`invalid ${kind} identity`);
      text(`${kind} ${who.name} <${who.email}> ${when}\n`);
    };
    for (const [i, c] of commits.entries()) {
      const ms = c.date === undefined ? Date.now() : Date.parse(c.date);
      if (!Number.isFinite(ms)) throw new GitError(`invalid commit date ${JSON.stringify(c.date)}`);
      const when = `${Math.floor(ms / 1000)} +0000`;
      text(`commit ${ref}\nmark :${i + 1}\n`);
      ident("author", c.author, when);
      ident("committer", c.committer, when);
      data(enc.encode(Git.#message(c)));
      if (i === 0 && parent !== undefined) text(`from ${parent}\n`);
      for (const f of c.files) {
        if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(f.path) || f.path.includes("//") || f.path.includes("..")) throw new GitError(`unsupported path for import: ${JSON.stringify(f.path)}`);
        text(`M 100644 inline ${f.path}\n`);
        data(f.data);
      }
      text("\n");
    }
    for (let i = 0; i < commits.length; i++) text(`get-mark :${i + 1}\n`);
    text("done\n");
    const total = parts.reduce((n, p) => n + p.length, 0);
    const input = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      input.set(p, at);
      at += p.length;
    }
    const out = dec.decode((await this.run(["fast-import", "--quiet", "--done"], { stdin: input })).stdout).split("\n").filter((l) => l !== "");
    if (out.length !== commits.length || !out.every((h) => /^[0-9a-f]{40,64}$/.test(h))) throw new GitError(`git fast-import returned unexpected output: ${out.join(" ").slice(0, 200)}`);
    return out;
  }

  /** The tree a revision points at. */
  async treeOf(rev: string): Promise<string> {
    assertSafeArg("revision", rev);
    const fast = await this.#objects((o) => o.info(`${rev}^{tree}`));
    if (fast?.value !== undefined) return fast.value.oid;
    return this.text(["rev-parse", "--verify", `${rev}^{tree}`], { readOnly: true });
  }

  /**
   * Merge two commits in memory (no worktree, index or ref is touched) and report the result: the merged
   * tree, which paths conflict, and git's messages. A conflicted merge is a normal result, not an error.
   */
  async mergeTree(ours: string, theirs: string): Promise<MergeTreeResult> {
    assertSafeArg("revision", ours);
    assertSafeArg("revision", theirs);
    const r = await this.run(["merge-tree", "--write-tree", "-z", "--name-only", ours, theirs], { ok: [1], readOnly: true });
    const f = dec.decode(r.stdout).split("\u0000");
    const tree = f[0] ?? "";
    let i = 1;
    const conflictedPaths: string[] = [];
    while (i < f.length && f[i] !== "") conflictedPaths.push(f[i++] as string);
    i++; // the empty field that ends the path list
    const messages: MergeMessage[] = [];
    while (i < f.length && f[i] !== "") {
      const n = Number(f[i++]);
      if (!Number.isSafeInteger(n) || n < 0) throw new GitError(`unexpected merge-tree output near ${JSON.stringify(f[i - 1])}`);
      const paths = f.slice(i, i + n);
      i += n;
      messages.push({ paths, type: f[i++] ?? "", message: (f[i++] ?? "").replace(/\n$/, "") });
    }
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError("merge-tree did not return a tree");
    return { tree, clean: r.exitCode === 0, conflictedPaths, messages };
  }

  /**
   * A new tree: `tree` with the edits applied. Uses a temporary index file, so nothing real is touched. The edits are worked out
   * on a copy of the index held here and written back with one `update-index --index-info`, instead of a few git processes per edit.
   */
  async rewriteTree(tree: string, edits: readonly TreeEdit[]): Promise<string> {
    assertSafeArg("tree", tree);
    return this.#withTempIndex(tree, async (env) => {
      const literal = { ...env, GIT_LITERAL_PATHSPECS: "1" };
      const initial = new Map<string, string>(); // path -> "mode sha"
      for (const rec of dec.decode((await this.run(["ls-files", "-s", "-z"], { env: literal })).stdout).split("\u0000")) {
        if (rec === "") continue;
        const tab = rec.indexOf("\t");
        const [mode, sha] = rec.slice(0, tab).split(" ");
        initial.set(rec.slice(tab + 1), `${mode} ${sha}`);
      }
      const now = new Map(initial);
      const removeUnder = (path: string): void => {
        const dir = `${path.replace(/\/+$/, "")}/`;
        for (const p of [...now.keys()]) if (p === path || p.startsWith(dir)) now.delete(p);
      };
      for (const e of edits) {
        assertSafeArg("path", e.path);
        removeUnder(e.path);
        if ("data" in e) now.set(e.path, `${e.mode ?? "100644"} ${await this.hashObject(e.data)}`);
        else if ("from" in e) {
          const there = dec.decode((await this.run(["ls-tree", "-r", "-z", e.from, "--", e.path], { env: literal })).stdout).split("\u0000").filter((x) => x !== "");
          for (const rec of there) {
            const tab = rec.indexOf("\t");
            const [mode, , sha] = rec.slice(0, tab).split(" ");
            now.set(rec.slice(tab + 1), `${mode} ${sha}`);
          }
        }
      }
      const zero = "0".repeat(tree.length);
      const lines: string[] = [];
      for (const p of initial.keys()) if (!now.has(p)) lines.push(`0 ${zero}\t${p}`); // removals first: a file may become a directory
      for (const [p, v] of now) if (initial.get(p) !== v) lines.push(`${v}\t${p}`);
      if (lines.length > 0) await this.run(["update-index", "-z", "--index-info"], { env, stdin: enc.encode(lines.map((l) => `${l}\u0000`).join("")) });
      return this.text(["write-tree"], { env });
    });
  }

  /** Create a commit object for `tree` with the given parents. Unreachable until a ref points at it. */
  async commitTree(tree: string, parents: readonly string[], opts: CommitOptions): Promise<string> {
    assertSafeArg("tree", tree);
    const args = ["commit-tree", tree];
    for (const p of parents) {
      assertSafeArg("revision", p);
      args.push("-p", p);
    }
    args.push("-F", "-");
    return this.text(args, { stdin: enc.encode(Git.#message(opts)), env: Git.#identityEnv(opts) });
  }

  /**
   * Move the current branch forward to `commit` (which must descend from HEAD), updating the index and
   * worktree as `git merge --ff-only` does. Refuses if local changes would be overwritten.
   */
  async fastForward(commit: string): Promise<void> {
    assertSafeArg("revision", commit);
    await this.run(["merge", "--ff-only", "--quiet", commit]);
  }

  async #withTempIndex<T>(tree: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const dir = this.host.path.join(await this.commonDir(), "chattree", "tmp");
    await this.host.fs.mkdir(dir);
    const index = this.host.path.join(dir, `index-${crypto.randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.run(["read-tree", tree], { env });
      return await fn(env);
    } finally {
      await this.host.fs.remove(index).catch(() => false);
    }
  }

  /** Discard uncommitted changes to the given paths (restore them from HEAD). */
  async restore(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths]);
  }

  // ---- history --------------------------------------------------------------------------------------------

  /** Commits reachable from `rev` (newest first), with their trailers. */
  async log(rev: string, opts: { maxCount?: number; firstParent?: boolean; paths?: readonly string[] } = {}): Promise<CommitInfo[]> {
    assertSafeArg("revision", rev);
    const fmt = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%s%x1f%(trailers:only,unfold)";
    const args = ["log", "-z", `--format=${fmt}`];
    if (opts.maxCount !== undefined) args.push(`--max-count=${opts.maxCount}`);
    if (opts.firstParent === true) args.push("--first-parent");
    args.push(rev, "--", ...(opts.paths ?? []));
    const r = await this.run(args, { readOnly: true });
    const out: CommitInfo[] = [];
    for (const rec of dec.decode(r.stdout).split("\u0000")) {
      if (rec === "") continue;
      const f = rec.split("\u001f");
      const trailers: Record<string, string[]> = {};
      for (const line of (f[8] ?? "").split("\n")) {
        const i = line.indexOf(": ");
        if (i <= 0) continue;
        (trailers[line.slice(0, i)] ??= []).push(line.slice(i + 2));
      }
      out.push({
        hash: f[0] ?? "",
        parents: (f[1] ?? "") === "" ? [] : (f[1] ?? "").split(" "),
        authorName: f[2] ?? "",
        authorEmail: f[3] ?? "",
        authorDate: (f[4] ?? "").replace(/Z$/, "+00:00"),
        committerName: f[5] ?? "",
        committerEmail: f[6] ?? "",
        subject: f[7] ?? "",
        trailers,
      });
    }
    return out;
  }

  /** Files that differ between two revisions (renames are reported as a delete and an add). */
  async diff(from: string, to: string, pathspecs: readonly string[] = []): Promise<DiffEntry[]> {
    assertSafeArg("revision", from);
    assertSafeArg("revision", to);
    const r = await this.run(["diff", "--name-status", "-z", "--no-renames", from, to, "--", ...pathspecs], { readOnly: true });
    const parts = dec.decode(r.stdout).split("\u0000");
    const out: DiffEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: (parts[i] ?? "")[0] ?? "", path: parts[i + 1] ?? "" });
    return out;
  }

  // ---- branches -------------------------------------------------------------------------------------------

  /** Local branches whose name starts with `prefix` (all by default). */
  async branches(prefix = ""): Promise<RefInfo[]> {
    if (prefix.includes("\u0000")) throw new GitError(`invalid branch prefix: ${JSON.stringify(prefix)}`);
    const r = await this.run(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads"], { readOnly: true });
    // for-each-ref patterns only match whole path components, so the prefix is applied here.
    return dec
      .decode(r.stdout)
      .split("\n")
      .filter((l) => l !== "" && l.startsWith(`refs/heads/${prefix}`))
      .map((l) => {
        const [ref = "", hash = ""] = l.split("\u0000");
        return { ref, hash };
      });
  }

  async isValidBranchName(name: string): Promise<boolean> {
    if (name === "" || name === "@" || name.startsWith("-") || name.includes("\u0000")) return false;
    const r = await this.run(["check-ref-format", `refs/heads/${name}`], { ok: [1], readOnly: true });
    return r.exitCode === 0;
  }

  /** Create a branch at `start` without checking it out. Throws if it exists. */
  async createBranch(name: string, start: string): Promise<void> {
    if (!(await this.isValidBranchName(name))) throw new GitError(`invalid branch name: ${JSON.stringify(name)}`);
    assertSafeArg("revision", start);
    await this.run(["branch", "--no-track", "--", name, start]);
  }

  async deleteBranch(name: string, opts: { force?: boolean } = {}): Promise<void> {
    assertSafeArg("branch name", name);
    await this.run(["branch", opts.force === true ? "-D" : "-d", "--", name]);
  }

  // ---- worktrees ------------------------------------------------------------------------------------------

  async worktrees(): Promise<WorktreeInfo[]> {
    const r = await this.run(["worktree", "list", "--porcelain", "-z"], { readOnly: true });
    const out: WorktreeInfo[] = [];
    let cur: WorktreeInfo | undefined;
    for (const field of dec.decode(r.stdout).split("\u0000")) {
      if (field === "") {
        if (cur !== undefined) out.push(cur);
        cur = undefined;
      } else if (field.startsWith("worktree ")) {
        cur = { path: this.hostPath(field.slice(9)), head: undefined, branch: undefined, bare: false, detached: false, locked: false, prunable: false };
      } else if (cur !== undefined) {
        if (field.startsWith("HEAD ")) cur.head = field.slice(5);
        else if (field.startsWith("branch ")) cur.branch = field.slice(7);
        else if (field === "bare") cur.bare = true;
        else if (field === "detached") cur.detached = true;
        else if (field === "locked" || field.startsWith("locked ")) cur.locked = true;
        else if (field === "prunable" || field.startsWith("prunable ")) cur.prunable = true;
      }
    }
    if (cur !== undefined) out.push(cur);
    return out;
  }

  /** Check out an existing branch in a new linked worktree, or with `newBranch` create the branch at `start` first. */
  async addWorktree(path: string, target: { branch: string } | { newBranch: string; start: string }): Promise<void> {
    assertSafeArg("path", path);
    if ("branch" in target) {
      assertSafeArg("branch name", target.branch);
      await this.run(["worktree", "add", "--quiet", "--", path, target.branch]);
      return;
    }
    if (!(await this.isValidBranchName(target.newBranch))) throw new GitError(`invalid branch name: ${JSON.stringify(target.newBranch)}`);
    assertSafeArg("revision", target.start);
    await this.run(["worktree", "add", "--quiet", "--no-track", "-b", target.newBranch, "--", path, target.start]);
  }

  async removeWorktree(path: string, opts: { force?: boolean } = {}): Promise<void> {
    assertSafeArg("path", path);
    await this.run(["worktree", "remove", ...(opts.force === true ? ["--force"] : []), "--", path]);
  }

  async pruneWorktrees(): Promise<void> {
    await this.run(["worktree", "prune"]);
  }
}

/** The same interface without a long-running process, for hosts that cannot keep one. */
function fallbackReader(git: Git): ObjectReader {
  return {
    info: async (spec) => (await git.objectInfo([spec]))[0],
    read: async (spec) => (await git.readObjects([spec]))[0],
    close: async () => undefined,
  };
}

/** `git add` failed because a temporary file (`*.tmp-<hex>`, see `writeAtomic`) was renamed away while git looked at it. */
export function isVanishedTempFile(e: unknown): boolean {
  const stderr = e instanceof GitError && typeof (e as { stderr?: unknown }).stderr === "string" ? (e as { stderr: string }).stderr : e instanceof Error ? e.message : "";
  return /unable to stat '[^']*\.tmp-[0-9a-f]+': No such file or directory/.test(stderr);
}
