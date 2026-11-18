/**
 * Which actions the graph offers on a commit, and when one is unavailable and why. The view builds its context menu
 * from this and never decides itself; the reason of a disabled action is shown to the person.
 */
import type { GraphData, GraphThread } from "./graph.ts";

export interface GraphAction {
  id: "open" | "fork" | "rewind" | "merge";
  label: string;
  enabled: boolean;
  /** Why it is unavailable. */
  reason?: string;
}

/** What a thread in each state prevents: changing a thread that is working or held by another window is refused. */
const busyReason = (t: GraphThread): string | undefined =>
  t.status === "running"
    ? "stop the thread first"
    : t.status === "awaiting"
      ? "answer its question first"
      : t.status === "elsewhere"
        ? "another window is using this thread"
        : undefined;

/** The actions for a commit (the newest commit of a folded chain stands for the chain). */
export function actionsFor(data: GraphData, commitHash: string): GraphAction[] {
  const commit = data.commits.find((c) => c.hash === commitHash);
  const thread = data.threads.find((t) => t.name === commit?.thread);
  if (commit === undefined || thread === undefined) return [];
  const busy = busyReason(thread);
  const isTip = thread.tip === commit.hash;
  const actions: GraphAction[] = [
    { id: "open", label: "Open in chat", enabled: true },
    { id: "fork", label: "Fork from here", enabled: true },
    {
      id: "rewind",
      label: "Rewind to here",
      enabled: !isTip && busy === undefined,
      ...(isTip ? { reason: "already the latest commit" } : busy === undefined ? {} : { reason: busy }),
    },
  ];
  if (isTip && thread.name !== data.trunk) {
    const reason = thread.merged === true ? "already merged" : busy;
    actions.push({
      id: "merge",
      label: `Merge into ${data.trunk}`,
      enabled: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return actions;
}
