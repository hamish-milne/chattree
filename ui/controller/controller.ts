import { hostEnvironment } from "../../app/environment.ts";
import { createFork, findProject, nextForkName, openThread, threadDir, type Project } from "../../app/project.ts";
import { buildToolSet, type ToolSet } from "../../app/toolset.ts";
import { localOwner } from "../../app/owner.ts";
import type { AppEnv } from "../../app/env.ts";
import { AppError } from "../../app/errors.ts";
import { inspectWorkspace, type WorkspaceFolder } from "../../app/workspace.ts";
import { WorkspaceDirty, type Conversation, type EntryRef } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import { entrySpends } from "../../harness/ledger.ts";
import type { HostEnvironment } from "../../harness/environment.ts";
import type { Approval, ApprovalRequest, LoopEvent } from "../../harness/loop.ts";
import { attachmentKind } from "../../harness/attachments.ts";
import type { HostedController } from "../host/web-host.ts";
import type { ChatState, Composer, ModelChoice, StatusBar } from "../model/chat.ts";
import type { GraphData, RepoEntry, ThreadStatus } from "../model/graph.ts";
import type { UiEvent, UiIntent } from "../model/protocol.ts";
import { diffBlocks } from "./diff-blocks.ts";
import { explain } from "./explain.ts";
import { mapEntries, type MapItem } from "./map-chat.ts";
import { runThread } from "./run-thread.ts";
import { mapGraph } from "./map-graph.ts";
import { approvalView, statusBar, threadBanner, threadStatus } from "./map-status.ts";
import type { Block } from "../model/transcript.ts";
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
  /** The folder the person works in. */
  project: Project;
  /** The repository's main working tree. */
  main: Project;
  /** The trunk's conversation: what the graph is read through. */
  convo: Conversation;
  trunk: string;
  /** The thread checked out in the folder the person works in. */
  checkedOut: string;
}

/** A request going on for a thread: what it waits for and what it is doing, so the chat can show it. */
interface Run {
  abort: AbortController;
  /** The call the person has to answer, and the way to answer it. */
  pending?: { request: ApprovalRequest; resolve(a: Approval): void };
  awaiting: Set<string>;
  running: Set<string>;
  /** Whether the run counts as working (it does not while it waits for an answer). */
  active: boolean;
  done: Promise<void>;
}

/** What the view has been sent about the open thread, so later sends are only the differences. */
interface Sent {
  blocks: Block[];
  status: string;
  thread: string;
  approval: string;
  banner: string;
  model: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function sentOf(state: ChatState): Sent {
  return {
    blocks: structuredClone(state.blocks),
    status: JSON.stringify(state.status),
    thread: JSON.stringify(state.thread),
    approval: JSON.stringify(state.approval ?? null),
    banner: JSON.stringify(state.banner ?? null),
    model: JSON.stringify(state.model),
  };
}

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
  /** The bytes of each staged file, by the id the composer shows. */
  readonly #staged = new Map<string, { bytes: Uint8Array; mime: string; name: string }>();
  readonly #runs = new Map<string, Run>();
  readonly #toolsets = new WeakMap<Conversation, Promise<ToolSet>>();
  readonly #environment: HostEnvironment | undefined;
  #sent: Sent | undefined;
  #active = 0;
  #quiet: (() => void)[] = [];
  readonly #lastStatus = new Map<string, ThreadStatus>();
  #seq = 0;

