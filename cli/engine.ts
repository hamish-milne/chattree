import type { Conversation } from "../harness/conversation.ts";
import type { ChangeKind } from "../harness/entries.ts";
import { CliError, type Io } from "./io.ts";
import type { OpenedThread, Project } from "./project.ts";
import type { Output, Thinking } from "./output.ts";
import { parseCommand, Registry, tokenize } from "./registry.ts";
import { defaultCommands } from "./commands/index.ts";
import type { Session, SessionStore } from "./session.ts";
import { buildToolSet, makeApprover, type ToolSet } from "./toolset.ts";
import type { Approval, ApprovalRequest } from "../harness/loop.ts";

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

export interface SessionState {
  draft: string;
  /** Messages written ahead in the editor (`/draft [name]`), sent one at a time with `/send`. */
  drafts: NamedDraft[];
  attachments: StagedAttachment[];
  thinking: Thinking;
  /** What the user has entered, oldest first (for the up arrow). */
  history: string[];
}

export const emptyState = (): SessionState => ({ draft: "", drafts: [], attachments: [], thinking: "off", history: [] });

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
  ask?: (question: string, fallback?: string) => Promise<string>;
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
  ask: ((question: string, fallback?: string) => Promise<string>) | undefined;
  /** Things that happened while the user was not looking (a background job ended), shown before the next prompt. */
  notices: string[] = [];
  /** Called when `notices` gained something while idle. */
  onNotice: (() => void) | undefined;
  /** Called when a background job ended while idle and `background.resume` is on: the host should run `resume()`. */
  onResume: (() => void) | undefined;
  readonly #toolsets = new WeakMap<Conversation, Promise<ToolSet>>();
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
    this.ask = o.ask ?? o.io.ask?.bind(o.io);
  }

  /** The tools for the current thread (built once from harness.yml), or undefined when this session has none. */
  toolset(): Promise<ToolSet> | undefined {
    if (!this.tools) return undefined;
    const convo = this.convo;
    let p = this.#toolsets.get(convo);
    if (p === undefined) {
      p = buildToolSet(this.io, convo, {
        busy: () => this.running,
        onCommitted: (events) => {
          for (const e of events) this.notices.push(`background job ${e.job} ${e.status}: ${e.summary}; your next message will report the result`);
          this.onNotice?.();
        },
        onResume: () => this.onResume?.(),
      });
      this.#toolsets.set(convo, p);
      this.#sets.push(p);
    }
    return p;
  }

  /** Pin the session's tools to the agent (once, and again if they change) before a message is sent, so a first message is not split from its reply by a setup entry. */
  async prepareTools(): Promise<void> {
    const set = await this.toolset();
    if (set === undefined) return;
    try {
      const { syncTools } = await import("../harness/loop.ts");
      await syncTools(this.convo, set.registry);
    } catch {
      /* the request reports what is wrong with the setup */
    }
  }

  /** Stop the background jobs of this session and record how they ended (the process is leaving). */
  async stopJobs(): Promise<void> {
    for (const p of this.#sets) await (await p).jobs.shutdown();
  }

  /** Asks the user about a tool call, or undefined when nobody can be asked (the call is then declined unless a grant covers it). */
  approver(): ((request: ApprovalRequest) => Promise<Approval>) | undefined {
    const ask = this.ask;
    return ask === undefined ? undefined : makeApprover(ask);
  }

  /** Send a request without a new user message, so the model can react to what happened (a job's event). */
  async *resume(): AsyncGenerator<Output, void> {
    if (this.running) return;
    const { runTurn } = await import("./turn.ts");
    yield* runTurn(this.ctx);
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
    this.convo = opened.convo;
    this.thread = opened.thread;
    this.degraded = opened.degraded;
    this.session?.point(opened.thread);
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
      args = cmd.name === "say" ? [] : tokenize(rest);
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
