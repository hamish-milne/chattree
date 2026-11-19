import { canonicalInstructionPath } from "../../harness/instruction-files.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_MODEL, runInit } from "../../app/init.ts";
import { providerRegistry } from "../../app/providers.ts";
import type { AdapterRegistry } from "../../providers/registry.ts";
import { hostEnvironment } from "../../app/environment.ts";
import { createFork, findProject, nextForkName, openThread, threadDir, type Project } from "../../app/project.ts";
import { buildToolSet, type ToolSet } from "../../app/toolset.ts";
import { localOwner } from "../../app/owner.ts";
import type { AppEnv } from "../../app/env.ts";
import { AppError } from "../../app/errors.ts";
import { inspectWorkspace, type WorkspaceFolder } from "../../app/workspace.ts";
import { ChangeNotAllowed } from "../../harness/setup.ts";
import { WorkspaceDirty, type Conversation, type EntryRef } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import { entrySpends } from "../../harness/ledger.ts";
import type { HostEnvironment } from "../../harness/environment.ts";
import type { Approval, ApprovalRequest, LoopEvent } from "../../harness/loop.ts";
import { attachmentKind } from "../../harness/attachments.ts";
import type { HostedController } from "../host/web-host.ts";
import type { Activity, ChatState, Composer, ModelChoice, StatusBar } from "../model/chat.ts";
import type { GraphData, RepoEntry, ThreadStatus } from "../model/graph.ts";
import type { UiEvent, UiIntent } from "../model/protocol.ts";
import { diffBlocks } from "./diff-blocks.ts";
import { Background } from "./background.ts";
import { summarizeCall } from "../../app/tool-lines.ts";
import { traceHttp } from "../../providers/http.ts";
import { describeError, explain } from "./explain.ts";
import { mapEntries, type MapItem } from "./map-chat.ts";
import { runThread } from "./run-thread.ts";
import { mapGraph } from "./map-graph.ts";
import { approvalView, stalledReason, statusBar, threadBanner, threadStatus, unusualChange } from "./map-status.ts";
import type { Block } from "../model/transcript.ts";
import type { FormIssue, FormSpec } from "../model/form.ts";
import {
  HARNESS_FORM,
  MODEL_FORM,
  checkHarness,
  modelAdapter,
  modelForm,
  plainSchema,
  settingsIssues,
  checkProvider,
  harnessForm,
  instructionState,
  readHarness,
  withValue,
} from "./settings.ts";
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
  /** How often to look for changes made by other processes (a terminal, another window), in milliseconds; 0 never. Default 500. */
  pollMs?: number;
  /** For asking a model server what it offers; the platform's by default. */
  fetch?: typeof fetch;
  /** Where the log goes: what was asked, what the model did, and every failure in full. Never message text. */
  log?: (line: string) => void;
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
  /** When the current request was sent, and whether anything has come back since (for the log). */
  requestAt?: number;
  firstSeen?: boolean;
  /** What the run is doing now, for the line at the end of the transcript (`Activity`), and how much text the model has sent in this request. */
  activity?: Activity;
  chars?: number;
  /** The tool whose call the model is writing out. */
  calling?: string;
  /** The last time the count of characters was sent to the view. */
  charsSentAt?: number;
  done: Promise<void>;
}

/** What the view has been sent about the open thread, so later sends are only the differences. */
interface Sent {
  blocks: Block[];
  status: string;
  thread: string;
  approval: string;
  /** The questions of the threads below, and the threads this one is blocked on (as the view was last told). */
  forwarded: string;
  blocked: string;
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
    forwarded: JSON.stringify(state.forwarded ?? []),
    blocked: state.activity?.phase === "blocked" ? (state.activity.detail ?? "") : "",
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
  #timer: ReturnType<typeof setInterval> | undefined;
  /** What the graph was made from when it was last sent: the branches with their tips, and which are held. */
  #seen: string | undefined;
  #refreshing = false;
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
  /** The subagents and forks that run by themselves, and the questions of every thread (see `Background`). */
  #bg: Background | undefined;
  /** What the pump's runs are doing, in the shape of a run of ours, so they show the same way (status, stream, activity). */
  readonly #pumped = new Map<string, Run>();
  /** What `#questionsChanged` last saw. */
  #questionKey = JSON.stringify([[], null]);
  /** Threads the controller has run in this session. */
  readonly #ran = new Set<string>();
  /** Threads a message is being put on and started, which the pump must not start too. */
  readonly #sending = new Set<string>();
  /** What was owed on a thread the first time the pump said so: that is the person's to continue; what arrives afterwards runs by itself. */
  readonly #owedAt = new Map<string, string | undefined>();
  readonly #toolsets = new WeakMap<Conversation, Promise<ToolSet>>();
  readonly #environment: HostEnvironment | undefined;
  #sent: Sent | undefined;
  #active = 0;
  #quiet: (() => void)[] = [];
  readonly #lastStatus = new Map<string, ThreadStatus>();
  /** The `harness.yml` form: what is saved, what is being edited, and what is wrong with it. */
  #harness: { saved: Record<string, unknown>; working: Record<string, unknown>; issues: FormIssue[] } | undefined;
  #registry: AdapterRegistry | undefined;
  #settingsOpen = false;
  /** Instruction files the person turned off for a thread in this session (the transcript only has the ones that are on). */
  readonly #offFiles = new Map<string, Set<string>>();
  /** Model settings being edited for a thread, not applied yet. */
  readonly #modelEdits = new Map<string, { working: Record<string, unknown>; issues: FormIssue[] }>();
  #seq = 0;

