import { findProject, openThread, type Project } from "../../app/project.ts";
import { localOwner } from "../../app/owner.ts";
import type { AppEnv } from "../../app/env.ts";
import { AppError } from "../../app/errors.ts";
import { inspectWorkspace, type WorkspaceFolder } from "../../app/workspace.ts";
import type { Conversation } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import { entrySpends } from "../../harness/ledger.ts";
import type { HostedController } from "../host/web-host.ts";
import type { ChatState, Composer, ModelChoice, StatusBar } from "../model/chat.ts";
import type { GraphData, RepoEntry, ThreadStatus } from "../model/graph.ts";
import type { UiEvent, UiIntent } from "../model/protocol.ts";
import { mapEntries, type MapItem } from "./map-chat.ts";
import { mapGraph } from "./map-graph.ts";
import { statusBar, threadBanner, threadStatus } from "./map-status.ts";
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
  /** The thread the chat shows. */
  #selected: string | undefined;
  /** A handle on each thread opened in this session, on its own working tree. */
  readonly #handles = new Map<string, Conversation>();
  /** What the person has typed and staged for each thread. */
  readonly #composers = new Map<string, Composer>();

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
    await this.#dropHandles();
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
    await this.#dropHandles();
    this.#repo = { folder, project: found, convo, trunk: main.branch, checkedOut: found.branch };
    this.#selected = found.branch;
    await old?.convo.close();
  }

  async #dropHandles(): Promise<void> {
    const all = [...this.#handles.values()];
    this.#handles.clear();
    this.#composers.clear();
    for (const h of all) await h.close();
  }

  /** A handle on a thread's own working tree (made if it has none, as the command line does). */
  async #handle(repo: Repo, name: string): Promise<Conversation> {
    const have = this.#handles.get(name);
    if (have !== undefined) return have;
    const { convo } = await openThread(this.#o.env, repo.project, name, { providers: "optional" });
    this.#handles.set(name, convo);
    return convo;
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

  // ---- the chat ----------------------------------------------------------------------------------------

  #composer(thread: string): Composer {
    let c = this.#composers.get(thread);
    if (c === undefined) this.#composers.set(thread, (c = { draft: "", attachments: [] }));
    return c;
  }

  /** The first thing the person said on the thread, as its label. */
  #title(entries: readonly ChatEntry[]): string | undefined {
    const start = entries.findLastIndex((e) => e.$tag === "branch_start");
    for (const e of entries.slice(start + 1)) {
      if (e.$tag !== "user") continue;
      const part = e.content.find((p) => p.$tag === "text");
      const text = part?.$tag === "text" && typeof part.text === "string" ? part.text.replace(/\s+/g, " ").trim() : "";
      return text === "" ? undefined : text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
    return undefined;
  }

  #models(convo: Conversation, current: string): ModelChoice {
    const options = [...convo.catalog].flatMap(([provider, models]) =>
      Object.keys(models).map((id) => ({ id: `${provider}/${id}`, label: id, provider })),
    );
    return { current, options };
  }

  /** Everything the chat shows about a thread: read from its history and its working tree, nothing remembered but the composer. */
  async #chatState(repo: Repo, name: string): Promise<{ state: ChatState; items: MapItem[] }> {
    const h = await this.#handle(repo, name);
    const decoded = await h.readEntries();
    const refs = await h.index();
    const items: MapItem[] = decoded.flatMap((r, i) => {
      const ref = refs[i];
      return r.ok && ref !== undefined ? [{ entry: r.value, ref }] : [];
    });
    const entries = items.map((i) => i.entry);
    const spends = await entrySpends(entries, h.priceResolver());
    const blocks = await mapEntries(items, { blob: (sha) => h.store.get(sha) }, { spends });
    const setup = await h.setup();
    const ledger = await h.ledger();
    const lease = await h.leaseState(name);
    const state = threadStatus({ lease, entries, self: (o) => o.session === this.#session });
    const bar: StatusBar = statusBar({
      state,
      setup,
      info: setup.model === undefined ? undefined : h.modelInfo(setup.model.provider, setup.model.id),
      ledger,
      entries,
    }) ?? {
      state,
      model: "No model yet",
      provider: "none",
    };
    const banner = threadBanner({ trust: await h.configTrust(), hasProvider: h.providers.size > 0 });
    const tip = refs.at(-1)?.commit ?? (await h.git.revParse(`refs/heads/${name}`)) ?? "";
    const kind = name === repo.trunk ? "main" : (entries.findLast((e) => e.$tag === "branch_start")?.kind ?? "fork");
    const title = this.#title(entries);
    return {
      items,
      state: {
        thread: { name, kind, ...(title === undefined ? {} : { title }), tip },
        blocks,
        status: bar,
        composer: structuredClone(this.#composer(name)),
        ...(banner === undefined ? {} : { banner }),
        model: this.#models(h, setup.model === undefined ? "" : `${setup.model.provider}/${setup.model.id}`),
      },
    };
  }

  /** Show a thread in the chat, and scroll to the block nearest `commit` when one is given. */
  async #openChat(name: string, commit?: string): Promise<void> {
    const repo = this.#repo;
    if (repo === undefined) throw new AppError("there is no conversation open");
    const { state, items } = await this.#chatState(repo, name);
    this.#selected = name;
    this.#emit({ type: "chat.open", state });
    this.#emit({ type: "graph.selected", thread: name, ...(commit === undefined ? {} : { commit }) });
    if (commit === undefined) return;
    // The nearest block at or before the commit: a commit that holds no entry (a snapshot) points to the entry before it.
    const at = items.findLastIndex((i) => i.ref.commit === commit);
    const shown = new Set(state.blocks.flatMap((b) => (b.commit === undefined ? [] : [b.commit])));
    for (let i = at; i >= 0; i--) {
      const c = items[i]?.ref.commit;
      if (c !== undefined && shown.has(c)) return this.#emit({ type: "chat.reveal", commit: c });
    }
  }

  // ---- intents -----------------------------------------------------------------------------------------------

  async #run(intent: UiIntent): Promise<void> {
    switch (intent.type) {
      case "ready":
        if (intent.view === "graph") await this.#sendGraph();
        else if (intent.view === "chat" && this.#selected !== undefined) await this.#openChat(this.#selected);
        return;
      case "thread.open":
        await this.#openChat(intent.thread, intent.commit);
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
