/**
 * A stand-in for the real controller, for the browser preview and the tests: it answers every intent with the events
 * the real one would send, from fixture data, and plays a scripted turn when a message is sent (reasoning and text
 * streaming, a tool call that waits for approval, a failing test run, a reply). The views cannot tell it from the real
 * thing, which is the point: the look and the feel can be judged before the harness is wired in.
 *
 * Time comes from an injected `sleep`, so a test runs a whole turn at once and reads the events afterwards.
 */
import type { ChatState, StatusBar } from "../model/chat.ts";
import type { GraphCommit, GraphData, GraphKind, RepoEntry, ThreadStatus } from "../model/graph.ts";
import type { FormSpec } from "../model/form.ts";
import type { UiEvent, UiIntent } from "../model/protocol.ts";
import type { Block } from "../model/transcript.ts";
import { canDragThread, canDropOn } from "../model/graph-actions.ts";
import { chatFixture } from "./chat.ts";
import { configFixture } from "./config.ts";
import { THREADS, docsGraphFixture, graphFixture } from "./graph.ts";
import { validateMock } from "./mock-validate.ts";

type Json = Record<string, unknown>;
type ToolBlock = Extract<Block, { type: "tool" }>;

export interface MockOptions {
  emit: (event: UiEvent) => void;
  /** Wait this many milliseconds. Default: really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const strip = (s: string): string => s.replace(/^(user|assistant): /, "").replace(/^tool result: /, "");
const words = (s: string): string[] => s.match(/\S+\s*/g) ?? [];
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The repositories of the pretend workspace: two conversations, and two that cannot be opened. */
const REPOS: RepoEntry[] = [
  { id: "retry-client", name: "retry-client", path: "~/work/retry-client", chattree: true },
  { id: "docs-site", name: "docs-site", path: "~/work/docs-site", chattree: true },
  {
    id: "legacy-api",
    name: "legacy-api",
    path: "~/work/legacy-api",
    chattree: false,
    reason: "not a chattree repository (no conversation found)",
  },
  {
    id: "vendor-lib",
    name: "vendor-lib",
    path: "~/work/vendor/lib",
    chattree: false,
    reason: "made by an older chattree (format 0), which this version cannot open",
  },
];

