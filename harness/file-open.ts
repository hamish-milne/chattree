/**
 * Where a file a message or a tool call named is to be found. A path in a thread's text is relative to that thread's
 * workspace, and which folder that is can change between the message being written and the person clicking: the
 * thread may be the one checked out in the project folder, may have a worktree of its own, or may have none (a branch
 * that nothing has needed to run). So the place is worked out when the person clicks, from where the thread is checked
 * out at that moment. A thread without a worktree is read from its history, read-only: looking at a file never creates a
 * worktree. A view of "the file after this change" is always read from history, at the commit the block was saved in.
 */
import type { Conversation } from "./conversation.ts";
import { PathRefused, resolveInWorkspace, unreadableRelative } from "./starter/workspace.ts";
import type { Host } from "../src/host.ts";

export interface FileOpenRequest {
  /** The thread (branch) the reference is from. */
  thread: string;
  /** Relative to that thread's workspace. */
  path: string;
  line?: number;
  endLine?: number;
  /** A commit: the file as the thread had it there, instead of as it is now. */
  at?: string;
}

export type FileOpenResult =
  /** A file on disk, to open for editing. `worktree` is the folder it is in: the project folder, or the thread's own. */
  | { kind: "file"; path: string; worktree: string; line?: number; endLine?: number }
  /** Content from history, to show read-only. */
  | {
      kind: "snapshot";
      path: string;
      commit: string;
      text: string;
      line?: number;
      endLine?: number;
      /** Why it is not the file on disk. */
      reason: "requested" | "no-worktree";
    }
  | { kind: "refused"; message: string };

const dec = new TextDecoder("utf-8", { fatal: true });
const places = (r: FileOpenRequest): { line?: number; endLine?: number } => ({
  ...(r.line === undefined ? {} : { line: r.line }),
  ...(r.endLine === undefined ? {} : { endLine: r.endLine }),
});

async function snapshot(
  convo: Conversation,
  r: FileOpenRequest,
  commit: string,
  reason: "requested" | "no-worktree",
): Promise<FileOpenResult> {
  const bytes = await convo.git.readFileAt(commit, r.path.replaceAll("\\", "/"));
  if (bytes === undefined) return { kind: "refused", message: `${r.path} does not exist in ${r.thread} at ${commit.slice(0, 7)}` };
  try {
    return { kind: "snapshot", path: r.path, commit, text: dec.decode(bytes), reason, ...places(r) };
  } catch {
    return { kind: "refused", message: `${r.path} is not a text file` };
  }
}

/** Resolve a request against where the threads are now. `convo` is any handle on the repository. */
export async function resolveFileOpen(convo: Conversation, host: Host, r: FileOpenRequest): Promise<FileOpenResult> {
  const why = unreadableRelative(r.path);
  if (why !== undefined) return { kind: "refused", message: why };
  const branch = (await convo.listBranches()).find((b) => b.name === r.thread);
  if (branch === undefined) return { kind: "refused", message: `there is no thread named ${r.thread}` };
  if (r.at !== undefined) return snapshot(convo, r, r.at, "requested");
  if (branch.worktree === undefined) return snapshot(convo, r, branch.tip, "no-worktree");
  try {
    const abs = await resolveInWorkspace(host, branch.worktree, r.path, "read");
    const stat = await host.fs.stat(abs);
    if (stat === undefined)
      return { kind: "refused", message: `${r.path} does not exist in ${r.thread} (it may have been deleted or renamed)` };
    if (stat.isDirectory) return { kind: "refused", message: `${r.path} is a folder` };
    return { kind: "file", path: abs, worktree: branch.worktree, ...places(r) };
  } catch (e) {
    if (e instanceof PathRefused) return { kind: "refused", message: e.message };
    throw e;
  }
}
