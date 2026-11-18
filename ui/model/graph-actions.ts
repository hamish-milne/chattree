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

/** Whether something may be done, and if not, why. */
export interface Verdict {
  ok: boolean;
  reason?: string;
}

const no = (reason: string): Verdict => ({ ok: false, reason });

/** Whether a thread can be picked up and dragged to be merged: the trunk is merged into nothing, and a busy thread is not changed. */
export function canDragThread(data: GraphData, name: string): Verdict {
  const t = data.threads.find((x) => x.name === name);
  if (t === undefined) return no("no such thread");
  if (t.name === data.trunk) return no(`${t.name} is the trunk; drag a fork onto it instead`);
  if (t.merged === true) return no("already merged");
  const busy = busyReason(t);
  return busy === undefined ? { ok: true } : no(busy);
}

/** Whether the dragged thread can be dropped on `into` to merge into it. */
export function canDropOn(data: GraphData, from: string, into: string): Verdict {
  const target = data.threads.find((x) => x.name === into);
  if (target === undefined) return no("no such thread");
  if (from === into) return no("a thread cannot be merged into itself");
  if (target.merged === true) return no(`${into} is already merged`);
  const busy = busyReason(target);
  if (busy !== undefined) return no(`${into}: ${busy}`);
  return { ok: true };
}
