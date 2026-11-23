/** The errors a `Conversation` throws for what it refuses to do. */
/**
 * A conversation: one thread, which is the transcript `chat.yml` committed on a branch of a Git repository, and the
 * `Conversation` handle through which everything that changes it goes. Each append commits the entry together with the
 * workspace changes since the last commit, so the transcript and the files stay in step. Forks, subagents and new
 * threads are branches, each with its own worktree; merges are trunk-wins and recorded as entries. Opening repairs what a
 * crash left (a torn append, uncommitted entries, an unfinished request journal). Every other module reads or writes the
 * thread through this class, and the harness modules that work on a thread (loop, pump, turn) are its callers.
 */

export class ConversationError extends Error {
  override name = "ConversationError";
}

/**
 * The agent has no model yet, and what was asked needs one (a request, a compaction, pinning prices). A conversation
 * can be started without one (its first setup is made when a provider and model are chosen), so this is a refusal at the
 * mutation, with the way out, not a fault in the history.
 */
export class NoModelPinned extends ConversationError {
  override name = "NoModelPinned";
  constructor(what: string) {
    super(
      `this conversation has no model yet, so it cannot ${what}: add a provider and choose a model first (the \`setup\` entry that pins one)`,
    );
  }
}

/** What `Conversation.switchWorkspace` refuses to do on its own: files not yet saved in either folder. */
export class WorkspaceDirty extends ConversationError {
  override name = "WorkspaceDirty";
  /** Per thread, the paths with unsaved changes. */
  readonly files: { branch: string; paths: string[] }[];
  constructor(files: { branch: string; paths: string[] }[]) {
    super(
      `there are changes not yet saved in ${files.map((f) => `${f.branch} (${f.paths.slice(0, 3).join(", ")}${f.paths.length > 3 ? ", ..." : ""})`).join(" and ")}; pass uncommitted: "snapshot" to save them as a snapshot first`,
    );
    this.files = files;
  }
}
