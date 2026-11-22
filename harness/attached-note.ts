/**
 * The note that tells a thread about its attached repositories (ADR 38): which they are, that the workspace itself is scratch space
 * and they are where the work that ships goes, and, for a fork or a subagent, how its code is meant to come back. The text depends only
 * on the paths and what the thread was started with, so the model is told once and again only when one of them changes.
 */
import type { Conversation } from "./conversation.ts";
import type { InjectionContext, InjectionRule } from "./injections.ts";
import { discoverAttached } from "./attached.ts";

export const ATTACHED_NOTE_KEY = "attached-repos";

export interface AttachedNoteSettings {
  guidance: boolean;
  /** What a branch for a thread's commits is called: `<prefix>/<name>`. */
  prefix: string;
}

export function attachedNoteText(
  paths: readonly string[],
  integrate: "share" | "thread" | "parent" | undefined,
  isSide: boolean,
  settings: AttachedNoteSettings,
): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `\`${p}\``).join(", ");
  const lines = [
    `Attached ${paths.length === 1 ? "repository" : "repositories"}: ${list}. ${paths.length === 1 ? "It is the user's code repository" : "They are the user's code repositories"}, inside the workspace as git submodules, and git is fine in them.`,
  ];
  if (settings.guidance)
    lines.push(
      `Use the workspace itself as scratch space for notes and temporary files, and put the work that is to ship in ${paths.length === 1 ? "the repository" : "the repositories"}. Commit there only when the user asks you to (if they have told you to commit as you go, do).`,
    );
  if (isSide) {
    if (integrate === "thread")
      lines.push(
        `Your code is to come back on a branch: start one in each repository you change (git switch -c ${settings.prefix}/<a name for the work>) and commit as you go. When you hand back you are told if it must be rebased onto the code of the thread you came from; do that and resolve any conflicts.`,
      );
    else if (integrate === "parent")
      lines.push(
        `Your code is to come back on a branch for the thread you came from to integrate: start one in each repository you change (git switch -c ${settings.prefix}/<a name for the work>), commit there, and do not merge or rebase it into the other thread's branch.`,
      );
    else
      lines.push(
        "Your changes to the code are shared with the thread you came from and merge like its files do: leave them uncommitted, and do not commit, switch branches or reset there. If you do commit, they are folded back into uncommitted changes when you hand back, and the history is lost.",
      );
  }
  return lines.join("\n");
}

/** Say which repositories are attached on the first request in a thread, and again only when the text would differ. */
export function attachedRule(convo: Conversation, settings: AttachedNoteSettings): InjectionRule {
  return async (ctx: InjectionContext) => {
    if ((await convo.host.fs.stat(convo.host.path.join(convo.dir, ".gitmodules"))) === undefined) return undefined;
    const paths = (await discoverAttached(convo.host, convo.git)).map((a) => a.path);
    const start = ctx.entries.findLast((e) => e.$tag === "branch_start");
    const text = attachedNoteText(paths, start?.$tag === "branch_start" ? start.integrate : undefined, start !== undefined, settings);
    if (text === "") return undefined;
    const last = ctx.entries.findLast((e) => e.$tag === "injection" && e.key === ATTACHED_NOTE_KEY);
    if (last?.$tag === "injection" && last.text === text) return undefined;
    return { key: ATTACHED_NOTE_KEY, text };
  };
}
