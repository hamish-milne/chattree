/**
 * The graph view's state as a signal model: the data the controller sent, which tool chains are expanded, what is
 * selected and which context menu is open, with the layout derived from them. It knows nothing of VS Code or the
 * DOM; a view reads its signals and calls its actions, and `send` carries intents to the controller.
 */
import { computed, createModel, signal } from "@preact/signals-core";
import type { UiEvent, UiIntent } from "./protocol.ts";
import type { GraphData, RepoEntry, RepoList } from "./graph.ts";
import {
  withoutArchived,
  actionsFor,
  canDragThread,
  canDropOn,
  deleteDialog,
  initDialog,
  type GraphAction,
  type Verdict,
} from "./graph-actions.ts";
import { layoutGraph } from "./graph-layout.ts";

export interface OpenMenu {
  /** The commit the menu is for. */
  commit: string;
  /** Where it opened, in the view's own coordinates. */
  x: number;
  y: number;
}

/** A thread being dragged to merge it, and the thread it is over. */
export interface Drag {
  thread: string;
  over: string | undefined;
}

export const GraphModel = createModel((send: (intent: UiIntent) => void) => {
  const data = signal<GraphData | undefined>(undefined);
  const expanded = signal<ReadonlySet<string>>(new Set());
  const selected = signal<{ thread: string | undefined; commit: string | undefined }>({ thread: undefined, commit: undefined });
  const menu = signal<OpenMenu | undefined>(undefined);
  const repos = signal<RepoList | undefined>(undefined);
  const repoMenuOpen = signal(false);
  /** The thread whose deletion is waiting for the person's yes. */
  const deleting = signal<string | undefined>(undefined);
  /** A switch of the workspace waiting for an answer about the files changed by hand in the project folder. */
  const switching = signal<{ thread: string; from: string; files: string[] } | undefined>(undefined);
  /** A folder whose conversation is waiting for the person's yes (one inside a git repository shares its branch). */
  const initializing = signal<string | undefined>(undefined);
  /** The workspace folders a conversation can be started in. */
  const initializable = computed((): RepoEntry[] => repos.value?.repos.filter((r) => r.init !== undefined) ?? []);
  const initConfirmation = computed(() => {
    const r = initializable.value.find((x) => x.id === initializing.value);
    return r === undefined ? undefined : initDialog(r);
  });
  const confirmation = computed(() => {
    const name = deleting.value;
    const d = data.value;
    return name === undefined || d === undefined ? undefined : deleteDialog(d, name);
  });
  const drag = signal<Drag | undefined>(undefined);
  /** The thread the drag is over and whether dropping there merges: what the view draws while dragging. */
  const dropTarget = computed((): ({ thread: string } & Verdict) | undefined => {
    const d = drag.value;
    const g = data.value;
    return d === undefined || d.over === undefined || g === undefined ? undefined : { thread: d.over, ...canDropOn(g, d.thread, d.over) };
  });
  /** The commit under the pointer. */
  const hover = signal<string | undefined>(undefined);
  const showArchived = signal(false);
  /** What is drawn: the graph without its archived threads, unless asked for. */
  const shown = computed(() => {
    const d = data.value;
    return d === undefined ? undefined : showArchived.value ? { data: d, hidden: 0 } : withoutArchived(d);
  });
  const archivedCount = computed(() => data.value?.threads.filter((t) => t.archived === true).length ?? 0);
  const layout = computed(() => (shown.value === undefined ? undefined : layoutGraph(shown.value.data, expanded.value)));
  const menuActions = computed((): GraphAction[] => {
    const m = menu.value;
    return m === undefined || data.value === undefined ? [] : actionsFor(data.value, m.commit);
  });
  /**
   * What is lit: the commit an action would apply to (the pointer's, or the one a context menu is open on, so it stays
   * lit while the menu covers the rows) and its thread, which is what a click would select.
   */
  const lit = computed(() => {
    const commit = menu.value?.commit ?? hover.value;
    const thread = commit === undefined ? undefined : data.value?.commits.find((c) => c.hash === commit)?.thread;
    return { commit, thread };
  });
  const threadOf = (commit: string): string | undefined => data.peek()?.commits.find((c) => c.hash === commit)?.thread;

  return {
    data,
    expanded,
    selected,
    menu,
    repos,
    repoMenuOpen,
    deleting,
    confirmation,
    initializable,
    initializing,
    initConfirmation,
    switching,
    showArchived,
    archivedCount,
    /** The data the layout is drawn from: `data` less the archived threads, unless they are shown. */
    shown: computed(() => shown.value?.data),
    hover,
    drag,
    dropTarget,
    lit,
    layout,
    menuActions,
    /** Take in an event from the controller; false when it is not one this view follows. */
    apply(e: UiEvent): boolean {
      switch (e.type) {
        case "graph.repos":
          repos.value = e.repos;
          // A folder that was initialized (or is gone) cannot still be waiting.
          if (!e.repos.repos.some((r) => r.id === initializing.peek() && r.init !== undefined)) initializing.value = undefined;
          return true;
        case "graph.data":
          data.value = e.data;
          // A thread that is gone cannot be waiting for a confirmation.
          if (deleting.peek() !== undefined && !e.data.threads.some((t) => t.name === deleting.peek())) deleting.value = undefined;
          return true;
        case "workspace.uncommitted":
          switching.value = { thread: e.thread, from: e.from, files: e.files };
          return true;
        case "graph.status": {
          const d = data.value;
          if (d !== undefined) data.value = { ...d, threads: d.threads.map((t) => (t.name === e.thread ? { ...t, status: e.status } : t)) };
          return true;
        }
        case "graph.jobs": {
          const d = data.value;
          if (d !== undefined)
            data.value = {
              ...d,
              threads: d.threads.map((t) => {
                if (t.name !== e.thread) return t;
                const { jobs: _old, ...rest } = t;
                return e.jobs === undefined ? rest : { ...rest, jobs: e.jobs };
              }),
            };
          return true;
        }
        case "graph.selected":
          selected.value = { thread: e.thread, commit: e.commit };
          return true;
        default:
          return false;
      }
    },
    setHover(commit: string | undefined): void {
      // While a thread is carried the pointer is not choosing a commit, so nothing is lit by it.
      hover.value = drag.peek() === undefined ? commit : undefined;
    },
    /** Pick up the thread of a commit, if it can be merged; false when it cannot (the reason is `canDragThread`'s). */
    startDrag(commit: string): boolean {
      const d = data.peek();
      const thread = threadOf(commit);
      if (d === undefined || thread === undefined || !canDragThread(d, thread).ok) return false;
      menu.value = undefined;
      hover.value = undefined;
      drag.value = { thread, over: undefined };
      return true;
    },
    /** The thread the carried one is over (or none). */
    dragOver(thread: string | undefined): void {
      const d = drag.peek();
      if (d !== undefined && d.over !== thread) drag.value = { ...d, over: thread };
    },
    /** Let go: merge into the thread under the pointer if that is allowed. True when a merge was asked for. */
    drop(): boolean {
      const d = drag.peek();
      const g = data.peek();
      drag.value = undefined;
      if (d === undefined || d.over === undefined || g === undefined || !canDropOn(g, d.thread, d.over).ok) return false;
      send({ type: "thread.merge", from: d.thread, into: d.over });
      return true;
    },
    cancelDrag(): void {
      drag.value = undefined;
    },
    toggleFold(id: string): void {
      const next = new Set(expanded.value);
      if (!next.delete(id)) next.add(id);
      expanded.value = next;
    },
    openMenu(commit: string, x: number, y: number): void {
      menu.value = { commit, x, y };
    },
    closeMenu(): void {
      menu.value = undefined;
    },
    /** Do an action on a commit, if it is available; the controller carries it out. */
    act(id: GraphAction["id"], commit: string): void {
      const d = data.peek();
      const thread = threadOf(commit);
      const action = d === undefined ? undefined : actionsFor(d, commit).find((a) => a.id === id);
      menu.value = undefined;
      if (d === undefined || thread === undefined || action?.enabled !== true) return;
      if (id === "copy") send({ type: "commit.copy", commit });
      else if (id === "delete") deleting.value = thread;
      else if (id === "archive") send({ type: "thread.archive", thread });
      else if (id === "unarchive") send({ type: "thread.unarchive", thread });
      else if (id === "open") send({ type: "thread.open", thread, commit });
      else if (id === "fork") send({ type: "thread.fork", thread, commit });
      else if (id === "rewind") send({ type: "thread.rewind", thread, commit });
      else if (id === "switch") send({ type: "workspace.switch", thread });
      else send({ type: "thread.merge", from: thread, into: d.trunk });
    },
    /** The person said yes to the confirmation: delete the thread. */
    confirmDelete(): void {
      const thread = deleting.peek();
      deleting.value = undefined;
      if (thread !== undefined) send({ type: "thread.delete", thread });
    },
    cancelDelete(): void {
      deleting.value = undefined;
    },
    /** The person chose to keep their changes (as a snapshot on the thread they are on) and switch; `remember` makes that the setting. */
    confirmSwitch(remember: boolean): void {
      const s = switching.peek();
      switching.value = undefined;
      if (s !== undefined)
        send({ type: "workspace.switch", thread: s.thread, uncommitted: "snapshot", ...(remember ? { remember: true } : {}) });
    },
    cancelSwitch(): void {
      switching.value = undefined;
    },
    /** Start a conversation in a workspace folder: at once for a new repository, after a question for an existing one. */
    initRepo(id: string): void {
      const repo = repos.peek()?.repos.find((r) => r.id === id);
      repoMenuOpen.value = false;
      if (repo?.init === undefined) return;
      if (repo.init === "new") send({ type: "repo.init", id });
      else initializing.value = id;
    },
    confirmInit(): void {
      const id = initializing.peek();
      initializing.value = undefined;
      if (id !== undefined) send({ type: "repo.init", id });
    },
    cancelInit(): void {
      initializing.value = undefined;
    },
    /** Start an empty thread from the trunk. */
    newThread(): void {
      if (data.peek() !== undefined) send({ type: "thread.new" });
    },
    toggleArchived(): void {
      showArchived.value = !showArchived.peek();
    },
    toggleRepoMenu(): void {
      repoMenuOpen.value = !repoMenuOpen.peek();
    },
    closeRepoMenu(): void {
      repoMenuOpen.value = false;
    },
    /** Choose another repository, if it can be chosen; the controller answers with its graph. */
    selectRepo(id: string): void {
      const list = repos.peek();
      const repo = list?.repos.find((r) => r.id === id);
      repoMenuOpen.value = false;
      if (repo === undefined || !repo.chattree || list?.current === id) return;
      send({ type: "repo.select", id });
    },
    /** Open a thread (a click on its commit or its name). */
    open(commit: string): void {
      const thread = threadOf(commit);
      if (thread !== undefined) send({ type: "thread.open", thread, commit });
    },
  };
});
