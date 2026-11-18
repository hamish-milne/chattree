/**
 * The graph view's state as a signal model: the data the controller sent, which tool chains are expanded, what is
 * selected and which context menu is open, with the layout derived from them. It knows nothing of VS Code or the
 * DOM; a view reads its signals and calls its actions, and `send` carries intents to the controller.
 */
import { computed, createModel, signal } from "@preact/signals-core";
import type { UiEvent, UiIntent } from "./protocol.ts";
import type { GraphData } from "./graph.ts";
import { actionsFor, type GraphAction } from "./graph-actions.ts";
import { layoutGraph } from "./graph-layout.ts";

export interface OpenMenu {
  /** The commit the menu is for. */
  commit: string;
  /** Where it opened, in the view's own coordinates. */
  x: number;
  y: number;
}

export const GraphModel = createModel((send: (intent: UiIntent) => void) => {
  const data = signal<GraphData | undefined>(undefined);
  const expanded = signal<ReadonlySet<string>>(new Set());
  const selected = signal<{ thread: string | undefined; commit: string | undefined }>({ thread: undefined, commit: undefined });
  const menu = signal<OpenMenu | undefined>(undefined);
  const layout = computed(() => (data.value === undefined ? undefined : layoutGraph(data.value, expanded.value)));
  const menuActions = computed((): GraphAction[] => {
    const m = menu.value;
    return m === undefined || data.value === undefined ? [] : actionsFor(data.value, m.commit);
  });
  const threadOf = (commit: string): string | undefined => data.peek()?.commits.find((c) => c.hash === commit)?.thread;

  return {
    data,
    expanded,
    selected,
    menu,
    layout,
    menuActions,
    /** Take in an event from the controller; false when it is not one this view follows. */
    apply(e: UiEvent): boolean {
      switch (e.type) {
        case "graph.data":
          data.value = e.data;
          return true;
        case "graph.status": {
          const d = data.value;
          if (d !== undefined) data.value = { ...d, threads: d.threads.map((t) => (t.name === e.thread ? { ...t, status: e.status } : t)) };
          return true;
        }
        case "graph.selected":
          selected.value = { thread: e.thread, commit: e.commit };
          return true;
        default:
          return false;
      }
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
      if (id === "open") send({ type: "thread.open", thread, commit });
      else if (id === "fork") send({ type: "thread.fork", thread, commit });
      else if (id === "rewind") send({ type: "thread.rewind", thread, commit });
      else send({ type: "thread.merge", from: thread, into: d.trunk });
    },
    /** Open a thread (a click on its commit or its name). */
    open(commit: string): void {
      const thread = threadOf(commit);
      if (thread !== undefined) send({ type: "thread.open", thread, commit });
    },
  };
});
