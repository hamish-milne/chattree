/**
 * Which actions the graph offers on a commit, and when one is unavailable and why. The view builds its context menu
 * from this and never decides itself; the reason of a disabled action is shown to the person.
 */
import type { GraphData, GraphThread, RepoEntry } from "./graph.ts";

export interface GraphAction {
  id: "open" | "fork" | "rewind" | "merge" | "switch" | "copy" | "archive" | "unarchive" | "delete";
  label: string;
  /** A divider is drawn above it: it starts a new group of actions. */
  separator?: boolean;
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
  const sw = canSwitch(data, thread.name);
  actions.push({
    id: "switch",
    label: "Switch workspace to this thread",
    enabled: sw.ok,
    ...(sw.reason === undefined ? {} : { reason: sw.reason }),
  });
  const keep =
    thread.name === data.trunk ? "the trunk cannot be archived" : thread.checkedOut === true ? "it is checked out in your workspace" : busy;
  const doomed = thread.name === data.trunk ? "the trunk cannot be deleted" : busy;
  actions.push(
    { id: "copy", label: "Copy commit hash", enabled: true, separator: true },
    thread.archived === true
      ? { id: "unarchive", label: `Unarchive thread “${thread.name}”`, enabled: true }
      : {
          id: "archive",
          label: `Archive thread “${thread.name}”`,
          enabled: keep === undefined,
          ...(keep === undefined ? {} : { reason: keep }),
        },
    {
      id: "delete",
      label: `Delete thread “${thread.name}”…`,
      enabled: doomed === undefined,
      ...(doomed === undefined ? {} : { reason: doomed }),
    },
  );
  return actions;
}

/** The hashes of these commits and everything before them. */
function ancestry(data: GraphData, tips: string[]): Set<string> {
  const parents = new Map(data.commits.map((c) => [c.hash, c.parents]));
  const seen = new Set<string>();
  const todo = [...tips];
  for (let h = todo.pop(); h !== undefined; h = todo.pop()) {
    if (seen.has(h)) continue;
    seen.add(h);
    todo.push(...(parents.get(h) ?? []));
  }
  return seen;
}

/** What deleting a thread's branch takes out of reach: the commits no other thread has. */
export function deletionImpact(data: GraphData, name: string): { only: number; shared: number } {
  const thread = data.threads.find((t) => t.name === name);
  if (thread === undefined) return { only: 0, shared: 0 };
  const mine = ancestry(data, [thread.tip]);
  const others = ancestry(
    data,
    data.threads.filter((t) => t.name !== name).map((t) => t.tip),
  );
  // Only a thread's own commits count; the history it was forked from is still in the thread it came from.
  const own = [...mine].filter((h) => data.commits.find((c) => c.hash === h)?.thread === name);
  const only = own.filter((h) => !others.has(h)).length;
  return { only, shared: own.length - only };
}

/** The words of the confirmation before a thread is deleted. */
export function deleteDialog(data: GraphData, name: string): { title: string; lines: string[]; confirm: string } | undefined {
  const thread = data.threads.find((t) => t.name === name);
  if (thread === undefined) return undefined;
  const { only, shared } = deletionImpact(data, name);
  const plural = (n: number): string => `${n} commit${n === 1 ? "" : "s"}`;
  const lines = [
    only === 0
      ? "Every commit in this thread is also reachable from another thread, so nothing is lost."
      : `${plural(only)} ${only === 1 ? "is" : "are"} only in this thread.${shared > 0 ? ` ${plural(shared)} stay${shared === 1 ? "s" : ""} because other threads build on ${shared === 1 ? "it" : "them"}.` : ""}`,
    "Deleting removes the thread's branch. Its commits stay in the repository until git next collects garbage, so until then you can recover it from the reflog.",
    `Its latest commit is ${thread.tip.slice(0, 7)}; to bring it back: git branch ${name} ${thread.tip.slice(0, 7)}`,
  ];
  if (thread.merged === true) lines.unshift(`It was merged into ${data.trunk}, so its changes stay in ${data.trunk}'s history.`);
  return { title: `Delete thread “${name}”?`, lines, confirm: "Delete thread" };
}

/**
 * The words of the confirmation before a conversation is started in a folder that is already a git repository: it
 * shares the checked-out branch, and every entry commits the working tree's pending changes with it.
 */
export function initDialog(repo: RepoEntry): { title: string; lines: string[]; confirm: string } {
  return {
    title: `Start a conversation in “${repo.name}”?`,
    lines: [
      `${repo.path} is already a git repository. The conversation will be kept on the branch that is checked out there, next to your own commits.`,
      "Every step the agent takes also commits the changes in your working folder, so that it can be rolled back. Your files are not touched until then.",
    ],
    confirm: "Start conversation",
  };
}

/** Whether something may be done, and if not, why. */
export interface Verdict {
  ok: boolean;
  reason?: string;
}

const no = (reason: string): Verdict => ({ ok: false, reason });

/**
 * Whether the project folder can be switched to this thread: it must not be the one there already, and neither it nor the
 * thread there may be working (their files are being changed, or their lock held by another window).
 */
export function canSwitch(data: GraphData, name: string): Verdict {
  const target = data.threads.find((x) => x.name === name);
  if (target === undefined) return no("no such thread");
  if (target.checkedOut === true) return no("already checked out in your workspace");
  const busy = busyReason(target);
  if (busy !== undefined) return no(busy);
  const current = data.threads.find((x) => x.checkedOut === true);
  const currentBusy = current === undefined ? undefined : busyReason(current);
  return currentBusy === undefined ? { ok: true } : no(`${current?.name ?? "the checked-out thread"}: ${currentBusy}`);
}

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

/**
 * The graph without the threads that were archived: their commits go, and a commit that had one of them as a parent is
 * drawn without that parent. A thread that a shown thread was forked from stays, as the fork would hang from nothing.
 * `hidden` is how many threads were left out, for the "show archived" switch.
 */
export function withoutArchived(data: GraphData): { data: GraphData; hidden: number } {
  const owner = new Map(data.commits.map((c) => [c.hash, c.thread]));
  const hidden = new Set(data.threads.filter((t) => t.archived === true && t.name !== data.trunk).map((t) => t.name));
  for (let changed = true; changed;) {
    changed = false;
    for (const t of data.threads) {
      const parent = t.from === undefined ? undefined : owner.get(t.from);
      if (!hidden.has(t.name) && parent !== undefined && hidden.delete(parent)) changed = true;
    }
  }
  if (hidden.size === 0) return { data, hidden: 0 };
  const shown = new Set(data.commits.filter((c) => !hidden.has(c.thread)).map((c) => c.hash));
  return {
    hidden: hidden.size,
    data: {
      ...data,
      threads: data.threads.filter((t) => !hidden.has(t.name)),
      commits: data.commits.filter((c) => shown.has(c.hash)).map((c) => ({ ...c, parents: c.parents.filter((p) => shown.has(p)) })),
    },
  };
}