export class MockController {
  private readonly emit: (e: UiEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private graph: GraphData = graphFixture();
  private chats = new Map<string, ChatState>();
  private repoId = "retry-client";
  /** What each repository was left as, for when the person comes back to it. */
  private readonly stored = new Map<string, { graph: GraphData; chats: Map<string, ChatState>; current: string }>();
  private current: string = THREADS.main;
  private readonly forms = new Map<string, { saved: FormSpec; working: FormSpec }>();
  private seq = 0;
  private turn: Promise<void> | undefined;
  private aborted = false;
  private answer: ((allow: boolean) => void) | undefined;
  private readonly queue: { thread: string; block: string; text: string }[] = [];

  constructor(options: MockOptions) {
    this.emit = options.emit;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const settings = chatFixture().settings;
    for (const f of [configFixture(), ...(settings === undefined ? [] : [settings])]) this.forms.set(f.id, { saved: f, working: f });
  }

  /** Resolves when no turn is running and nothing is queued. */
  async idle(): Promise<void> {
    while (this.turn !== undefined) await this.turn;
  }

  /** Handle what a view sent. Anything that takes time (a turn) carries on after this returns. */
  handle(intent: UiIntent): void {
    switch (intent.type) {
      case "ready":
        if (intent.view === "graph") {
          this.emit({ type: "graph.repos", repos: { repos: REPOS, current: this.repoId } });
          this.emit({ type: "graph.data", data: this.graph });
          this.emit({ type: "graph.selected", thread: this.current });
        } else if (intent.view === "chat") this.emit({ type: "chat.open", state: this.chat(this.current) });
        else this.emit({ type: "form.set", form: this.form("harness").working });
        return;
      case "repo.select":
        this.selectRepo(intent.id);
        return;
      case "commit.copy":
        this.notify("info", `Copied ${intent.commit.slice(0, 7)} to the clipboard`);
        return;
      case "thread.delete":
        this.deleteThread(intent.thread);
        return;
      case "thread.open":
        this.open(intent.thread, intent.commit);
        return;
      case "thread.fork":
        this.fork(intent.thread, intent.commit, intent.name);
        return;
      case "thread.rewind":
        this.rewind(intent.thread, intent.commit);
        return;
      case "thread.merge":
        this.merge(intent.from, intent.into);
        return;
      case "chat.send":
        this.send(intent.text);
        return;
      case "chat.stop":
        this.aborted = true;
        this.answer?.(false);
        return;
      case "chat.draft":
        this.chat(this.current).composer.draft = intent.text;
        return;
      case "chat.attach": {
        const c = this.chat(this.current).composer;
        const n = c.attachments.length;
        c.attachments.push({
          id: `f${++this.seq}`,
          file:
            n % 2 === 0
              ? { name: "error-log.txt", mime: "text/plain", kind: "text", bytes: 4210 }
              : { name: "screenshot.png", mime: "image/png", kind: "image", bytes: 183_000 },
        });
        this.emit({ type: "chat.composer", composer: c });
        return;
      }
      case "chat.detach": {
        const c = this.chat(this.current).composer;
        c.attachments = c.attachments.filter((a) => a.id !== intent.id);
        this.emit({ type: "chat.composer", composer: c });
        return;
      }
      case "chat.approve":
        this.answer?.(intent.allow);
        return;
      case "chat.model":
        this.setModel(intent.model);
        return;
      case "form.edit":
        this.editForm(intent.id, intent.value);
        return;
      case "form.save":
        this.saveForm(intent.id);
        return;
      case "form.revert": {
        const f = this.form(intent.id);
        f.working = f.saved;
        this.emit({ type: "form.set", form: f.working });
        return;
      }
    }
  }

  /** For demos: make a thread look as if it started, stopped or failed (what the real controller learns from the harness). */
  setThreadStatus(thread: string, state: ThreadStatus): void {
    this.setStatus(thread, state);
  }

  // ---- state ---------------------------------------------------------------------------------------------------

  private form(id: string): { saved: FormSpec; working: FormSpec } {
    const f = this.forms.get(id);
    if (f === undefined) throw new Error(`no form ${id}`);
    return f;
  }

  private thread(name: string): GraphData["threads"][number] {
    const t = this.graph.threads.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no thread ${name}`);
    return t;
  }

  /** The chat state of a thread, made on first use: the rich fixture for main, a reading of the graph for the rest. */
  private chat(name: string): ChatState {
    const have = this.chats.get(name);
    if (have !== undefined) return have;
    const t = this.thread(name);
    const base = chatFixture();
    const own = this.graph.commits.filter((c) => c.thread === name);
    let blocks: Block[];
    if (name === THREADS.main) {
      const end = base.blocks.findIndex((b) => b.type === "turn_end");
      blocks = base.blocks.slice(0, end + 1);
    } else blocks = this.blocksOf(name, own);
    const usd = own.reduce((n, c) => n + (c.usd ?? 0), 0);
    const options = base.model.options;
    const state: ChatState = {
      thread: { name, kind: t.kind, ...(t.title === undefined ? {} : { title: t.title }), tip: t.tip },
      blocks,
      status: this.statusOf(t.status, t.model ?? "Claude Sonnet 5.5", blocks.length, usd),
      composer: { draft: "", attachments: [] },
      model: { current: options.find((o) => o.label === t.model)?.id ?? "anthropic/claude-sonnet-5-5", options },
      ...(base.settings === undefined ? {} : { settings: this.form("model-settings").working }),
    };
    this.chats.set(name, state);
    return state;
  }

  private statusOf(state: ThreadStatus, model: string, blockCount: number, usd: number): StatusBar {
    return {
      state,
      model,
      provider: model.includes("local") ? "local" : model.startsWith("GPT") ? "openai" : "anthropic",
      context: { used: 6000 + blockCount * 1500, limit: 200_000 },
      thinking: "brief",
      ...(usd > 0 ? { usd: Math.round(usd * 1000) / 1000 } : {}),
    };
  }

  /** A reading of a thread's commits as blocks, for the threads the fixture has no transcript for. */
  private blocksOf(name: string, commits: GraphCommit[]): Block[] {
    const model = this.thread(name).model ?? "model";
    const blocks: Block[] = [];
    let waiting: ToolBlock[] = [];
    for (const c of commits) {
      const id = c.hash;
      switch (c.kind) {
        case "branch_start":
          blocks.push({
            type: "notice",
            id,
            commit: c.hash,
            kind: "branch",
            level: "info",
            title: c.summary.startsWith("subagent")
              ? `Subagent: ${strip(c.summary).replace(/^subagent starts: /, "")}`
              : "Forked from the main thread",
          });
          break;
        case "user":
          blocks.push({ type: "user", id, commit: c.hash, text: strip(c.summary), attachments: [] });
          break;
        case "assistant":
          if ((c.toolCalls ?? 0) > 0) {
            waiting = Array.from({ length: c.toolCalls ?? 0 }, (_, i): ToolBlock => {
              const tool = /calls (\w+)/.exec(c.summary)?.[1] ?? "run";
              return {
                type: "tool",
                id: `${id}-${i}`,
                commit: c.hash,
                name: tool,
                summary: `${tool} (call ${i + 1})`,
                args: "{}",
                status: "running",
              };
            });
            blocks.push(...waiting);
          } else blocks.push({ type: "assistant", id, commit: c.hash, markdown: strip(c.summary), model });
          break;
        case "tool_result": {
          const call = waiting.shift();
          if (call !== undefined) {
            const done: ToolBlock = { ...call, commit: c.hash, status: "ok", result: { text: strip(c.summary), truncated: false, ms: 40 } };
            blocks.splice(blocks.indexOf(call), 1, done);
          }
          break;
        }
        case "interrupted":
          blocks.push({
            type: "notice",
            id,
            commit: c.hash,
            kind: "interrupted",
            level: "error",
            title: "Interrupted",
            detail: strip(c.summary),
          });
          break;
        default:
          break;
      }
    }
    return blocks;
  }

  // ---- graph -------------------------------------------------------------------------------------------------

  private commit(
    thread: string,
    kind: GraphKind,
    summary: string,
    more: { parents?: string[]; toolCalls?: number; usd?: number } = {},
  ): string {
    const t = this.thread(thread);
    this.seq++;
    const hash = (0x7a00000 + this.seq * 0x1f3b).toString(16).padStart(7, "0");
    this.graph.commits.push({
      hash,
      parents: more.parents ?? [t.tip],
      thread,
      kind,
      summary,
      time: new Date().toISOString(),
      ...(more.toolCalls === undefined ? {} : { toolCalls: more.toolCalls }),
      ...(more.usd === undefined ? {} : { usd: more.usd }),
    });
    t.tip = hash;
    return hash;
  }

  private publish(thread: string): void {
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    if (thread === this.current) {
      const c = this.chat(thread);
      c.thread = { ...c.thread, tip: this.thread(thread).tip };
      this.emit({ type: "chat.thread", thread: c.thread });
    }
  }

  private setStatus(thread: string, state: ThreadStatus): void {
    this.thread(thread).status = state;
    const c = this.chat(thread);
    c.status = { ...c.status, state };
    this.emit({ type: "graph.status", thread, status: state });
    if (thread === this.current) this.emit({ type: "chat.status", status: c.status });
  }

  private open(thread: string, commit?: string, reload = false): void {
    if (!this.graph.threads.some((t) => t.name === thread)) return;
    const changed = thread !== this.current;
    this.current = thread;
    // Opening the thread that is already open must not reset the chat under the person's hands, unless it changed (`reload`).
    if (changed || reload) this.emit({ type: "chat.open", state: structuredClone(this.chat(thread)) });
    this.emit({ type: "graph.selected", thread, ...(commit === undefined ? {} : { commit }) });
    const target = commit === undefined ? undefined : this.blockCommit(thread, commit);
    if (target !== undefined) this.emit({ type: "chat.reveal", commit: target });
  }

  /** The commit of the block that shows `commit`: itself, or the nearest earlier one that has a block (a fold of tool results has none of its own). */
  private blockCommit(thread: string, commit: string): string | undefined {
    const have = new Set(this.chat(thread).blocks.map((b) => b.commit));
    let h: string | undefined = commit;
    while (h !== undefined) {
      if (have.has(h)) return h;
      const at: string = h;
      h = this.graph.commits.find((c) => c.hash === at)?.parents[0];
    }
    return undefined;
  }

  private notify(level: "info" | "warning" | "error", message: string): void {
    this.emit({ type: "notice", level, message });
  }

  private fork(from: string, at: string, name: string | undefined): void {
    const source = this.chat(from);
    const fork = name ?? `fork-${++this.seq}`;
    if (this.graph.threads.some((t) => t.name === fork)) return this.notify("warning", `a thread named ${fork} already exists`);
    this.graph.threads.push({
      name: fork,
      kind: "fork",
      status: "idle",
      tip: at,
      title: `Fork of ${from}`,
      from: at,
      ...(this.thread(from).model === undefined ? {} : { model: this.thread(from).model }),
    });
    this.commit(fork, "branch_start", "fork starts", { parents: [at] });
    const cut = source.blocks.findLastIndex((b) => b.commit === at);
    const kept = (cut < 0 ? source.blocks : source.blocks.slice(0, cut + 1)).map((b) => structuredClone(b));
    this.chats.set(fork, {
      ...structuredClone(source),
      thread: { name: fork, kind: "fork", title: `Fork of ${from}`, tip: this.thread(fork).tip },
      blocks: [
        ...kept,
        {
          type: "notice",
          id: `fork-${this.seq}`,
          commit: this.thread(fork).tip,
          kind: "branch",
          level: "info",
          title: `Forked from ${from}`,
        },
      ],
      composer: { draft: "", attachments: [] },
    });
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    this.open(fork);
  }

  /**
   * Take a thread back so that `commit` is its tip, keeping the old tip under a ref (the real rewind does the same).
   * Rewinding to one of the person's own messages goes to just before it and puts its text in the composer, as `/undo`
   * does, so it can be edited and sent again.
   */
  private rewind(thread: string, commit: string): void {
    const chat = this.chat(thread);
    const block = chat.blocks.find((b) => b.commit === commit);
    const target = block?.type === "user" ? this.graph.commits.find((c) => c.hash === commit)?.parents[0] : commit;
    const own = this.graph.commits.filter((c) => c.thread === thread);
    const at = own.findIndex((c) => c.hash === target);
    if (target === undefined || at < 0) return this.notify("warning", "that commit cannot be rewound to here");
    const dropped = own.slice(at + 1).map((c) => c.hash);
    if (this.graph.commits.some((c) => !dropped.includes(c.hash) && c.parents.some((p) => dropped.includes(p))))
      return this.notify("warning", "another thread was forked from a later commit, so this cannot be rewound in the mock");
    const old = this.thread(thread).tip;
    this.graph.commits = this.graph.commits.filter((c) => !dropped.includes(c.hash));
    this.thread(thread).tip = target;
    const keep = chat.blocks.findLastIndex((b) => b.commit !== undefined && !dropped.includes(b.commit));
    chat.blocks = chat.blocks.slice(0, keep + 1);
    chat.thread = { ...chat.thread, tip: target };
    chat.composer = { ...chat.composer, draft: block?.type === "user" ? block.text : chat.composer.draft };
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    this.open(thread, undefined, true);
    this.notify("info", `Rewound ${thread}; the old tip ${old.slice(0, 7)} is kept at refs/chattree/rewound/${old.slice(0, 7)}`);
  }

  private selectRepo(id: string): void {
    const repo = REPOS.find((r) => r.id === id);
    if (repo === undefined || id === this.repoId) return;
    if (!repo.chattree) return this.notify("warning", `${repo.name}: ${repo.reason ?? "cannot be opened"}`);
    if (this.turn !== undefined) return this.notify("warning", "A turn is running here; stop it before switching repository");
    this.stored.set(this.repoId, { graph: this.graph, chats: this.chats, current: this.current });
    const next = this.stored.get(id) ?? { graph: docsGraphFixture(), chats: new Map<string, ChatState>(), current: "master" };
    this.repoId = id;
    this.graph = next.graph;
    this.chats = next.chats;
    this.current = next.current;
    this.emit({ type: "graph.repos", repos: { repos: REPOS, current: id } });
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    this.emit({ type: "graph.selected", thread: this.current });
    this.emit({ type: "chat.open", state: structuredClone(this.chat(this.current)) });
  }

  private deleteThread(name: string): void {
    const t = this.graph.threads.find((x) => x.name === name);
    if (t === undefined) return;
    const refused = canDragThread(this.graph, name);
    // The same reasons that stop a merge stop a delete: the trunk, and a thread that is working or held elsewhere.
    if (name === this.graph.trunk) return this.notify("warning", "The trunk cannot be deleted");
    if (!refused.ok && t.merged !== true) return this.notify("warning", `Cannot delete ${name}: ${refused.reason ?? "not allowed"}`);
    this.graph.threads = this.graph.threads.filter((x) => x.name !== name);
    // Commits that no remaining thread can reach are no longer in the graph (git keeps them until garbage collection).
    const parents = new Map(this.graph.commits.map((c) => [c.hash, c.parents]));
    const keep = new Set<string>();
    const todo = this.graph.threads.map((x) => x.tip);
    for (let h = todo.pop(); h !== undefined; h = todo.pop()) {
      if (keep.has(h)) continue;
      keep.add(h);
      todo.push(...(parents.get(h) ?? []));
    }
    this.graph.commits = this.graph.commits.filter((c) => keep.has(c.hash));
    this.chats.delete(name);
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    if (this.current === name) this.open(this.graph.trunk, undefined, true);
    this.notify("info", `Deleted ${name}. Its tip ${t.tip.slice(0, 7)} can be recovered from the reflog until git next collects garbage`);
  }

  private merge(from: string, into: string): void {
    const f = this.thread(from);
    const refused = [canDragThread(this.graph, from), canDropOn(this.graph, from, into)].find((v) => !v.ok);
    if (refused !== undefined) return this.notify("warning", `Cannot merge ${from} into ${into}: ${refused.reason ?? "not allowed"}`);
    this.commit(into, "fork_merge", `fork merged: ${f.title ?? from}`, { parents: [this.thread(into).tip, f.tip] });
    f.merged = true;
    this.emit({ type: "graph.data", data: structuredClone(this.graph) });
    this.notify("info", `Merged ${from} into ${into}`);
  }

  // ---- the chat ------------------------------------------------------------------------------------------------

  private setModel(id: string): void {
    const chat = this.chat(this.current);
    const option = chat.model.options.find((o) => o.id === id);
    if (option === undefined) return;
    chat.model = { ...chat.model, current: id };
    chat.status = { ...chat.status, model: option.label, provider: option.provider };
    const t = this.thread(this.current);
    t.model = option.label;
    const hash = this.commit(this.current, "agent_setup", `setup (model_changed): ${id}`);
    const note: Block = {
      type: "notice",
      id: `m${++this.seq}`,
      commit: hash,
      kind: "setup",
      level: "info",
      title: `Model set to ${option.label}`,
      detail: "The next request uses it. Switching models can break the prompt cache.",
    };
    chat.blocks = [...chat.blocks, note];
    this.emit({ type: "chat.append", blocks: [note] });
    this.emit({ type: "chat.models", models: chat.model });
    this.emit({ type: "chat.status", status: chat.status });
    this.publish(this.current);
  }

  private send(text: string): void {
    const thread = this.current;
    const chat = this.chat(thread);
    const attachments = chat.composer.attachments.map((a) => a.file);
    chat.composer = { draft: "", attachments: [] };
    this.emit({ type: "chat.composer", composer: chat.composer });
    const id = `u${++this.seq}`;
    const queued = this.turn !== undefined;
    const block: Block = { type: "user", id, text, attachments, ...(queued ? { queued: true } : {}) };
    chat.blocks = [...chat.blocks, block];
    this.emit({ type: "chat.append", blocks: [block] });
    if (queued) this.queue.push({ thread, block: id, text });
    else this.start(thread, id, text);
  }

  private start(thread: string, block: string, text: string): void {
    this.aborted = false;
    this.turn = this.runTurn(thread, block, text).finally(() => {
      this.turn = undefined;
      const next = this.queue.shift();
      if (next !== undefined) this.start(next.thread, next.block, next.text);
    });
  }

  private put(thread: string, b: Block, mode: "append" | "update"): void {
    const chat = this.chat(thread);
    chat.blocks = mode === "append" ? [...chat.blocks, b] : chat.blocks.map((x) => (x.id === b.id ? b : x));
    if (thread === this.current) this.emit(mode === "append" ? { type: "chat.append", blocks: [b] } : { type: "chat.update", block: b });
  }

  private async stream(thread: string, id: string, text: string): Promise<boolean> {
    for (const w of words(text)) {
      if (this.aborted) return false;
      await this.sleep(35);
      const chat = this.chat(thread);
      chat.blocks = chat.blocks.map((b) =>
        b.id === id && b.type === "assistant"
          ? { ...b, markdown: b.markdown + w }
          : b.id === id && b.type === "reasoning"
            ? { ...b, text: b.text + w }
            : b,
      );
      if (thread === this.current) this.emit({ type: "chat.delta", id, delta: w });
    }
    return !this.aborted;
  }

  /**
   * The scripted turn: the user's message is committed, the model thinks and says what it will do, calls a tool that
   * needs approval, then runs the tests (which fail), and replies. Stop ends it early with an interruption.
   */
  private async runTurn(thread: string, userBlock: string, text: string): Promise<void> {
    const model = this.thread(thread).model ?? "Claude Sonnet 5.5";
    const chat = this.chat(thread);
    const user = chat.blocks.find((b) => b.id === userBlock);
    if (user?.type === "user") {
      const hash = this.commit(thread, "user", `user: ${text}`);
      this.put(thread, { ...user, commit: hash, ...(user.queued === true ? { queued: false } : {}) }, "update");
      this.publish(thread);
    }
    this.setStatus(thread, "running");
    const n = ++this.seq;
    const interrupted = (): void => {
      const hash = this.commit(thread, "interrupted", "interrupted by user");
      this.put(
        thread,
        {
          type: "notice",
          id: `i${n}`,
          commit: hash,
          kind: "interrupted",
          level: "warning",
          title: "Interrupted",
          detail: "You stopped the request.",
        },
        "append",
      );
      this.setStatus(thread, "idle");
      this.publish(thread);
    };
    const short = text.length > 60 ? `${text.slice(0, 57)}…` : text;

    this.put(thread, { type: "reasoning", id: `r${n}`, text: "", streaming: true }, "append");
    if (
      !(await this.stream(
        thread,
        `r${n}`,
        `The request is "${short}". I should look at the code before changing anything, then run the tests to check the result.`,
      ))
    )
      return interrupted();
    this.put(thread, { type: "reasoning", id: `r${n}`, text: this.textOf(thread, `r${n}`), streaming: false }, "update");

    this.put(thread, { type: "assistant", id: `a${n}`, markdown: "", model, streaming: true }, "append");
    if (!(await this.stream(thread, `a${n}`, "I'll start by editing the client, then run the test suite."))) return interrupted();
    this.put(thread, { type: "assistant", id: `a${n}`, markdown: this.textOf(thread, `a${n}`), model }, "update");

    // A tool call that needs a decision.
    const edit: ToolBlock = {
      type: "tool",
      id: `c${n}a`,
      name: "edit",
      summary: "edit src/http.ts",
      args: JSON.stringify(
        { path: "src/http.ts", version: "e1d90a42", start: 2, end: 2, content: "  const max = init?.retries ?? 5;" },
        null,
        2,
      ),
      status: "pending",
    };
    this.put(thread, edit, "append");
    await this.sleep(400);
    this.put(thread, { ...edit, status: "awaiting_approval" }, "update");
    const approval = { callId: edit.id, name: edit.name, summary: edit.summary, args: edit.args };
    this.setStatus(thread, "awaiting");
    if (thread === this.current) this.emit({ type: "chat.approval", approval });
    const allow = await new Promise<boolean>((resolve) => (this.answer = resolve));
    this.answer = undefined;
    if (thread === this.current) this.emit({ type: "chat.approval" });
    if (this.aborted) {
      this.put(thread, { ...edit, status: "did_not_run" }, "update");
      return interrupted();
    }
    this.setStatus(thread, "running");
    if (!allow) {
      this.put(thread, { ...edit, status: "did_not_run", result: { text: "You declined this call.", truncated: false, ms: 0 } }, "update");
    } else {
      this.put(thread, { ...edit, status: "running" }, "update");
      await this.sleep(600);
      this.put(
        thread,
        {
          ...edit,
          status: "ok",
          result: {
            text: [
              "edited src/http.ts (now 12 lines, version 4c2b8e11)",
              "change 1: replaced lines 2-2 with 1 line; now lines 2-2",
              "- 2\t  const max = init?.retries ?? 3;",
              "  1\texport async function request(url: string, init?: RequestInit): Promise<Response> {",
              "+ 2\t  const max = init?.retries ?? 5;",
              "  3\t  for (let attempt = 0; ; attempt++) {",
            ].join("\n"),
            truncated: false,
            ms: 11,
          },
        },
        "update",
      );
    }
    if (this.aborted) return interrupted();

    const run: ToolBlock = {
      type: "tool",
      id: `c${n}b`,
      name: "run",
      summary: "run npm test",
      args: JSON.stringify({ command: "npm test" }, null, 2),
      status: "running",
    };
    this.put(thread, run, "append");
    await this.sleep(1200);
    if (this.aborted) {
      this.put(thread, { ...run, status: "did_not_run" }, "update");
      return interrupted();
    }
    this.put(
      thread,
      {
        ...run,
        status: "error",
        result: { text: "exit 1\nnot ok 4 - retries a 503\n  expected 5 calls, got 3\n# pass 11\n# fail 1", truncated: false, ms: 1180 },
      },
      "update",
    );

    this.put(thread, { type: "assistant", id: `f${n}`, markdown: "", model, streaming: true }, "append");
    const reply = allow
      ? "One test fails: it still expects the **old retry count**. I changed the code but not the test.\n\n```ts\nexpect(calls).toBe(3); // should be 5\n```\n\nSay the word and I'll update it."
      : "Without the edit, the tests fail the way they did before. I did not change anything.\n\n- The failing test is `retries a 503`.\n- Tell me if you'd rather I change the test instead.";
    if (!(await this.stream(thread, `f${n}`, reply))) return interrupted();
    this.put(thread, { type: "assistant", id: `f${n}`, markdown: this.textOf(thread, `f${n}`), model }, "update");

    const calls = allow ? 2 : 1;
    this.commit(thread, "assistant", "assistant: calls edit", { toolCalls: calls, usd: 0.021 });
    for (let i = 0; i < calls; i++)
      this.commit(thread, "tool_result", i === 0 && allow ? "tool result: edited src/http.ts" : "tool result: 1 failing");
    const last = this.commit(thread, "assistant", `assistant: ${reply.split("\n")[0] ?? ""}`, { usd: 0.018 });
    this.put(
      thread,
      { type: "turn_end", id: `t${n}`, commit: last, usage: { input: 21_300, output: 640, cached: 14_900 }, usd: 0.039, stop: "end_turn" },
      "append",
    );
    const c = this.chat(thread);
    c.status = {
      ...c.status,
      usd: Math.round(((c.status.usd ?? 0) + 0.039) * 1000) / 1000,
      context: {
        used: (c.status.context?.used ?? 0) + 1900,
        ...(c.status.context?.limit === undefined ? {} : { limit: c.status.context.limit }),
      },
    };
    this.setStatus(thread, "idle");
    this.publish(thread);
  }

  private textOf(thread: string, id: string): string {
    const b = this.chat(thread).blocks.find((x) => x.id === id);
    return b?.type === "assistant" ? b.markdown : b?.type === "reasoning" ? b.text : "";
  }

  // ---- forms ---------------------------------------------------------------------------------------------------

  private editForm(id: string, value: Json): void {
    const f = this.form(id);
    const issues = validateMock(f.working.schema, value);
    // A rule across fields, as the real config has: a turn cannot be allowed to cost more than the whole conversation.
    const limits = value["limits"];
    if (
      id === "harness" &&
      typeof limits === "object" &&
      limits !== null &&
      "max_turn_usd" in limits &&
      "max_conversation_usd" in limits &&
      typeof limits.max_turn_usd === "number" &&
      typeof limits.max_conversation_usd === "number" &&
      limits.max_turn_usd > limits.max_conversation_usd
    ) {
      issues.push({ path: "limits.max_turn_usd", message: "is above max_conversation_usd" });
    }
    f.working = { ...f.working, value, issues, dirty: !sameJson(value, f.saved.value) };
    this.emit({ type: "form.set", form: f.working });
  }

  private saveForm(id: string): void {
    const f = this.form(id);
    if (f.working.issues.length > 0) return this.notify("error", `${f.working.title} has problems; fix them first`);
    f.saved = { ...f.working, dirty: false };
    f.working = f.saved;
    this.emit({ type: "form.set", form: f.working });
    if (id === "harness") return this.notify("info", "harness.yml saved and committed");
    // Model settings are part of the conversation: a change is an entry on the thread.
    const chat = this.chat(this.current);
    const hash = this.commit(this.current, "agent_setup", "setup (settings_changed)");
    const note: Block = {
      type: "notice",
      id: `m${++this.seq}`,
      commit: hash,
      kind: "setup",
      level: "info",
      title: "Model settings changed",
      detail: Object.entries(f.working.value)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(", "),
    };
    chat.blocks = [...chat.blocks, note];
    this.emit({ type: "chat.append", blocks: [note] });
    this.publish(this.current);
  }
}
