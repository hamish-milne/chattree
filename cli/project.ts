import { Conversation, ConversationError, type ConversationOptions } from "../harness/conversation.ts";
import { ownerIsDead } from "./owner.ts";
import { CONFIG_FILE } from "../harness/conversation.ts";
import { envSource } from "../harness/secrets.ts";
import { defaultRegistry } from "../providers/index.ts";
import { Git, GitError } from "../src/index.ts";
import { CliError, type Io } from "./io.ts";

/** A chattree project: a git working tree that contains `harness.yml` (see docs/cli.md, section 2). */
export interface Project {
  /** The working tree the search found (the top level of the repository or linked worktree). */
  root: string;
  /** The repository's main working tree: threads that have no worktree get one under its `.chattree/threads/`. */
  mainRoot: string;
  /** Where threads without a worktree get one: `git config chattree.worktrees` (relative to `mainRoot`, or absolute), default `.chattree/threads`. */
  worktreeRoot: string;
  git: Git;
  /** The branch checked out at `root`. */
  branch: string;
}

/**
 * Find the project from `start`: the nearest enclosing git top level decides. If it has `harness.yml` that is the project;
 * if not, the search stops (a nested repository never adopts its parent's conversation).
 */
export async function findProject(io: Io, start: string): Promise<Project> {
  const probe = await Git.open(io.host, { cwd: start }).catch(() => undefined);
  const top = probe === undefined ? undefined : await probe.run(["rev-parse", "--show-toplevel"], { ok: [128], readOnly: true }).catch(() => undefined);
  const root = top === undefined || top.exitCode !== 0 ? undefined : probe?.hostPath(new TextDecoder().decode(top.stdout).trim());
  if (probe === undefined || root === undefined || root === "") throw new CliError(`${start} is not inside a git repository, so there is no chattree project here`, "run `chattree init` to start one, or pass -C <dir>");
  const git = probe.withCwd(root);
  if ((await io.host.fs.stat(io.host.path.join(root, CONFIG_FILE))) === undefined) {
    throw new CliError(`${root} has no ${CONFIG_FILE}: it is not a chattree project`, "run `chattree init` (or `chattree init --adopt` for a repository you already have)");
  }
  const branch = await git.currentBranch();
  if (branch === undefined) throw new CliError("HEAD is detached, so there is no thread to infer", "check out a branch, or name the thread: `chattree chat <thread>`");
  const worktrees = await git.worktrees();
  const mainRoot = worktrees[0]?.path ?? root;
  const configured = (await git.getConfig("chattree.worktrees").catch(() => undefined))?.trim();
  const worktreeRoot = io.host.path.resolve(mainRoot, configured === undefined || configured === "" ? io.host.path.join(".chattree", "threads") : configured);
  return { root, mainRoot, worktreeRoot, git, branch };
}

/** Conversation options for this machine: every provider adapter, secrets from the environment, the user's git identity on their entries. */
export async function conversationOptions(io: Io, git: Git, opts: { providers?: boolean } = {}): Promise<ConversationOptions> {
  const name = await git.getConfig("user.name").catch(() => undefined);
  const email = await git.getConfig("user.email").catch(() => undefined);
  return {
    now: io.now,
    isOwnerDead: ownerIsDead,
    ...(opts.providers === false ? {} : { providers: { registry: defaultRegistry(), secrets: envSource(io.env) } }),
    ...(name !== undefined && email !== undefined ? { user: { name, email } } : {}),
  };
}

export interface OpenedThread {
  convo: Conversation;
  thread: string;
  /** Set when the providers could not be built (a key variable is not set), so the conversation was opened without them. */
  degraded?: string;
}

/**
 * Open a thread. With no `name`, the thread of the working tree the project was found in (it throws if that branch is not a
 * thread). With a name, that branch's worktree, created under the worktree root if it has none.
 * `providers: "optional"` opens without providers when their keys are missing, for commands that only read.
 */
/** A directory name for a thread: letters, digits, `.`, `_` and `-` only (no `%` or `/`, which URL-minded tools such as vite and cmd.exe mishandle). */
export const safeDirName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "") || "thread";

/** Where a thread without a worktree gets one: under the project's worktree root, in a directory nothing else uses (`fork-1`, then `fork-1-2` ...). */
export async function threadDir(io: Io, project: Project, name: string): Promise<string> {
  const base = safeDirName(name);
  for (let n = 1; ; n++) {
    const dir = io.host.path.join(project.worktreeRoot, n === 1 ? base : `${base}-${n}`);
    if ((await io.host.fs.stat(dir)) === undefined) return dir;
  }
}

export async function openThread(io: Io, project: Project, name?: string, opts: { providers?: "required" | "optional" } = {}): Promise<OpenedThread> {
  const thread = name ?? project.branch;
  let dir = project.root;
  if (name !== undefined && name !== project.branch) {
    const ref = `refs/heads/${name}`;
    if ((await project.git.revParse(ref)) === undefined) throw new CliError(`there is no thread named ${name}`, "list them with `chattree threads`; start one with `/thread new <name>`");
    const existing = (await project.git.worktrees()).find((w) => w.branch === ref);
    if (existing !== undefined) dir = existing.path;
    else {
      dir = await threadDir(io, project, name);
      await io.host.fs.mkdir(io.host.path.dirname(dir));
      await project.git.addWorktree(dir, { branch: name });
    }
  }
  if ((await io.host.fs.stat(io.host.path.join(dir, "chat.yml"))) === undefined) throw new CliError(`the branch ${thread} is not a thread (it has no chat.yml)`, "name a thread with `chattree chat <thread>`, or start one with `/thread new <name>`");
  const git = project.git.withCwd(dir);
  try {
    return { convo: await Conversation.open(io.host, dir, await conversationOptions(io, git)), thread };
  } catch (e) {
    if (opts.providers === "optional" && e instanceof ConversationError && /secrets|environment variable/i.test(e.message)) {
      return { convo: await Conversation.open(io.host, dir, await conversationOptions(io, git, { providers: false })), thread, degraded: e.message };
    }
    if (e instanceof ConversationError || e instanceof GitError) throw new CliError(e.message);
    throw e;
  }
}
