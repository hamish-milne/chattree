import type { Conversation } from "../harness/conversation.ts";
import { localOwner } from "./owner.ts";
import type { ChangeKind } from "../harness/entries.ts";
import { CliError, type Io } from "./io.ts";
import type { OpenedThread, Project } from "./project.ts";
import { plainStyle, type Output, type Style, type Thinking, type ToolView } from "./output.ts";
import { parseCommand, Registry, tokenize } from "./registry.ts";
import { defaultCommands } from "./commands/index.ts";
import type { Session, SessionStore } from "./session.ts";
import { summarizeCall } from "./tool-lines.ts";
import { createFork } from "./commands/threads.ts";
import { buildToolSet, makeApprover, type ToolSet } from "./toolset.ts";
import { syncTools, toolDrift, type Approval, type LoopEvent } from "../harness/loop.ts";
import { Pump, type Question } from "../harness/pump.ts";
import type { RunOptions } from "../harness/runs.ts";
import { deliverSubagents, subagentChildRegistry, subagentGrants, subagentNudge } from "../harness/subagent.ts";
import type { ChatEntry } from "../harness/entries.ts";
import { deliverForks } from "../harness/fork-tools.ts";
import { openThread } from "./project.ts";

/** A file staged for the next prompt. Only the path and what was decided about it are kept; the blob is made when the prompt is sent. */
export interface StagedAttachment {
  path: string;
  name: string;
  mime: string;
  charset?: string;
  size: number;
  mtimeMs: number;
}

/** What a session holds that is not in the transcript (docs/cli.md, section 3). Persisted by the session store. */
export interface NamedDraft {
  name: string;
  text: string;
}

/** One answer to a question: the key that names it (what comes back), and what it means. */
export interface Choice {
  key: string;
  label: string;
}
/** A question for the user. With `choices` a terminal can offer a selection; the answer is the chosen key (or what was typed). */
export type AskFn = (question: string, fallback?: string, choices?: readonly Choice[]) => Promise<string>;
export const choiceMenu = (choices: readonly Choice[]): string => choices.map((c) => `[${c.key}] ${c.label}`).join("  ");

export interface SessionState {
  draft: string;
  /** Messages written ahead in the editor (`/draft [name]`), sent one at a time with `/send`. */
  drafts: NamedDraft[];
  attachments: StagedAttachment[];
  thinking: Thinking;
  /** How much of tool calls and results is shown (`/display tools`). */
  tools: ToolView;
  /** What the user has entered, oldest first (for the up arrow). */
  history: string[];
}

export const emptyState = (): SessionState => ({ draft: "", drafts: [], attachments: [], thinking: "off", tools: "brief", history: [] });

/** Nothing waiting to be sent: a session in this state is not worth keeping. (Preferences and history alone are not.) */
export const hasPendingState = (s: SessionState): boolean => s.draft.trim() !== "" || s.drafts.length > 0 || s.attachments.length > 0;

export interface Ctx {
  engine: Engine;
  io: Io;
  convo: Conversation;
  state: SessionState;
  confirm(question: string): Promise<boolean>;
}

export interface EngineOptions {
  io: Io;
  project: Project;
  opened: OpenedThread;
  /** The harness's own prompt, the first part of every request. */
  system?: string;
  /** Asked before a change the library classified is allowed. Default: no. */
  confirm?: (question: string) => Promise<boolean>;
  /** The stored session this engine runs in, if any: its state is the engine's state, and it is saved after every line. */
  session?: Session;
  sessions?: SessionStore;
  /** Give the model the starter tools and a tool loop (a chat session does; the one-shot verbs do not). Default false. */
  tools?: boolean;
  /** Asks the user a question (the terminal's own prompt, for approvals). Default: `io.ask`. */
  ask?: AskFn;
  /** No screen: the pump runs this thread too (`chattree run`), with its background jobs, instead of leaving it to a terminal. */
  headless?: boolean;
}

export const DEFAULT_SYSTEM = "You are a helpful assistant. The conversation is stored in a git repository; be concise and say plainly when you are unsure.";

/**
 * The session engine: one thread, the state a session keeps, and the commands. `submit(line)` takes what the user entered
 * (a slash command, or text to say) and yields what happened; it knows nothing about terminals.
 */