  constructor(o: ControllerOptions) {
    this.#o = o;
    this.#platform = o.platform ?? headlessPlatform;
    this.#session = o.session ?? `ui-${Math.random().toString(36).slice(2, 10)}`;
    // CHATTREE_ENVIRONMENT=off leaves the note about this machine out, for tests that need the transcript to hold only what was typed.
    this.#environment = o.env.env["CHATTREE_ENVIRONMENT"] === "off" ? undefined : hostEnvironment(o.env);
    // What every provider request did: in the log (the status, and each retry with how long it waits: a long wait looks like a slow
    // model), and on the thread whose run made it (the run's async context says which), so the transcript can say it is retrying.
    traceHttp({
      onRequest: (v) => {
        this.#log(`http: ${v.method} ${v.url} attempt ${v.attempt} (${v.body.length} bytes)`);
        if (v.attempt > 1) this.#during((t, run) => this.#setActivity(t, run, { phase: "waiting", since: Date.now(), attempt: v.attempt }));
      },
      onResponse: (v) => this.#log(`http: response ${v.status} (attempt ${v.attempt})`),
      onRetry: (v) => {
        const why = `${v.error.status === undefined ? v.error.kind : `${v.error.status} ${v.error.kind}`}: ${v.error.message}`;
        this.#log(`http: attempt ${v.attempt} failed (${why}); waiting ${v.waitMs} ms`);
        const now = Date.now();
        this.#during((t, run) =>
          this.#setActivity(t, run, {
            phase: "retrying",
            since: now,
            until: now + v.waitMs,
            attempt: v.attempt + 1,
            detail: why.slice(0, 200),
          }),
        );
      },
    });
  }

  /** The thread whose run is making the call this code is in, found by the async context the run started in. */
  readonly #runOf = new AsyncLocalStorage<{ thread: string; run: Run }>();
  #during(f: (thread: string, run: Run) => void): void {
    const at = this.#runOf.getStore();
    if (at !== undefined) f(at.thread, at.run);
  }

  /** Show what the run is doing now (or nothing, when it is not working); only the open thread's view is told. */
  #setActivity(thread: string, run: Run, a: Activity | undefined): void {
    if (a === undefined) delete run.activity;
    else run.activity = a;
    if (thread === this.#selected && !this.#closed)
      this.#emit({ type: "chat.activity", ...(a === undefined ? {} : { activity: structuredClone(a) }) });
  }

  /** Carry out an intent after those before it; resolves when it is done (used by `idle`). */
  handle(intent: UiIntent): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#closed) return;
      try {
        await this.#start();
        await this.#run(intent);
      } catch (e) {
        this.#log(`${intent.type} failed: ${describeError(e)}`);
        this.#notify(e instanceof AppError && e.hint !== undefined ? `${e.message} (${e.hint})` : message(e), "error");
      }
    });
  }

  #log(line: string): void {
    try {
      this.#o.log?.(line);
    } catch {
      /* a log that throws must not stop the work */
    }
  }

  /** Resolves when every intent received so far has been carried out and no request is working (one waiting for an answer is not). */
  async idle(): Promise<void> {
    for (;;) {
      const q = this.#queue;
      await q;
      if (this.#active > 0) await new Promise<void>((r) => this.#quiet.push(r));
      // The threads that run by themselves count too (not the questions they wait on). With no timer nobody else drives the pump, so this
      // does: it looks at the threads until nothing more starts. With one, the pump's own watch starts them, and this waits for what runs.
      const pump = this.#bg?.pump;
      if (pump !== undefined && (this.#o.pollMs ?? 500) === 0) await pump.settle().catch(() => undefined);
      else if (pump?.runs.list().some((r) => r.state === "running") === true)
        // oxlint-disable-next-line typescript/await-thenable -- `cycleEnd` is undefined for a run that has gone
        await Promise.all(pump.runs.list().map((r) => pump.runs.get(r.branch)?.cycleEnd({ next: false })));
      if (q === this.#queue && this.#active === 0) return;
    }
  }

  #work(delta: 1 | -1): void {
    this.#active += delta;
    if (this.#active === 0) for (const r of this.#quiet.splice(0)) r();
  }

  /**
   * Look at the repository again, and send what another process changed (a commit from a terminal, a thread another window took).
   * Runs in turn with the intents. Called by the timer; a test or a host that is told of a change can call it itself.
   */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const done = this.#queue.then(async () => {
      if (this.#closed || this.#repo === undefined) return;
      try {
        await this.#sync(this.#repo);
      } catch {
        // The repository may be in the middle of a change by the other process: the next look sees it whole.
      }
    });
    this.#queue = done;
    return done;
  }

  async #sync(repo: Repo): Promise<void> {
    const seen = await this.#signature(repo);
    if (this.#seen === undefined) this.#seen = seen;
    if (seen === this.#seen) return;
    await this.#sendGraph();
    // A thread this session is not working on may have been written by someone else: read it again rather than trust what a handle remembers.
    for (const [name, h] of [...this.#handles]) {
      if (this.#runs.has(name)) continue;
      this.#handles.delete(name);
      await h.close();
    }
    const open = this.#selected;
    if (open !== undefined && !this.#runs.has(open)) await this.#publish(open);
  }

  async #signature(repo: Repo): Promise<string> {
    return JSON.stringify([await repo.convo.listBranches(), [...(await this.#statuses(repo))]]);
  }

  async close(): Promise<void> {
    this.#closed = true;
    traceHttp(undefined);
    if (this.#timer !== undefined) clearInterval(this.#timer);
    for (const r of this.#runs.values()) {
      r.abort.abort();
      r.pending?.resolve({ allow: false });
    }
    await this.#queue;
    await Promise.all([...this.#runs.values()].map((r) => r.done));
    await this.#bg?.close();
    this.#bg = undefined;
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
      const every = this.#o.pollMs ?? 500;
      if (every > 0 && !this.#closed) {
        this.#timer = setInterval(() => {
          if (this.#refreshing) return;
          this.#refreshing = true;
          void this.refresh().finally(() => (this.#refreshing = false));
        }, every);
        this.#timer.unref();
      }
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
    await this.#bg?.close();
    this.#bg = undefined;
    this.#pumped.clear();
    this.#owedAt.clear();
    await this.#dropHandles();
    this.#repo = { folder, project: found, main, convo, trunk: keep?.trunk ?? (await this.#trunkOf(main)), checkedOut: found.branch };
    this.#questionKey = JSON.stringify([[], null]);
    this.#bg = this.#makeBackground(this.#repo);
    if ((this.#o.pollMs ?? 500) > 0) this.#bg.pump.watch();
    this.#selected = keep?.selected ?? found.branch;
    await old?.convo.close();
    // The settings are the new repository's: the sheet, if it is open, shows them.
    this.#harness = undefined;
    if (this.#settingsOpen) await this.#sendHarness();
  }

  /** Start a conversation in a workspace folder, with no provider: the person adds one in the settings, which open on the Providers page. */
  async #initRepo(id: string): Promise<void> {
    const folder = this.#folders.find((f) => f.path === id);
    if (folder === undefined) throw new AppError(`there is no folder ${id} in this workspace`);
    if (folder.state.kind === "unusable") throw new AppError(`${folder.name}: ${folder.state.reason}`);
    if (folder.state.kind === "conversation") throw new AppError(`${folder.name} already has a conversation`);
    if (this.#runs.size > 0) throw new AppError("the model is working", "stop it before switching repository");
    const adopt = folder.state.mode === "adopt";
    const done = await runInit(this.#o.env, { dir: folder.path, provider: "none", ...(adopt ? { adopt: true } : {}) });
    this.#folders = await inspectWorkspace(this.#o.env, this.#o.folders);
    const now = this.#folders.find((f) => f.path === id);
    if (now === undefined || now.state.kind !== "conversation")
      throw new AppError(`${folder.name} could not be opened after it was started`);
    await this.#enter(now);
    // The file is the one `init` has just written for this person.
    if (this.#repo !== undefined) await (await this.#handle(this.#repo, this.#repo.trunk)).approveConfig();
    this.#settingsOpen = true;
    await this.#sendGraph();
    await this.#openChat(this.#repo?.checkedOut ?? done.branch);
    await this.#sendHarness();
    this.#emit({ type: "settings.open", page: "providers" });
    this.#notify(`Started a conversation in ${folder.path}${adopt ? ` on its branch ${done.branch}` : ""}`);
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
    // A thread with a question waiting is asking, and so is every thread that waits for it: the person should be able to see it from above.
    for (const q of this.#bg?.questions() ?? []) {
      out.set(q.branch, "awaiting");
      for (const a of q.ancestors) out.set(a, "awaiting");
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
    this.#seen = await this.#signature(repo);
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
    const run = this.#runs.get(name) ?? this.#pumped.get(name);
    // A thread whose call waits for a decision that the pump holds (a subagent's), and the threads one is blocked on.
    const ask = this.#runs.has(name) ? undefined : this.#bg?.own(name);
    const blockedOn = this.#runs.has(name) || run !== undefined ? undefined : this.#bg?.blockedOn(name);
    const below = this.#bg?.below(name) ?? [];
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
        ? threadStatus({ lease, entries, awaiting: ask !== undefined, self: (o) => o.session === this.#session })
        : run.pending === undefined && ask === undefined
          ? "running"
          : "awaiting";
    // Waiting for other threads is not a stall; nor is a thread the pump is about to run or has a question on.
    const stalled =
      run === undefined && blockedOn === undefined && ask === undefined && (state === "idle" || state === "error")
        ? stalledReason(entries)
        : undefined;
    const bar: StatusBar = statusBar({
      state,
      stalled,
      setup,
      info: setup.model === undefined ? undefined : h.modelInfo(setup.model.provider, setup.model.id),
      ledger,
      entries,
    }) ?? {
      state,
      model: "No model yet",
      provider: "none",
    };
    const banner = threadBanner({
      trust: await h.configTrust(),
      hasProvider: h.providers.size > 0,
      unusual: unusualChange(setup.unacknowledged, refs),
    });
    const settings = await this.#modelSettingsForm(h, name);
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
        ...(run?.pending !== undefined
          ? { approval: approvalView(run.pending.request) }
          : ask === undefined
            ? {}
            : { approval: approvalView({ callId: ask.callId, name: ask.name, args: ask.args }) }),
        ...(below.length === 0
          ? {}
          : {
              forwarded: below.map((q) => ({
                thread: q.branch,
                callId: q.callId,
                tool: q.name,
                summary: approvalView({ callId: q.callId, name: q.name, args: q.args }).summary,
              })),
            }),
        ...(run?.activity !== undefined
          ? { activity: structuredClone(run.activity) }
          : blockedOn === undefined
            ? {}
            : { activity: { phase: "blocked" as const, since: 0, detail: blockedOn.join(",") } }),
        ...(banner === undefined ? {} : { banner }),
        model: this.#models(h, setup.model === undefined ? "" : `${setup.model.provider}/${setup.model.id}`),
        ...(settings === undefined ? {} : { settings }),
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
    // The sheet shows the selected thread's instruction files.
    if (this.#settingsOpen) await this.#sendInstructions();
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
    if (now.forwarded !== sent.forwarded) this.#emit({ type: "chat.forwarded", questions: state.forwarded ?? [] });
    if (now.blocked !== sent.blocked)
      this.#emit({ type: "chat.activity", ...(state.activity === undefined ? {} : { activity: state.activity }) });
    if (now.banner !== sent.banner) this.#emit({ type: "chat.banner", ...(state.banner === undefined ? {} : { banner: state.banner }) });
    this.#sent = now;
  }

  /** The runner for a repository's subagents and self-running forks, and the questions of its threads. */
  #makeBackground(repo: Repo): Background {
    return new Background({
      env: this.#o.env,
      session: this.#session,
      project: repo.project,
      trunk: repo.convo,
      environment: this.#environment,
      toolsetFor: async (thread) => this.#toolset(repo, await this.#handle(repo, thread), thread),
      // The thread on screen and any the person has a request on are the controller's: it runs them, and the pump only says when one is owed.
      ran: (thread) => this.#ran.has(thread),
      owns: (thread) => this.#runs.has(thread) || this.#sending.has(thread) || thread === this.#selected,
      wanted: (thread, at) => {
        if (this.#runs.has(thread) || this.#sending.has(thread)) return;
        // What was owed when the thread was first looked at is the person's to continue (the Continue button); what arrives later runs by itself.
        if (!this.#owedAt.has(thread)) this.#owedAt.set(thread, at);
        if (this.#owedAt.get(thread) === at) return;
        this.#owedAt.set(thread, at);
        this.#carryOn(thread);
      },
      event: async (thread, e) => {
        let run = this.#pumped.get(thread);
        if (run === undefined) {
          run = { abort: new AbortController(), awaiting: new Set(), running: new Set(), active: true, done: Promise.resolve() };
          this.#pumped.set(thread, run);
          this.#log(`background run on ${thread} started`);
          this.#setActivity(thread, run, { phase: "preparing", since: Date.now() });
        }
        await this.#runOf.run({ thread, run }, () => this.#onLoop(thread, run, e)).catch(() => undefined);
      },
      ended: (thread, why) => {
        const run = this.#pumped.get(thread);
        this.#pumped.delete(thread);
        if (run !== undefined) this.#setActivity(thread, run, undefined);
        this.#log(`background run on ${thread} ended${why === undefined ? "" : `: ${why}`}`);
        if (why !== undefined) this.#notify(`${thread} stopped: ${why}`, "warning");
        void this.#publish(thread).catch(() => undefined);
        this.#questionsChanged();
      },
      changed: () => this.#questionsChanged(),
      say: (t) => this.#notify(t),
    });
  }

  /**
   * The questions waiting, or what a thread waits for, changed: the graph shows which threads are asking, and the open thread shows
   * the questions of the threads below it. The pump's runs are not ours, so nothing else tells the view.
   */
  #questionsChanged(): void {
    if (this.#closed || this.#repo === undefined) return;
    const open = this.#selected;
    // The pump says so after every look; only a change in who asks, or in what the open thread waits for, is news.
    const key = JSON.stringify([
      (this.#bg?.questions() ?? []).map((q) => [q.branch, q.callId, q.ancestors]),
      open === undefined ? null : (this.#bg?.blockedOn(open) ?? null),
    ]);
    if (key === this.#questionKey) return;
    this.#questionKey = key;
    void this.#sendGraph().catch(() => undefined);
    if (open === undefined) return;
    // Only a thread whose view shows (or showed) something from the pump is read again for it.
    const sent = this.#sent;
    const shown = sent !== undefined && (sent.forwarded !== "[]" || sent.blocked !== "" || sent.approval !== "null");
    const now = (this.#bg?.below(open).length ?? 0) > 0 || this.#bg?.own(open) !== undefined || this.#bg?.blockedOn(open) !== undefined;
    if (shown || now) void this.#publish(open).catch(() => undefined);
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
        pumped: true,
        // `fork` and `merge`: a fork the model makes is a thread like any other (it shows in the graph), and the first message it leaves
        // for it waits in that thread's composer for the person to send. (`auto_run` forks and subagents run in the background, see `Background`.)
        createFork: async (name) => {
          const made = await createFork(this.#o.env, repo.project, convo, name);
          this.#handles.set(made.branch, made.conversation);
          void this.#sendGraph().catch(() => undefined);
          return made;
        },
        onForkDraft: (branch, first) => {
          this.#prefill(branch, first);
          this.#notify(`The model started ${branch} and left a first message for it in its composer`);
        },
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
    this.#logLoop(thread, run, e);
    switch (e.type) {
      case "stream": {
        const ev = e.event;
        if (ev.type === "text.delta") {
          this.#stream(thread, "text", ev.text);
          this.#streaming(thread, run, undefined, ev.text.length);
        } else if (ev.type === "reasoning.delta") {
          this.#stream(thread, "reasoning", ev.text);
          this.#streaming(thread, run, "thinking", ev.text.length);
        } else if (ev.type === "tool_call.start") {
          run.calling = ev.name;
          this.#streaming(thread, run, `calling ${ev.name}`, 0);
        } else if (ev.type === "tool_call.delta") this.#streaming(thread, run, `calling ${run.calling ?? "a tool"}`, ev.args_delta.length);
        else if (ev.type === "started") this.#streaming(thread, run, undefined, 0);
        return;
      }
      case "tool.start":
        run.running.add(e.callId);
        this.#setActivity(thread, run, { phase: "tool", since: Date.now(), detail: summarizeCall(e.name, e.args) });
        break;
      case "tool.approval":
      case "tool.result":
        run.awaiting.delete(e.callId);
        if (e.type === "tool.result") {
          run.running.delete(e.callId);
          this.#setActivity(thread, run, { phase: "preparing", since: Date.now() });
        }
        break;
      case "request.start":
        run.chars = 0;
        this.#setActivity(thread, run, { phase: "preparing", since: Date.now() });
        return;
      case "request.end":
        this.#setActivity(thread, run, { phase: "preparing", since: Date.now() });
        break;
      default:
        break;
    }
    await this.#publish(thread);
  }

  /** Text has arrived from the model: the phase becomes `streaming` (its start is the first text), and the count follows at most twice a second. */
  #streaming(thread: string, run: Run, detail: string | undefined, chars: number): void {
    const now = Date.now();
    run.chars = (run.chars ?? 0) + chars;
    const was = run.activity;
    const same = was?.phase === "streaming" && was.detail === detail;
    if (same && now - (run.charsSentAt ?? 0) < 500) return;
    run.charsSentAt = now;
    this.#setActivity(thread, run, {
      phase: "streaming",
      since: same ? was.since : now,
      chars: run.chars,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** What a request did and how long each part took, for the log (no text of the conversation). */
  #logLoop(thread: string, run: Run, e: LoopEvent): void {
    const since = (): string => `${Date.now() - (run.requestAt ?? Date.now())} ms`;
    switch (e.type) {
      case "request.start":
        run.requestAt = Date.now();
        run.firstSeen = false;
        this.#log(`${thread}: request ${e.n} sent`);
        return;
      case "stream":
        if (run.firstSeen !== true) {
          run.firstSeen = true;
          this.#log(`${thread}: first ${e.event.type} ${since()} after the request`);
        }
        return;
      case "request.end":
        this.#log(
          `${thread}: request ${e.n} ${e.result.status}${e.result.status === "completed" ? ` (${e.result.completed.stop_reason})` : ""} after ${since()}`,
        );
        return;
      case "tool.start":
        this.#log(`${thread}: tool ${e.name} started`);
        return;
      case "tool.approval":
        this.#log(
          `${thread}: tool ${e.name} ${e.allowed ? "allowed" : "refused"} (${e.via ?? "?"})${e.reason === undefined ? "" : `: ${e.reason}`}`,
        );
        return;
      case "tool.result":
        this.#log(
          `${thread}: tool ${e.name} ${e.is_error ? "failed" : "finished"} in ${e.ms} ms${e.skipped === undefined ? "" : ` (skipped: ${e.skipped})`}`,
        );
        return;
      default:
        return;
    }
  }

  /** A call no grant covers: park until the person answers (or stops the turn). */
  #ask(thread: string, run: Run, request: ApprovalRequest): Promise<Approval> {
    return new Promise<Approval>((resolve) => {
      this.#log(`${thread}: tool ${request.name} waits for approval (${request.callId})`);
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
      this.#setActivity(thread, run, undefined);
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
    // The pump must not start a request for this message too: from the append until our own run is going, the thread is ours.
    this.#sending.add(thread);
    try {
      await h.append(content);
      for (const a of composer.attachments) this.#staged.delete(a.id);
      this.#composers.set(thread, { draft: "", attachments: [] });
      this.#emit({ type: "chat.composer", composer: { draft: "", attachments: [] } });
      if (running !== undefined) return await this.#publish(thread);
      this.#startRun(repo, h, thread);
    } finally {
      this.#sending.delete(thread);
    }
  }

  /** Run the model on the thread as it stands, until it has answered (a message was just added, or the thread stalled). */
  #startRun(repo: Repo, h: Conversation, thread: string): void {
    const run: Run = { abort: new AbortController(), awaiting: new Set(), running: new Set(), active: true, done: Promise.resolve() };
    this.#runs.set(thread, run);
    this.#ran.add(thread);
    this.#log(`run on ${thread} started`);
    this.#setActivity(thread, run, { phase: "preparing", since: Date.now() });
    this.#work(1);
    let carryOn = false;
    run.done = this.#runOf.run({ thread, run }, async () => {
      try {
        const tools = await this.#toolset(repo, h, thread);
        await this.#publish(thread);
        const result = await runThread({
          env: this.#o.env,
          convo: h,
          tools,
          session: this.#session,
          signal: run.abort.signal,
          environment: this.#environment,
          approve: (r) => this.#ask(thread, run, r),
          // The request is made ready: notes about the setup and the machine have been committed by now, and a slow model must not hide them.
          onPrepared: async () => {
            this.#log(`${thread}: request prepared`);
            this.#setActivity(thread, run, { phase: "waiting", since: Date.now() });
            await this.#publish(thread).catch(() => undefined);
          },
          onEvent: (e) => this.#onLoop(thread, run, e),
        });
        // A run that ended by its own course leaves what comes next to whatever the thread waits for (a subagent's report): that runs by itself.
        carryOn = result.status === "completed" || result.status === "finished" || result.status === "blocked";
      } catch (e) {
        this.#log(`run on ${thread} failed: ${describeError(e)}`);
        this.#notify(explain(e), "error");
      } finally {
        this.#log(`run on ${thread} ended`);
        // A run that failed, or was stopped, leaves what is owed for the person to continue (the Continue button), or the pump would try again
        // in a circle; one that ended by its own course leaves what comes next to the pump.
        this.#owedAt.set(thread, carryOn ? undefined : await this.#lastEntryId(h).catch(() => undefined));
        this.#runs.delete(thread);
        this.#setActivity(thread, run, undefined);
        await this.#publish(thread).catch(() => undefined);
        this.#work(-1);
      }
    });
  }

  /** The pump says a thread of ours is owed a request (a subagent handed back): run it, on screen or not, as the person's Continue would. */
  #carryOn(thread: string): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#closed) return;
      try {
        await this.#start();
        await this.#resume(thread);
      } catch (e) {
        this.#log(`could not carry on ${thread}: ${describeError(e)}`);
      }
    });
  }

  /** The id of the last entry that says something about the thread's state (not set-up, approvals or injections), as the pump reads it. */
  async #lastEntryId(h: Conversation): Promise<string | undefined> {
    const entries = (await h.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const last = entries.findLast(
      (e) => e.$tag !== "header" && e.$tag !== "agent_setup" && e.$tag !== "approval" && e.$tag !== "injection",
    );
    return last !== undefined && "id" in last && typeof last.id === "string" ? last.id : undefined;
  }

  /** Carry on a thread that stalled: the model is run on it as it is, with no message added. */
  async #resume(on?: string): Promise<void> {
    const repo = this.#repo;
    const thread = on ?? this.#selected;
    if (repo === undefined || thread === undefined) throw new AppError("there is no thread open");
    if (this.#runs.has(thread)) throw new AppError("the model is already working on this thread");
    // A subagent that stopped is run again as a subagent (with its own tools), by the pump.
    if (this.#bg?.resume(thread) === true) return;
    await this.#assertQuiet(repo, thread, "carry on");
    const h = await this.#handle(repo, thread);
    await h.assertConfigTrusted();
    if (h.providers.size === 0 || (await h.setup()).model === undefined)
      throw new AppError("there is no model for this thread yet", "add a provider in the settings first");
    this.#startRun(repo, h, thread);
    await this.#publish(thread);
  }

  #stop(): void {
    const run = this.#selected === undefined ? undefined : this.#runs.get(this.#selected);
    if (run === undefined) {
      // A run the pump has on this thread (a subagent): stopped, and left alone until the person resumes it.
      if (this.#selected !== undefined) this.#bg?.stop(this.#selected);
      return;
    }
    run.abort.abort();
    run.pending?.resolve({ allow: false, reason: "stopped" });
  }

  async #approve(callId: string, allow: boolean): Promise<void> {
    const thread = this.#selected;
    const run = thread === undefined ? undefined : this.#runs.get(thread);
    if (run?.pending !== undefined && run.pending.request.callId === callId) {
      run.pending.resolve(allow ? { allow: true } : { allow: false });
      return;
    }
    // A question the pump holds: the thread's own (a subagent's), answered into its transcript so its loop goes on.
    const ask = thread === undefined ? undefined : this.#bg?.own(thread);
    if (thread === undefined || ask === undefined || ask.callId !== callId || this.#bg === undefined)
      throw new AppError("that question is no longer waiting for an answer");
    const r = await this.#bg.pump.answer(thread, callId, allow ? { allow: true } : { allow: false });
    if (r.status !== "recorded") throw new AppError("that question is no longer waiting for an answer");
    await this.#publish(thread);
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

  /**
   * The entry just before the one `commit` holds, and what the person typed in the entry (when it is a message of theirs),
   * for going back to before it and trying again.
   */
  async #before(h: Conversation, commit: string): Promise<{ target: EntryRef; text: string }> {
    const refs = await h.index();
    const at = refs.findIndex((r) => r.commit === commit);
    const target = refs[at - 1];
    if (at < 0 || target === undefined) throw new AppError("there is nothing before that to go back to");
    // The entries and their refs run in step (the chat reads them the same way).
    const found = (await h.readEntries())[at];
    const entry = found?.ok === true ? found.value : undefined;
    const text =
      entry?.$tag === "user"
        ? entry.content.flatMap((p) => (p.$tag === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n\n")
        : "";
    return { target, text };
  }

  /** Put text in a thread's composer ahead of what the person had typed there, so nothing they wrote is lost. */
  #prefill(thread: string, text: string): void {
    if (text === "") return;
    const c = this.#composer(thread);
    c.draft = c.draft.trim() === "" ? text : `${text}\n\n${c.draft}`;
  }

  async #fork(thread: string, commit: string, name: string | undefined, before: boolean): Promise<void> {
    const repo = this.#open();
    const h = await this.#handle(repo, thread);
    const back = before ? await this.#before(h, commit) : undefined;
    const at = back?.target ?? (await this.#entryAt(h, thread, commit));
    const made = await createFork(this.#o.env, repo.project, h, name, at);
    this.#handles.set(made.branch, made.conversation);
    if (back !== undefined) this.#prefill(made.branch, back.text);
    await this.#sendGraph();
    await this.#openChat(made.branch);
  }

  async #rewind(thread: string, commit: string, before: boolean): Promise<void> {
    const repo = this.#open();
    await this.#assertQuiet(repo, thread, "go back");
    const h = await this.#handle(repo, thread);
    const back = before ? await this.#before(h, commit) : undefined;
    await h.rewind(back?.target.commit ?? commit);
    // Where it stands now is the person's doing: what it owes is theirs to continue, not for the pump to start.
    this.#owedAt.set(thread, await this.#lastEntryId(h));
    if (back !== undefined) this.#prefill(thread, back.text);
    this.#notify(`Went back to ${commit.slice(0, 7)}; what came after is kept and can be recovered`);
    await this.#changed(thread);
  }

  /** Keep what changed the agent (see the `unusual_change` banner): the entries that record it are acknowledged, and requests go out again. */
  async #accept(thread: string): Promise<void> {
    const repo = this.#open();
    await this.#assertQuiet(repo, thread, "accept a change");
    const h = await this.#handle(repo, thread);
    const pending = (await h.setup()).unacknowledged.map((u) => u.id);
    if (pending.length === 0) return;
    await h.setupChange({}, { acknowledges: pending });
    this.#notify("Kept the change");
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

  // ---- settings --------------------------------------------------------------------------------------------

  #providers(): AdapterRegistry {
    return (this.#registry ??= providerRegistry(this.#o.env));
  }

  #harnessForm(): FormSpec {
    const h = this.#harness;
    if (h === undefined) throw new AppError("the settings are not open");
    return harnessForm(this.#providers(), h.saved, h.working, h.issues);
  }

  /** Read the file again (`reread`, or when it was never read) and send the form. */
  async #sendHarness(reread = true, id = HARNESS_FORM): Promise<void> {
    if (id !== HARNESS_FORM) throw new AppError(`there is no form ${id}`);
    if (reread || this.#harness === undefined) {
      const repo = this.#open();
      const file = await readHarness(await this.#handle(repo, repo.trunk));
      const issues = file.issues.length > 0 ? file.issues : await checkHarness(file.value, this.#providers());
      this.#harness = { saved: file.value, working: file.value, issues };
    }
    this.#emit({ type: "form.set", form: this.#harnessForm() });
    await this.#sendInstructions();
  }

  /** The selected thread's instruction files to the sheet. */
  async #sendInstructions(): Promise<void> {
    const repo = this.#open();
    const thread = this.#selected;
    if (thread === undefined) return;
    const off = this.#offFiles.get(thread) ?? new Set<string>();
    this.#emit({ type: "instructions.set", state: await instructionState(await this.#handle(repo, thread), off) });
  }

  async #changeInstructions(
    intent: Extract<UiIntent, { type: "instructions.add" | "instructions.enable" | "instructions.remove" }>,
  ): Promise<void> {
    const repo = this.#open();
    const thread = this.#selected;
    if (thread === undefined) throw new AppError("there is no thread to give instructions to");
    if (this.#runs.has(thread)) throw new AppError("the model is working", "change the instructions when it has finished");
    const convo = await this.#handle(repo, thread);
    let path: string;
    try {
      path = canonicalInstructionPath(intent.path);
    } catch (e) {
      throw new AppError(message(e));
    }
    const off = this.#offFiles.get(thread) ?? new Set<string>();
    this.#offFiles.set(thread, off);
    const on = intent.type === "instructions.add" || (intent.type === "instructions.enable" && intent.on);
    try {
      await convo.setInstructionFiles({ [path]: on ? {} : null });
    } catch (e) {
      throw new AppError(message(e), "the file has to be text in this thread's working tree");
    }
    if (on || intent.type === "instructions.remove") off.delete(path);
    else off.add(path);
    await this.#openChat(thread);
  }

  // ---- the thread's model ----------------------------------------------------------------------------------

  /** The form for the open thread's model settings: the adapter's schema over what the thread has, or what is being edited. */
  async #modelSettingsForm(h: Conversation, thread: string): Promise<FormSpec | undefined> {
    const found = await modelAdapter(h, this.#providers());
    if (found === undefined) return undefined;
    const saved = found.model.settings ?? {};
    const edit = this.#modelEdits.get(thread);
    return modelForm(plainSchema(found.def.settings), saved, edit?.working ?? saved, edit?.issues ?? []);
  }

  async #sendModelForm(thread: string): Promise<void> {
    const form = await this.#modelSettingsForm(await this.#handle(this.#open(), thread), thread);
    if (form !== undefined) this.#emit({ type: "form.set", form });
  }

  #selectedThread(): string {
    if (this.#selected === undefined) throw new AppError("there is no thread open");
    return this.#selected;
  }

  async #editModel(value: Record<string, unknown>): Promise<void> {
    const thread = this.#selectedThread();
    const found = await modelAdapter(await this.#handle(this.#open(), thread), this.#providers());
    if (found === undefined) throw new AppError("this thread has no model to set");
    this.#modelEdits.set(thread, { working: value, issues: settingsIssues(found.def, value) });
    await this.#sendModelForm(thread);
  }

  async #revertModel(): Promise<void> {
    const thread = this.#selectedThread();
    this.#modelEdits.delete(thread);
    await this.#sendModelForm(thread);
  }

  async #saveModel(): Promise<void> {
    const thread = this.#selectedThread();
    const edit = this.#modelEdits.get(thread);
    if (edit === undefined) return;
    if (edit.issues.length > 0) throw new AppError("the model settings have problems", "fix them first");
    if (this.#runs.has(thread)) throw new AppError("the model is working", "change its settings when it has finished");
    const h = await this.#handle(this.#open(), thread);
    const model = (await h.setup()).model;
    if (model === undefined) throw new AppError("this thread has no model to set");
    await this.#changeSetup(h, { model: { ...model, settings: edit.working } });
    this.#modelEdits.delete(thread);
    await this.#openChat(thread);
  }

  /** Choose the thread's model (`provider/id`). Settings belong to a provider, so only `max_output_tokens` moves to another one. */
  async #chooseModel(want: string): Promise<void> {
    const thread = this.#selectedThread();
    if (this.#runs.has(thread)) throw new AppError("the model is working", "change the model when it has finished");
    const h = await this.#handle(this.#open(), thread);
    const slash = want.indexOf("/");
    const provider = want.slice(0, slash);
    const id = want.slice(slash + 1);
    const cfg = await h.readConfig();
    const tag = cfg?.ok === true ? cfg.value.providers[provider]?.$tag : undefined;
    const def = tag === undefined ? undefined : this.#providers().get(tag);
    if (slash <= 0 || id === "" || def === undefined) throw new AppError(`there is no provider for ${want}`, "add one in the settings");
    const current = (await h.setup()).model;
    let settings = provider === current?.provider ? current.settings : undefined;
    if (provider !== current?.provider && current?.settings?.["max_output_tokens"] !== undefined) {
      const carried = { max_output_tokens: current.settings["max_output_tokens"] };
      if (settingsIssues(def, carried).length === 0) settings = carried;
    }
    const changed = await this.#changeSetup(h, { model: { provider, id, ...(settings === undefined ? {} : { settings }) } });
    // A new provider has its own price table: pin it, so the costs recorded from here on use the prices in force now.
    if (changed && provider !== current?.provider) await h.pinPricing();
    this.#modelEdits.delete(thread);
    await this.#openChat(thread);
  }

  /**
   * Apply a change to the thread's setup. The sheet cannot yet ask about a change the way the command line does, so what a model
   * change always costs (a different model, a rewritten cache) is accepted and anything else (more cost, a smaller window, a
   * change in the middle of a tool loop) is refused with what it would do.
   */
  async #changeSetup(h: Conversation, change: Parameters<Conversation["setupChange"]>[0]): Promise<boolean> {
    try {
      return (
        (await h.setupChange(change, { allow: ["model_changed", "provider_changed", "cache_break", "reasoning_dropped"] })) !== undefined
      );
    } catch (e) {
      if (e instanceof ChangeNotAllowed)
        throw new AppError(
          e.changes.map((c) => c.message).join("; "),
          `refused: ${e.allowWith.join(", ")} need a decision the settings cannot ask for yet`,
        );
      throw e;
    }
  }

  async #editHarness(id: string, value: Record<string, unknown>): Promise<void> {
    if (id !== HARNESS_FORM) throw new AppError(`there is no form ${id}`);
    if (this.#harness === undefined) await this.#sendHarness();
    const h = this.#harness;
    if (h === undefined) return;
    this.#harness = { ...h, working: value, issues: await checkHarness(value, this.#providers()) };
    this.#emit({ type: "form.set", form: this.#harnessForm() });
  }

  async #saveHarness(id: string, commitMessage: string): Promise<void> {
    if (id !== HARNESS_FORM) throw new AppError(`there is no form ${id}`);
    const h = this.#harness;
    if (h === undefined) throw new AppError("the settings are not open");
    if (h.issues.length > 0) throw new AppError("harness.yml has problems", "fix them first");
    if (isDeepStrictEqual(h.saved, h.working)) return;
    const repo = this.#open();
    const convo = await this.#handle(repo, repo.trunk);
    await convo.saveConfig((text) => withValue(text, h.saved, h.working), commitMessage);
    // Providers are built when a thread is opened: threads opened before this change begin again with the file as it is now.
    for (const [name, handle] of [...this.#handles]) {
      if (this.#runs.has(name)) continue;
      this.#handles.delete(name);
      await handle.close();
    }
    // The person has just read the whole file in the sheet and saved it: it is approved on the thread it was saved on.
    await (await this.#handle(repo, repo.trunk)).approveConfig();
    await this.#chooseFirstModel(repo);
    this.#harness = { ...h, saved: h.working };
    this.#emit({ type: "form.set", form: this.#harnessForm() });
    this.#notify("harness.yml saved and committed");
    await this.#sendGraph();
    if (this.#selected !== undefined && !this.#runs.has(this.#selected)) await this.#openChat(this.#selected);
  }

  /**
   * A conversation started without a provider has no model; the first provider that is added gives it one, as `init` would have: the
   * provider's usual model, with its prices pinned. New threads start from the trunk's setup, so they have it too.
   */
  async #chooseFirstModel(repo: Repo): Promise<void> {
    const trunk = await this.#handle(repo, repo.trunk);
    if ((await trunk.setup()).model !== undefined) return;
    const cfg = await trunk.readConfig();
    if (cfg === undefined || !cfg.ok) return;
    const [name, config] = Object.entries(cfg.value.providers)[0] ?? [];
    const def = config === undefined ? undefined : this.#providers().get(config.$tag);
    if (name === undefined || config === undefined || def === undefined) return;
    const id = DEFAULT_MODEL[config.$tag] ?? Object.keys(def.models?.(config) ?? {})[0];
    if (id === undefined) {
      this.#notify(`Choose a model for ${name}: it has none that is usual`, "warning");
      return;
    }
    await trunk.setupChange({ model: { provider: name, id, settings: { max_output_tokens: 8192 } } });
    await trunk.pinPricing().catch(() => undefined);
  }

  async #checkProvider(name: string, status: boolean): Promise<void> {
    if (this.#harness === undefined) await this.#sendHarness();
    const working = this.#harness?.working ?? {};
    if (status) this.#emit({ type: "provider.status", provider: name, status: { state: "checking" } });
    const r = await checkProvider(name, working, {
      registry: this.#providers(),
      env: this.#o.env.env,
      fetch: this.#o.fetch ?? fetch,
      now: this.#o.env.now,
    });
    if (status) this.#emit({ type: "provider.status", provider: name, status: r.status });
    else this.#emit({ type: "provider.models", provider: name, list: r.list });
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
        else if (intent.view === "config") {
          this.#settingsOpen = true;
          await this.#sendHarness();
        }
        return;
      case "form.edit":
        if (intent.id === MODEL_FORM) await this.#editModel(intent.value);
        else await this.#editHarness(intent.id, intent.value);
        return;
      case "form.save":
        if (intent.id === MODEL_FORM) await this.#saveModel();
        else await this.#saveHarness(intent.id, intent.message ?? "");
        return;
      case "form.revert":
        if (intent.id === MODEL_FORM) await this.#revertModel();
        else await this.#sendHarness(true, intent.id);
        return;
      case "chat.model":
        await this.#chooseModel(intent.model);
        return;
      case "instructions.add":
      case "instructions.enable":
      case "instructions.remove":
        await this.#changeInstructions(intent);
        return;
      case "provider.test":
      case "provider.models":
        await this.#checkProvider(intent.provider, intent.type === "provider.test");
        return;
      case "thread.open":
        await this.#openChat(intent.thread, intent.commit);
        return;
      case "repo.init":
        await this.#initRepo(intent.id);
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
        await this.#approve(intent.callId, intent.allow);
        return;
      case "chat.resume":
        await this.#resume();
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
        await this.#fork(intent.thread, intent.commit, intent.name, intent.before === true);
        return;
      case "thread.rewind":
        await this.#rewind(intent.thread, intent.commit, intent.before === true);
        return;
      case "thread.accept":
        await this.#accept(intent.thread);
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
    }
  }
}