  constructor(o: ControllerOptions) {
    this.#o = o;
    this.#platform = o.platform ?? headlessPlatform;
    this.#session = o.session ?? `ui-${Math.random().toString(36).slice(2, 10)}`;
    // CHATTREE_ENVIRONMENT=off leaves the note about this machine out, for tests that need the transcript to hold only what was typed.
    this.#environment = o.env.env["CHATTREE_ENVIRONMENT"] === "off" ? undefined : hostEnvironment(o.env);
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

  /** Resolves when every intent received so far has been carried out and no request is working (one waiting for an answer is not). */
  async idle(): Promise<void> {
    for (;;) {
      const q = this.#queue;
      await q;
      if (this.#active > 0) await new Promise<void>((r) => this.#quiet.push(r));
      if (q === this.#queue && this.#active === 0) return;
    }
  }

  #work(delta: 1 | -1): void {
    this.#active += delta;
    if (this.#active === 0) for (const r of this.#quiet.splice(0)) r();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const r of this.#runs.values()) {
      r.abort.abort();
      r.pending?.resolve({ allow: false });
    }
    await this.#queue;
    await Promise.all([...this.#runs.values()].map((r) => r.done));
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

  /**
   * The thread everything else branches from. Nothing in the repository says so, so it is the thread of the main working tree when
   * first looked at, remembered in `chattree.trunk` (written when the workspace is first switched, the one thing that moves it).
   */
  async #trunkOf(main: Project): Promise<string> {
    const set = (await main.git.getConfig("chattree.trunk").catch(() => undefined))?.trim();
    return set !== undefined && set !== "" && (await main.git.revParse(`refs/heads/${set}`)) !== undefined ? set : main.branch;
  }

  async #enter(folder: WorkspaceFolder, keep?: { trunk: string; selected: string | undefined }): Promise<void> {
    const env = this.#o.env;
    const found = await findProject(env, folder.root);
    const main = found.mainRoot === found.root ? found : await findProject(env, found.mainRoot);
    const { convo } = await openThread(env, main, undefined, { providers: "optional" });
    const old = this.#repo;
    await this.#dropHandles();
    this.#repo = { folder, project: found, main, convo, trunk: keep?.trunk ?? (await this.#trunkOf(main)), checkedOut: found.branch };
    this.#selected = keep?.selected ?? found.branch;
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
    this.#emit({ type: "graph.selected", thread: this.#selected ?? repo.checkedOut });
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
    const run = this.#runs.get(name);
    const blocks = await mapEntries(
      items,
      { blob: (sha) => h.store.get(sha) },
      { spends, ...(run === undefined ? {} : { awaiting: run.awaiting, running: run.running, inFlight: true }) },
    );
    const setup = await h.setup();
    const ledger = await h.ledger();
    const lease = await h.leaseState(name);
    // A request of this session is working even before it has taken the lease.
    const state: ThreadStatus =
      run === undefined
        ? threadStatus({ lease, entries, self: (o) => o.session === this.#session })
        : run.pending === undefined
          ? "running"
          : "awaiting";
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
        ...(run?.pending === undefined ? {} : { approval: approvalView(run.pending.request) }),
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
    this.#sent = sentOf(state);
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

  /** Send the open thread's view what changed since it was last sent: read the thread again and send the difference. */
  async #publish(thread: string): Promise<void> {
    const repo = this.#repo;
    if (repo === undefined) return;
    const { state } = await this.#chatState(repo, thread);
    if (this.#lastStatus.get(thread) !== state.status.state) {
      this.#lastStatus.set(thread, state.status.state);
      this.#emit({ type: "graph.status", thread, status: state.status.state });
    }
    const sent = this.#sent;
    if (thread !== this.#selected || sent === undefined) return;
    for (const e of diffBlocks(sent.blocks, state.blocks)) this.#emit(e);
    const now = sentOf(state);
    if (now.thread !== sent.thread) this.#emit({ type: "chat.thread", thread: state.thread });
    if (now.status !== sent.status) this.#emit({ type: "chat.status", status: state.status });
    if (now.model !== sent.model) this.#emit({ type: "chat.models", models: state.model });
    if (now.approval !== sent.approval)
      this.#emit({ type: "chat.approval", ...(state.approval === undefined ? {} : { approval: state.approval }) });
    if (now.banner !== sent.banner) this.#emit({ type: "chat.banner", ...(state.banner === undefined ? {} : { banner: state.banner }) });
    this.#sent = now;
  }

  /** The tools for a thread, built once from its `harness.yml`. */
  #toolset(repo: Repo, convo: Conversation, thread: string): Promise<ToolSet> {
    let p = this.#toolsets.get(convo);
    if (p === undefined) {
      p = buildToolSet(this.#o.env, convo, {
        busy: () => this.#runs.has(thread),
        session: this.#session,
        projectDir: repo.project.mainRoot,
        onCommitted: () => void this.#publish(thread).catch(() => undefined),
        onResume: () => undefined,
      });
      this.#toolsets.set(convo, p);
      p.catch(() => this.#toolsets.delete(convo));
    }
    return p;
  }

  /** The model is streaming: show what has arrived in a block of its own, which the committed blocks replace when the request ends. */
  #stream(thread: string, kind: "text" | "reasoning", text: string): void {
    const sent = this.#sent;
    if (thread !== this.#selected || sent === undefined) return;
    const id = `live.${kind}`;
    const last = sent.blocks.at(-1);
    if (last?.id !== id) {
      const block: Block =
        kind === "text"
          ? { type: "assistant", id, markdown: "", streaming: true, model: "" }
          : { type: "reasoning", id, text: "", streaming: true };
      sent.blocks.push(block);
      this.#emit({ type: "chat.append", blocks: [structuredClone(block)] });
    }
    const b = sent.blocks.at(-1);
    if (b?.type === "assistant") b.markdown += text;
    else if (b?.type === "reasoning") b.text += text;
    this.#emit({ type: "chat.delta", id, delta: text });
  }

  async #onLoop(thread: string, run: Run, e: LoopEvent): Promise<void> {
    switch (e.type) {
      case "stream":
        if (e.event.type === "text.delta") this.#stream(thread, "text", e.event.text);
        else if (e.event.type === "reasoning.delta") this.#stream(thread, "reasoning", e.event.text);
        return;
      case "tool.start":
        run.running.add(e.callId);
        break;
      case "tool.approval":
      case "tool.result":
        run.awaiting.delete(e.callId);
        if (e.type === "tool.result") run.running.delete(e.callId);
        break;
      case "request.start":
        return;
      default:
        break;
    }
    await this.#publish(thread);
  }

  /** A call no grant covers: park until the person answers (or stops the turn). */
  #ask(thread: string, run: Run, request: ApprovalRequest): Promise<Approval> {
    return new Promise<Approval>((resolve) => {
      run.pending = {
        request,
        resolve: (a) => {
          delete run.pending;
          run.awaiting.delete(request.callId);
          this.#work(1);
          resolve(a);
          void this.#publish(thread).catch(() => undefined);
        },
      };
      run.awaiting.add(request.callId);
      // Waiting for the person is not working: the controller is idle once the question has been sent.
      void this.#publish(thread)
        .catch(() => undefined)
        .finally(() => this.#work(-1));
    });
  }

  /** Put the person's message on the thread and run the model on it. */
  async #send(text: string, queued: boolean): Promise<void> {
    const repo = this.#repo;
    const thread = this.#selected;
    if (repo === undefined || thread === undefined) throw new AppError("there is no thread open");
    const h = await this.#handle(repo, thread);
    const running = this.#runs.get(thread);
    if (running !== undefined && !queued)
      throw new AppError("the model is still working on this thread", "wait for it, stop it, or queue the message");
    await h.assertConfigTrusted();
    if (h.providers.size === 0 || (await h.setup()).model === undefined)
      throw new AppError("there is no model for this thread yet", "add a provider in the settings first");
    const composer = this.#composer(thread);
    const content: Parameters<Conversation["append"]>[0] & { $tag: "user" } = {
      $tag: "user",
      content: [],
      ...(queued ? { queued: true } : {}),
    };
    if (text !== "") content.content.push({ $tag: "text", text });
    for (const a of composer.attachments) {
      const f = this.#staged.get(a.id);
      if (f !== undefined) content.content.push(await h.attach(f.bytes, { mime: f.mime, name: f.name }));
    }
    if (content.content.length === 0) return;
    await h.append(content);
    for (const a of composer.attachments) this.#staged.delete(a.id);
    this.#composers.set(thread, { draft: "", attachments: [] });
    this.#emit({ type: "chat.composer", composer: { draft: "", attachments: [] } });
    if (running !== undefined) return await this.#publish(thread);

    const run: Run = { abort: new AbortController(), awaiting: new Set(), running: new Set(), active: true, done: Promise.resolve() };
    this.#runs.set(thread, run);
    this.#work(1);
    run.done = (async () => {
      try {
        const tools = await this.#toolset(repo, h, thread);
        await this.#publish(thread);
        await runThread({
          env: this.#o.env,
          convo: h,
          tools,
          session: this.#session,
          signal: run.abort.signal,
          environment: this.#environment,
          approve: (r) => this.#ask(thread, run, r),
          onEvent: (e) => this.#onLoop(thread, run, e),
        });
      } catch (e) {
        this.#notify(explain(e), "error");
      } finally {
        this.#runs.delete(thread);
        await this.#publish(thread).catch(() => undefined);
        this.#work(-1);
      }
    })();
  }

  #stop(): void {
    const run = this.#selected === undefined ? undefined : this.#runs.get(this.#selected);
    if (run === undefined) return;
    run.abort.abort();
    run.pending?.resolve({ allow: false, reason: "stopped" });
  }

  #approve(callId: string, allow: boolean): void {
    const run = this.#selected === undefined ? undefined : this.#runs.get(this.#selected);
    if (run?.pending === undefined || run.pending.request.callId !== callId)
      throw new AppError("that question is no longer waiting for an answer");
    run.pending.resolve(allow ? { allow: true } : { allow: false });
  }

  async #attach(): Promise<void> {
    const thread = this.#selected;
    if (thread === undefined) throw new AppError("there is no thread open");
    const c = this.#composer(thread);
    for (const f of await this.#platform.pickFiles()) {
      const mime = f.mime ?? "text/plain";
      const kind = attachmentKind(mime) ?? "other";
      const id = `f${++this.#seq}`;
      this.#staged.set(id, { bytes: f.bytes, mime, name: f.name });
      c.attachments.push({ id, file: { name: f.name, mime, kind, bytes: f.bytes.length } });
    }
    this.#emit({ type: "chat.composer", composer: structuredClone(c) });
  }

