import { CHAT_FILE, CONFIG_FILE } from "../harness/conversation.ts";
import { versionProblem } from "../harness/entries.ts";
import { Git } from "../src/index.ts";
import type { AppEnv } from "./env.ts";

/** What can be done with a folder of the workspace. */
export type FolderState =
  /** It holds a conversation (at `root`) that opens. */
  | { kind: "conversation" }
  /** It holds none yet: `new` makes a git repository in it, `adopt` starts on the checked-out branch of the repository it is. */
  | { kind: "init"; mode: "new" | "adopt" }
  /** Nothing can be done with it, and why. */
  | { kind: "unusable"; reason: string };

export interface WorkspaceFolder {
  /** The folder as the workspace names it. */
  path: string;
  /** The folder's own name, for a label. */
  name: string;
  /** The top level of the repository that holds a conversation, which is where the project is (the folder itself, or an ancestor); else the folder. */
  root: string;
  state: FolderState;
}

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Look at one folder: is there a conversation, can one be started, or neither. Never throws: a problem is the folder's `unusable` reason. */
export async function inspectFolder(env: Pick<AppEnv, "host">, path: string): Promise<WorkspaceFolder> {
  const { host } = env;
  const name = path.split(/[\\/]/).findLast((part) => part !== "") ?? path;
  const folder = (root: string, state: FolderState): WorkspaceFolder => ({ path, name, root, state });
  if ((await host.fs.stat(path)) === undefined) return folder(path, { kind: "unusable", reason: "the folder does not exist" });
  const probe = await Git.open(host, { cwd: path }).catch(() => undefined);
  const top =
    probe === undefined
      ? undefined
      : await probe.run(["rev-parse", "--show-toplevel"], { ok: [128], readOnly: true }).catch(() => undefined);
  const root = top === undefined || top.exitCode !== 0 ? undefined : probe?.hostPath(new TextDecoder().decode(top.stdout).trim());
  if (root === undefined || root === "") return folder(path, { kind: "init", mode: "new" });
  // The nearest enclosing repository decides, as for the command line: a nested folder belongs to its parent's conversation.
  if ((await host.fs.stat(host.path.join(root, CONFIG_FILE))) !== undefined) {
    // Not opened: opening takes the thread's lock, which a turn in another window holds. The header's version says whether this build reads it.
    try {
      const head = await probe?.withCwd(root).readFileAt("HEAD", CHAT_FILE);
      if (head === undefined)
        return folder(root, { kind: "unusable", reason: `${root} has ${CONFIG_FILE} but no ${CHAT_FILE}: not a conversation` });
      const text = new TextDecoder().decode(head.subarray(0, 400));
      const major = /\bmajor: (\d+)/.exec(text)?.[1];
      const minor = /\bminor: (\d+)/.exec(text)?.[1];
      if (major === undefined || minor === undefined)
        return folder(root, { kind: "unusable", reason: `${root}'s ${CHAT_FILE} does not start with a header` });
      const problem = versionProblem({ major: Number(major), minor: Number(minor) }, undefined);
      if (problem !== undefined) return folder(root, { kind: "unusable", reason: problem });
    } catch (e) {
      return folder(root, { kind: "unusable", reason: `the conversation in ${root} cannot be read: ${failure(e)}` });
    }
    return folder(root, { kind: "conversation" });
  }
  if (host.path.resolve(root) === host.path.resolve(path)) return folder(root, { kind: "init", mode: "adopt" });
  return folder(root, {
    kind: "unusable",
    reason: `inside the git repository ${root}, which has no conversation (start one in that folder)`,
  });
}

/** The folders of the workspace, in order; two that belong to the same conversation are listed once. */
export async function inspectWorkspace(env: Pick<AppEnv, "host">, paths: readonly string[]): Promise<WorkspaceFolder[]> {
  const out: WorkspaceFolder[] = [];
  for (const p of paths) {
    const f = await inspectFolder(env, p);
    if (!out.some((o) => o.root === f.root && o.state.kind === "conversation" && f.state.kind === "conversation")) out.push(f);
  }
  return out;
}
