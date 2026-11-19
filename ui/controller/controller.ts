import { findProject, openThread, type Project } from "../../app/project.ts";
import { localOwner } from "../../app/owner.ts";
import type { AppEnv } from "../../app/env.ts";
import { AppError } from "../../app/errors.ts";
import { inspectWorkspace, type WorkspaceFolder } from "../../app/workspace.ts";
import type { Conversation } from "../../harness/conversation.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import type { HostedController } from "../host/web-host.ts";
import type { GraphData, RepoEntry, ThreadStatus } from "../model/graph.ts";
import type { UiEvent, UiIntent } from "../model/protocol.ts";
import { mapGraph } from "./map-graph.ts";
import { headlessPlatform, type Platform } from "./platform.ts";

export interface ControllerOptions {
  env: AppEnv;
  /** The folders of the workspace, as the editor has them open. */
  folders: readonly string[];
  /** Send an event to the views. */
  send(event: UiEvent): void;
  platform?: Platform;
  /** Names this session in the run leases it takes, so it can tell its own running threads from another window's. */
  session?: string;
}

/** A repository that holds a conversation, as the controller has it open. */
interface Repo {
  folder: WorkspaceFolder;
  project: Project;
  /** The trunk's conversation: what the graph is read through. */
  convo: Conversation;
  trunk: string;
  /** The thread checked out in the folder the person works in. */
  checkedOut: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The real controller: owns the repositories of the workspace, answers the views' intents, and sends what changed as
 * events. Intents are carried out one at a time, in the order they arrive; a failure is a notice, never a thrown error
 * (the views have no one to throw to). The mapping from harness state to what the views show is in the `map-*` modules; this
 * is where the reading and the doing are.
 */
export class Controller implements HostedController {
  readonly #o: ControllerOptions;
  readonly #platform: Platform;
  readonly #session: string;
  #queue: Promise<void> = Promise.resolve();
  #folders: WorkspaceFolder[] = [];
  #repo: Repo | undefined;
  #started: Promise<void> | undefined;
  #closed = false;

  constructor(o: ControllerOptions) {
    this.#o = o;
    this.#platform = o.platform ?? headlessPlatform;
    this.#session = o.session ?? `ui-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Carry out an intent after those before it; resolves when it is done (used by `idle`). */
  handle(intent: UiIntent): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#closed) return;
      try {
        await this.#start();
        await this.#run(intent);
      } catch (e) {
        this.#notify(e instanceof AppError && e.hint !== undefined ? `${e.message} (${e.hint})` : message(e), "error");
      }
    });
  }

  /** Resolves when every intent received so far has been carried out. */
  idle(): Promise<void> {
    return this.#queue;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    await this.#repo?.convo.close();
    this.#repo = undefined;
  }

  #emit(event: UiEvent): void {
    if (!this.#closed) this.#o.send(event);
  }

  #notify(text: string, level: "info" | "warning" | "error" = "info"): void {
    this.#emit({ type: "notice", level, message: text });
  }

  // ---- the workspace -------------------------------------------------------------------------------------

  /** Look at the folders and open the first that holds a conversation, once. */
  #start(): Promise<void> {
    return (this.#started ??= (async () => {
      this.#folders = await inspectWorkspace(this.#o.env, this.#o.folders);
      const first = this.#folders.find((f) => f.state.kind === "conversation");
      if (first !== undefined) await this.#enter(first);
    })());
  }

  #entries(): RepoEntry[] {
    return this.#folders.map((f) => ({
      id: f.path,
      name: f.name,
      path: f.path,
      chattree: f.state.kind === "conversation",
      ...(f.state.kind === "unusable" ? { reason: f.state.reason } : {}),
      ...(f.state.kind === "init" ? { init: f.state.mode, reason: "no conversation here yet" } : {}),
    }));
  }

  async #enter(folder: WorkspaceFolder): Promise<void> {
    const env = this.#o.env;
    const found = await findProject(env, folder.root);
    // The trunk is the thread of the repository's main working tree, wherever the person's own folder is.
    const main = found.mainRoot === found.root ? found : await findProject(env, found.mainRoot);
    const { convo } = await openThread(env, main, undefined, { providers: "optional" });
    const old = this.#repo;
    this.#repo = { folder, project: found, convo, trunk: main.branch, checkedOut: found.branch };
    await old?.convo.close();
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  async #statuses(repo: Repo): Promise<Map<string, ThreadStatus>> {
    const out = new Map<string, ThreadStatus>();
    const owner = localOwner(this.#session);
    for (const b of await repo.convo.listBranches()) {
      const lease = await repo.convo.leaseState(b.name);
      if (lease.state === "live") out.set(b.name, lease.owner.session === owner.session ? "running" : "elsewhere");
      else if (lease.state === "stale") out.set(b.name, "error");
      else if (b.running) out.set(b.name, "elsewhere");
    }
    return out;
  }

  async #graph(repo: Repo): Promise<GraphData> {
    const graph = await readCommitGraph(repo.convo, repo.trunk);
    return mapGraph({
      graph,
      branches: await repo.convo.listBranches(),
      merged: await repo.convo.mergedBranches(),
      checkedOut: repo.checkedOut,
      statuses: await this.#statuses(repo),
    });
  }

  async #sendGraph(): Promise<void> {
    this.#emit({
      type: "graph.repos",
      repos: { repos: this.#entries(), ...(this.#repo === undefined ? {} : { current: this.#repo.folder.path }) },
    });
    const repo = this.#repo;
    if (repo === undefined) return;
    this.#emit({ type: "graph.data", data: await this.#graph(repo) });
    this.#emit({ type: "graph.selected", thread: repo.checkedOut });
  }

  // ---- intents -----------------------------------------------------------------------------------------------

  async #run(intent: UiIntent): Promise<void> {
    switch (intent.type) {
      case "ready":
        if (intent.view === "graph") await this.#sendGraph();
        return;
      case "repo.select": {
        const folder = this.#folders.find((f) => f.path === intent.id);
        if (folder === undefined) throw new AppError(`there is no folder ${intent.id} in this workspace`);
        if (folder.state.kind !== "conversation") throw new AppError(`${folder.name} has no conversation to show`);
        await this.#enter(folder);
        await this.#sendGraph();
        return;
      }
      case "commit.copy":
        await this.#platform.copy(intent.commit);
        this.#notify(`Copied ${intent.commit.slice(0, 7)} to the clipboard`);
        return;
      default:
        throw new AppError(`${intent.type} is not available yet`);
    }
  }
}