  // ---- threads -------------------------------------------------------------------------------------------

  #open(): Repo {
    if (this.#repo === undefined) throw new AppError("there is no conversation open");
    return this.#repo;
  }

  /** A thread that is being worked on, here or in another window, is not changed under its work. */
  async #assertQuiet(repo: Repo, thread: string, what: string): Promise<void> {
    if (this.#runs.has(thread)) throw new AppError(`the model is working on ${thread}`, `stop it first, then ${what}`);
    if ((await repo.convo.leaseState(thread)).state === "live")
      throw new AppError(`${thread} is held by another window or process`, `wait for it, then ${what}`);
  }

  /** The entry a commit holds, or the nearest one before it (a snapshot holds none). */
  async #entryAt(h: Conversation, thread: string, commit: string): Promise<EntryRef> {
    const refs = await h.index();
    const exact = refs.find((r) => r.commit === commit);
    if (exact !== undefined) return exact;
    const log = await h.git.log(`refs/heads/${thread}`);
    const from = Math.max(
      log.findIndex((c) => c.hash === commit),
      0,
    );
    for (const c of log.slice(from)) {
      const r = refs.find((x) => x.commit === c.hash);
      if (r !== undefined) return r;
    }
    throw new AppError("that commit holds nothing to start a thread from");
  }

  /** The graph changed: send it again, and the chat when its thread was the one that changed. */
  async #changed(...threads: string[]): Promise<void> {
    await this.#sendGraph();
    for (const t of threads) if (t === this.#selected) await this.#openChat(t);
  }

  async #newThread(name: string | undefined): Promise<void> {
    const repo = this.#open();
    const env = this.#o.env;
    const trunk = await this.#handle(repo, repo.trunk);
    const made = name ?? (await nextForkName(trunk, 1, "thread"));
    const dir = await threadDir(env, repo.project, made);
    await env.host.fs.mkdir(env.host.path.dirname(dir));
    const convo = await trunk.newThread(made, { worktree: dir, inheritSetup: true });
    this.#handles.set(made, convo);
    await this.#sendGraph();
    await this.#openChat(made);
  }

  async #fork(thread: string, commit: string, name: string | undefined): Promise<void> {
    const repo = this.#open();
    const h = await this.#handle(repo, thread);
    const at = await this.#entryAt(h, thread, commit);
    const made = await createFork(this.#o.env, repo.project, h, name, at);
    this.#handles.set(made.branch, made.conversation);
    await this.#sendGraph();
    await this.#openChat(made.branch);
  }

  async #rewind(thread: string, commit: string): Promise<void> {
    const repo = this.#open();
    await this.#assertQuiet(repo, thread, "go back");
    const h = await this.#handle(repo, thread);
    await h.rewind(commit);
    this.#notify(`Went back to ${commit.slice(0, 7)}; what came after is kept and can be recovered`);
    await this.#changed(thread);
  }

  /** What the fork came to, in a sentence for the record of the merge: what its model last said. */
  async #summaryOf(repo: Repo, thread: string): Promise<string> {
    const h = await this.#handle(repo, thread);
    const entries = (await h.readEntries()).flatMap((r) => (r.ok ? [r.value] : []));
    for (const e of entries.toReversed()) {
      if (e.$tag !== "assistant") continue;
      const part = e.blocks.find((b) => b.$tag === "text");
      if (part?.$tag === "text" && typeof part.text === "string" && part.text.trim() !== "") return part.text.trim().slice(0, 500);
    }
    return `Merged ${thread}`;
  }

  async #merge(from: string, into: string): Promise<void> {
    const repo = this.#open();
    await this.#assertQuiet(repo, from, "merge it");
    await this.#assertQuiet(repo, into, "merge into it");
    const target = await this.#handle(repo, into);
    await target.assertMergeable(from);
    await target.mergeFork(from, { summary: await this.#summaryOf(repo, from) });
    this.#notify(`Merged ${from} into ${into}`);
    await this.#changed(into, from);
  }

  async #archive(thread: string, archived: boolean): Promise<void> {
    const repo = this.#open();
    if (archived && thread === repo.trunk) throw new AppError("the main thread cannot be put away");
    await (archived ? repo.convo.archive(thread) : repo.convo.unarchive(thread));
    await this.#sendGraph();
  }

  async #delete(thread: string): Promise<void> {
    const repo = this.#open();
    if (thread === repo.trunk) throw new AppError("the main thread cannot be deleted");
    if (thread === repo.checkedOut)
      throw new AppError(`${thread} is checked out in the project folder`, "switch the workspace to another thread first");
    await this.#assertQuiet(repo, thread, "delete it");
    const h = this.#handles.get(thread);
    this.#handles.delete(thread);
    await h?.close();
    // The person has confirmed the thread is not wanted, merged or not; what git refuses is files in its folder that were never saved.
    const git = repo.convo.git;
    const wt = (await git.worktrees()).find((w) => w.branch === `refs/heads/${thread}`);
    if (wt !== undefined) {
      await git.removeWorktree(wt.path).catch((e: unknown) => {
        throw new AppError(`${thread}'s folder has changes that were never saved`, message(e));
      });
      await git.pruneWorktrees();
    }
    await git.run(["branch", "-D", thread]);
    this.#composers.delete(thread);
    this.#notify(`Deleted ${thread}; its commits stay until git collects garbage`);
    await this.#sendGraph();
    if (this.#selected === thread) await this.#openChat(repo.checkedOut);
  }

  async #trust(thread: string): Promise<void> {
    const repo = this.#open();
    const h = await this.#handle(repo, thread);
    await h.approveConfig();
    // The providers are built when a thread is opened, and an unapproved file was not read for them: open it again.
    this.#handles.delete(thread);
    await h.close();
    this.#notify(`Approved harness.yml for ${thread}`);
    if (thread === this.#selected) await this.#openChat(thread);
  }

  async #switchWorkspace(thread: string, snapshot: boolean): Promise<void> {
    const repo = this.#open();
    if (this.#runs.size > 0) throw new AppError("the model is working", "stop it or wait before switching the workspace");
    const was = repo.checkedOut;
    // The main thread is whatever was in the project folder when this began: remember it before the folder moves on.
    if ((await repo.main.git.getConfig("chattree.trunk").catch(() => undefined))?.trim() === undefined)
      await repo.main.git.setConfig("chattree.trunk", repo.trunk);
    try {
      await repo.convo.switchWorkspace(thread, snapshot ? { uncommitted: "snapshot" } : {});
    } catch (e) {
      if (!(e instanceof WorkspaceDirty)) throw e;
      this.#emit({ type: "workspace.uncommitted", thread, from: was, files: e.files.flatMap((f) => f.paths) });
      return;
    }
    // Handles on the folders that traded branches are no longer on the branch they were opened for: begin again.
    await this.#enter(repo.folder, { trunk: repo.trunk, selected: this.#selected });
    this.#notify(`The project folder now has ${thread}`);
    await this.#sendGraph();
    if (this.#selected !== undefined) await this.#openChat(this.#selected);
  }

  async #openFile(f: {
    thread: string;
    path: string;
    line?: number | undefined;
    endLine?: number | undefined;
    at?: string | undefined;
  }): Promise<void> {
    const repo = this.#open();
    const h = await this.#handle(repo, f.thread);
    const { path: p } = this.#o.env.host;
    const abs = p.resolve(h.dir, f.path);
    if (p.relative(h.dir, abs).startsWith("..")) throw new AppError(`${f.path} is not inside the thread's workspace`);
    const at = { line: f.line, endLine: f.endLine };
    if (f.at === undefined) {
      if ((await this.#o.env.host.fs.stat(abs)) === undefined) throw new AppError(`${f.path} is not in ${f.thread}'s workspace (any more)`);
      return this.#platform.openFile({ path: abs, ...at });
    }
    const bytes = await h.git.readFileAt(f.at, p.relative(h.dir, abs).replaceAll("\\", "/"));
    if (bytes === undefined) throw new AppError(`${f.path} did not exist at ${f.at.slice(0, 7)}`);
    return this.#platform.openFile({ path: abs, ...at, content: { label: `${f.path} @ ${f.at.slice(0, 7)}`, bytes } });
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
      case "chat.send":
        await this.#send(intent.text, intent.queued === true);
        return;
      case "chat.stop":
        this.#stop();
        return;
      case "chat.approve":
        this.#approve(intent.callId, intent.allow);
        return;
      case "chat.draft":
        if (this.#selected !== undefined) this.#composer(this.#selected).draft = intent.text;
        return;
      case "chat.attach":
        await this.#attach();
        return;
      case "chat.detach": {
        const c = this.#selected === undefined ? undefined : this.#composer(this.#selected);
        if (c === undefined) return;
        c.attachments = c.attachments.filter((a) => a.id !== intent.id);
        this.#staged.delete(intent.id);
        this.#emit({ type: "chat.composer", composer: structuredClone(c) });
        return;
      }
      case "thread.new":
        await this.#newThread(intent.name);
        return;
      case "thread.fork":
        await this.#fork(intent.thread, intent.commit, intent.name);
        return;
      case "thread.rewind":
        await this.#rewind(intent.thread, intent.commit);
        return;
      case "thread.merge":
        await this.#merge(intent.from, intent.into);
        return;
      case "thread.archive":
      case "thread.unarchive":
        await this.#archive(intent.thread, intent.type === "thread.archive");
        return;
      case "thread.delete":
        await this.#delete(intent.thread);
        return;
      case "thread.trust":
        await this.#trust(intent.thread);
        return;
      case "workspace.switch":
        // `remember` is the setting of the host that asked (the extension keeps it); the choice itself is all that is needed here.
        await this.#switchWorkspace(intent.thread, intent.uncommitted === "snapshot");
        return;
      case "file.open":
        await this.#openFile(intent);
        return;
      case "commit.copy":
        await this.#platform.copy(intent.commit);
        this.#notify(`Copied ${intent.commit.slice(0, 7)} to the clipboard`);
        return;
      default:
        throw new AppError(`${intent.type} is not available yet`);
    }
  }
}