export class Engine {
  readonly io: Io;
  readonly project: Project;
  readonly registry: Registry;
  readonly system: string;
  readonly session: Session | undefined;
  readonly sessions: SessionStore | undefined;
  state: SessionState;
  convo: Conversation;
  thread: string;
  degraded: string | undefined;
  /** A request started by this engine is in flight. */
  running = false;
  /** Cancels it. */
  abort: AbortController | undefined;
  /** Change kinds the user accepted for the rest of the session (`/accept`). */
  standing: ChangeKind[] = [];
  quit = false;
  /** Set by the terminal layer: runs `fn` with the terminal handed over (to an editor), then takes it back. */
  suspend: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;
  /** Called after the session is pointed at another thread (the terminal layer re-watches it). */
  onRebind: (() => void) | undefined;
  readonly #confirm: (q: string) => Promise<boolean>;
  /** The model has tools and a loop in this session. */
  readonly tools: boolean;
  /** How questions reach the user (approvals); the terminal layer replaces it with its own prompt. */
  ask: AskFn | undefined;
  /** Things that happened while the user was not looking (a background job ended), shown before the next prompt. */
  notices: string[] = [];
  /** Put text on the prompt line to be edited (the terminal layer sets it; there is no such line in plain mode). */
  prefill: ((text: string) => void) | undefined;
  /** How this session's text is coloured (the terminal layer sets it; plain elsewhere). */
  style: Style = plainStyle;
  /** The width of the terminal, or undefined when output is not a terminal. */
  width(): number | undefined {
    return this.io.tty?.output.columns;
  }
  /** The height of the terminal, or undefined when output is not a terminal. */
  rows(): number | undefined {
    return this.io.tty?.output.rows;
  }
  /** Where a line about what a subagent is doing goes (the terminal layer shows it above the prompt); undefined drops it. */
  childLine: ((text: string) => void) | undefined;
  /** What the last command printed beyond one screen: `/more` shows the next page of it. */
  more = "";
  /** Called when `notices` gained something while idle. */
  onNotice: (() => void) | undefined;
  /** Called when a background job ended while idle and `background.resume` is on: the host should run `resume()`. */
  onResume: (() => void) | undefined;
  /** Called when the questions waiting for the user changed (the terminal asks them when it is idle). */
  onQuestion: (() => void) | undefined;
  readonly #toolsets = new WeakMap<Conversation, Promise<ToolSet>>();
  /** The user pressed Ctrl-C at the question being asked: the answer is no, and nothing carries on afterwards (the terminal sets it). */
  escaped = false;
  /** A message is being put in the transcript and its turn is about to start: the pump must not start one too. */
  sending = false;
  #stopNext = false;
  /** The turn that just ended went as far as it could (the model answered, it waited for a question or another thread); false when it was stopped, refused or failed. */
  cleanTurn = false;
  /** Threads this session has looked at after a turn: a message already waiting on one that has not been looked at is not sent unasked (a refused or abandoned send). */
  readonly #seen = new Map<string, string | undefined>();
  readonly #headless: boolean;
  #unfollow: (() => void) | undefined;
  #pump: Pump | undefined;
  #asking = false;
  #wanted = false;
  readonly #sets: Promise<ToolSet>[] = [];

  constructor(o: EngineOptions) {
    this.io = o.io;
    this.project = o.project;
    this.convo = o.opened.convo;
    this.thread = o.opened.thread;
    this.degraded = o.opened.degraded;
    this.system = o.system ?? DEFAULT_SYSTEM;
    this.session = o.session;
    this.sessions = o.sessions;
    this.state = o.session?.state ?? emptyState();
    this.registry = new Registry(defaultCommands());
    this.#confirm = o.confirm ?? (async () => false);
    this.tools = o.tools === true;
    this.#headless = o.headless === true;
    // Without a terminal prompt of our own, choices become a line of text ("[y] yes  [n] no") and the answer is typed.
    const plain = o.io.ask?.bind(o.io);
    this.ask = o.ask ?? (plain === undefined ? undefined : (q, fallback, choices) => plain(choices === undefined ? q : `${q}\n  ${choiceMenu(choices)}\n>`, fallback));
  }

  /** The tools for the current thread (built once from harness.yml), or undefined when this session has none. */
  toolset(): Promise<ToolSet> | undefined {
    if (!this.tools) return undefined;
    const convo = this.convo;
    let p = this.#toolsets.get(convo);
    if (p === undefined) {
      p = buildToolSet(this.io, convo, {
        busy: () => this.running,
        ...(this.sessionId === undefined ? {} : { session: this.sessionId }),
        onCommitted: (events) => {
          for (const e of events) this.notices.push(`background job ${e.job} ${e.status}: ${e.summary}; your next message will report the result`);
          this.onNotice?.();
        },
        onResume: () => this.#wantResume(),
        createFork: (name) => createFork(this.io, this.project, convo, name),
        onForkDraft: (branch, message) => {
          const name = `fork-${branch.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
          this.state.drafts = [...this.state.drafts.filter((d) => d.name !== name), { name, text: message }];
          this.notices.push(`the model started ${branch} and left a first message for it as draft ${name}; /thread ${branch}, then /send ${name}`);
          this.onNotice?.();
        },
        pumped: true,
      });
      // A set that could not be built (no busybox) is built again next time, once the user has dealt with it.
      p.catch(() => {
        if (this.#toolsets.get(convo) === p) this.#toolsets.delete(convo);
        const i = this.#sets.indexOf(p as Promise<ToolSet>);
        if (i >= 0) this.#sets.splice(i, 1);
      });
      this.#toolsets.set(convo, p);
      this.#sets.push(p);
    }
    return p;
  }

  /** The pump for this project (docs/tools.md, 5.4): subagents' loops run in it, and the questions of every thread it looks at wait in it. */
  pump(): Pump | undefined {
    if (!this.tools) return undefined;
    if (this.#pump === undefined) {
      this.#pump = new Pump({
        open: (branch) => (branch === this.thread ? Promise.resolve(this.convo) : openThread(this.io, this.project, branch).then((o) => o.convo)),
        threads: async () => {
          const merged = await this.convo.mergedBranches();
          return (await this.convo.listBranches()).filter((b) => !b.archived && !merged.has(b.name)).map((b) => b.name);
        },
        loop: (convo) => this.#loopFor(convo),
        resume: async () => (await this.toolset())?.resume === true,
        idle: subagentNudge,
        deliver: async (convo) => (await deliverSubagents(convo)) + (await deliverForks(convo)),
        leave: (convo) => !this.#headless && convo.branch === this.thread,
        onWanted: (branch, at) => {
          if (branch !== this.thread || this.running || this.sending) return;
          // What was owed when this session opened is the user's to send (`/retry`); only what arrives or is answered afterwards runs by itself.
          if (!this.#seen.has(branch)) this.#seen.set(branch, at);
          if (this.#seen.get(branch) === at) return;
          this.#wantResume();
        },
        onEvent: (branch, e) => this.#childEvent(branch, e),
        onEnd: (branch, end) => {
          const status = end.result?.status;
          const why = end.error !== undefined ? `failed: ${end.error instanceof Error ? end.error.message : String(end.error)}` : status === "stopped" || status === "deadline" || status === "interrupted" || status === "cancelled" ? status : undefined;
          if (why !== undefined) this.childLine?.(`  ↳ ${branch}: ${why}\n`);
        },
        onQuestions: () => this.onQuestion?.(),
      });
    }
    return this.#pump;
  }

  /** What the pump needs to look at a thread and run it: the current thread's own tools, or a subagent's. Other threads are left alone. */
  async #loopFor(convo: Conversation): Promise<RunOptions | undefined> {
    const entries: ChatEntry[] = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const start = entries.findLast((e) => e.$tag === "branch_start" && e.context === "fresh");
    const sub = start?.$tag === "branch_start" && start.kind === "subagent";
    const set = await this.toolset();
    if (set === undefined) return undefined;
    const owner = localOwner(this.sessionId);
    if (convo.branch !== this.thread && !sub) {
      // A thread the user is not on: run it only if its pinned tools are exactly the ones this session would give a child (a fork that works by itself).
      const d = await toolDrift(convo, set.childRegistry);
      if (d.missing.length + d.changed.length + d.extra.length > 0) return undefined;
      return { system: this.system, registry: set.childRegistry, grants: convo.grantStore(), owner, standing: this.standing };
    }
    if (!sub) {
      // No screen to pin the tools before a message is sent, so it is done here; a failure shows when the loop runs and is held.
      if (this.#headless) {
        // Another session may append at the same moment; one more try settles that. What still fails shows when the loop runs and is held.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await syncTools(convo, set.registry);
            break;
          } catch (e) {
            if (attempt === 2) this.childLine?.(`  ↳ ${convo.branch}: could not pin the tools: ${e instanceof Error ? e.message : String(e)}\n`);
            else await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }
      }
      return { system: this.system, registry: set.registry, grants: convo.grantStore(), owner, ...(this.#headless ? { jobs: set.jobs, standing: this.standing } : {}) };
    }
    return { system: this.system, registry: subagentChildRegistry(set.childRegistry), grants: subagentGrants(convo.grantStore(), set.merge), owner, standing: this.standing };
  }

  #childEvent(name: string, e: LoopEvent): void {
    if (e.type === "tool.start") this.childLine?.(`  ↳ ${name}: ${summarizeCall(e.name, e.args).split("\n")[0]}\n`);
    else if (e.type === "tool.result" && e.is_error) this.childLine?.(`  ↳ ${name}: failed: ${e.content.split("\n")[0]?.slice(0, 120)}\n`);
  }

  /** Show what a run the pump has on this thread is doing, from its start so far. False when nothing is running there. */
  followRun(branch: string): boolean {
    this.#unfollow?.();
    this.#unfollow = undefined;
    const run = this.#pump?.runs.get(branch);
    if (run?.state !== "running") return false;
    this.#unfollow = run.subscribe((e) => this.#childEvent(branch, e), { replay: true });
    return true;
  }

  /** The thread should run a request now (a job ended, a report arrived, an answer was recorded). Asked once until it has: two sources that notice the same thing start one turn. */
  #wantResume(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.onResume?.();
  }

  /** The questions waiting, from every thread the pump looks at. */
  questions(): Question[] {
    return this.#pump?.questions() ?? [];
  }

  /**
   * Ask the user the questions that are waiting, one at a time, each labelled with its thread when it is not this one, and record each
   * answer (which is what lets that thread's loop go on). Returns when none are left or nobody can be asked.
   */
  async drainQuestions(): Promise<void> {
    const pump = this.#pump;
    if (pump === undefined || this.#asking) return;
    this.#asking = true;
    try {
      for (let guard = 0; guard < 100; guard++) {
        const ask = this.ask;
        const q = pump.questions()[0];
        if (q === undefined || this.quit) return;
        const label = q.branch === this.thread ? undefined : q.branch;
        // With nobody to ask (a pipe) the call is declined, as it always was, and the model is told why.
        const decision: Approval = ask === undefined ? { allow: false, reason: "no one was available to approve this call, so it did not run" } : await makeApprover(ask, label)({ name: q.name, args: q.args, keys: q.keys });
        const stopped = this.escaped;
        this.escaped = false;
        // Stopping at a question ends the turn it belongs to: the call is declined, and the thread does not go on to ask the model.
        if (stopped) {
          if (q.branch === this.thread) this.#stopNext = true;
          else pump.hold(q.branch, "stopped at a question");
        }
        const r = await pump.answer(q.branch, q.callId, decision);
        if (r.status === "recorded" && r.grantError !== undefined) this.notices.push(`the call was allowed once, but the grant was not saved: ${r.grantError}`);
        else if (r.status !== "recorded") this.notices.push(`${q.branch}: that question was already answered elsewhere`);
      }
    } finally {
      this.#asking = false;
      this.onNotice?.();
    }
  }

  /**
   * For a host with no terminal (a pipe): run subagents until they are done, decline the questions nobody can be asked, and carry on with
   * this thread when it can, handing the output of those turns to `render`.
   */
  async settleWithoutTerminal(render: (o: Output) => Promise<void>): Promise<void> {
    const pump = this.pump();
    if (pump === undefined) return;
    for (let round = 0; round < 50; round++) {
      await pump.tick();
      await pump.settle();
      await this.drainQuestions();
      await pump.tick();
      await pump.settle();
      if (!this.#wanted) return;
      for await (const o of this.resume()) await render(o);
    }
  }

  /** True once after the user stopped at a question: the next turn answers what is owed and goes no further. */
  takeStopNext(): boolean {
    const v = this.#stopNext;
    this.#stopNext = false;
    return v;
  }

  /** The turn ended: other threads may need looking at (a child to run, a question to ask). */
  turnEnded(): void {
    this.#seen.set(this.thread, undefined);
    // A turn that was stopped, refused or failed is not started again by the pump just because the thread is still owed a request.
    if (!this.cleanTurn) this.#pump?.hold(this.thread, "the last turn did not finish; send a message or /retry");
    void this.#pump?.tick().catch(() => undefined);
  }

  /** Pin the session's tools to the agent (once, and again if they change) before a message is sent, so a first message is not split from its reply by a setup entry. */
  async prepareTools(): Promise<void> {
    const set = await this.toolset(); // a tool set that cannot be built is the user's to fix: this throws
    if (set === undefined) return;
    try {
      const { syncTools } = await import("../harness/loop.ts");
      await syncTools(this.convo, set.registry);
    } catch {
      /* the request reports what is wrong with the setup */
    }
  }

  /** One line for between turns: thread, model, what the thread has cost, and background jobs that are running. */
  async statusLine(): Promise<string> {
    const parts: string[] = [this.thread];
    try {
      const setup = await this.convo.setup();
      if (setup.model !== undefined) parts.push(setup.model.resolved ?? setup.model.id);
      const l = await this.convo.ledger();
      parts.push(`$${l.conversation.usd.toFixed(2)}${l.conversation.unpriced > 0 ? "+" : ""}`);
    } catch {
      /* a status line is a convenience: say what is known */
    }
    let running = 0;
    for (const p of this.#sets) running += (await p.catch(() => undefined))?.jobs.list().filter((j) => j.status === "running").length ?? 0;
    if (running > 0) parts.push(`${running} job${running === 1 ? "" : "s"} running`);
    if (this.state.attachments.length > 0) parts.push(`${this.state.attachments.length} file${this.state.attachments.length === 1 ? "" : "s"} staged`);
    if (this.state.drafts.length > 0) parts.push(`${this.state.drafts.length} draft${this.state.drafts.length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  /** Stop the background jobs of this session and record how they ended (the process is leaving). */
  async stopJobs(): Promise<void> {
    for (const p of this.#sets) {
      const set = await p;
      set.runs.closeAll();
      await set.jobs.shutdown();
    }
    await this.#pump?.close();
  }

  /** Send a request without a new user message, so the model can react to what happened (a job's event). */
  async *resume(): AsyncGenerator<Output, void> {
    this.#wanted = false;
    if (this.running) return;
    const { runTurn } = await import("./turn.ts");
    yield* runTurn(this.ctx);
  }

  /** Run a program with the terminal handed over to it, as for the editor. */
  async exec(stage: readonly string[], cwd: string): Promise<number> {
    const exec = this.io.exec;
    if (exec === undefined) throw new CliError("there is no terminal to run a program in", "run `chattree chat` in a terminal");
    const run = (): Promise<number> => exec.call(this.io, stage, cwd);
    return this.suspend === undefined ? run() : this.suspend(run);
  }

  /** Open a file in the user's editor, with the terminal handed over for the duration. */
  async edit(path: string): Promise<boolean> {
    const edit = this.io.edit;
    if (edit === undefined) throw new CliError("there is no editor here", "run `chattree chat` in a terminal, or edit the file yourself");
    const run = (): Promise<boolean> => edit.call(this.io, path);
    return this.suspend === undefined ? run() : this.suspend(run);
  }

  get sessionId(): string | undefined {
    return this.session?.id;
  }

  /** Point the session at another thread. Draft, staged files and preferences stay. */
  rebind(opened: OpenedThread): void {
    const left = this.thread;
    this.#unfollow?.();
    this.#unfollow = undefined;
    this.convo = opened.convo;
    this.thread = opened.thread;
    this.degraded = opened.degraded;
    this.session?.point(opened.thread);
    // The pump kept handles for these threads; the one we left was ours, the one we arrived at is now ours.
    if (this.#pump !== undefined) {
      void this.#pump.forget(left, { keep: true });
      void this.#pump.forget(opened.thread, { except: opened.convo }).then(() => this.#pump?.tick().catch(() => undefined));
    }
    this.onRebind?.();
  }

  get ctx(): Ctx {
    return { engine: this, io: this.io, convo: this.convo, state: this.state, confirm: this.#confirm };
  }

  async *submit(line: string): AsyncGenerator<Output, void> {
    try {
      yield* this.#submit(line);
    } finally {
      this.session?.touch();
    }
  }

  async *#submit(line: string): AsyncGenerator<Output, void> {
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === "") return;
    const parsed = parseCommand(trimmed);
    const name = parsed?.name ?? "say";
    const rest = parsed === undefined ? (trimmed.startsWith("//") ? trimmed.slice(1) : trimmed) : parsed.rest;
    const cmd = this.registry.find(name);
    if (cmd === undefined) {
      yield { type: "error", message: `there is no command /${name}`, hint: "see /help; to say text that starts with a slash, use /say /text" };
      return;
    }
    if (cmd.busy === "blocked") {
      const reason = await this.busyReason();
      if (reason !== undefined) {
        yield { type: "error", message: `/${cmd.name} is not available: ${reason}`, hint: "wait for it to finish, or /abort" };
        return;
      }
    }
    let args: string[] = [];
    try {
      args = cmd.name === "say" ? [] : tokenize(rest, { escapes: this.io.host.platform !== "windows" });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }
    yield* cmd.run(this.ctx, args, rest);
  }

  async busyReason(): Promise<string | undefined> {
    if (this.running) return "a request is running in this session";
    const a = await this.convo.activity();
    if (a.state === "request" && a.live) {
      const who = a.owner?.session !== undefined ? `session ${a.owner.session}` : a.owner?.pid !== undefined ? `process ${a.owner.pid}` : "another process";
      return `a request to ${a.model} is running on this thread (${who})`;
    }
    return undefined;
  }
}
