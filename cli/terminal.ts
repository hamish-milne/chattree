import { emitKeypressEvents, createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { Choice, Engine } from "./engine.ts";
import type { Tty } from "./io.ts";
import { ansiStyle, formatEntry, PlainRenderer, plainStyle, type Style } from "./output.ts";
import { parseCommand } from "./registry.ts";
import { PromptBuffer } from "./prompt.ts";
import { nextDraftName } from "./commands/drafts.ts";

const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The stream readline draws on: while a request is streaming its echo is dropped, and what we write goes straight through. */
class Gate extends Writable {
  muted = false;
  readonly #real: Tty["output"];
  constructor(real: Tty["output"]) {
    super();
    this.#real = real;
    (real as unknown as NodeJS.EventEmitter).on?.("resize", () => this.emit("resize"));
  }
  get columns(): number | undefined {
    return this.#real.columns;
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (!this.muted) this.#real.write(chunk);
    cb();
  }
}

export interface TerminalOptions {
  engine: Engine;
  tty: Tty;
  color?: boolean;
  /** Frame interval; 0 turns the spinner off. Default 100 ms. */
  spinnerMs?: number;
  /** How often other sessions' entries are looked for. Default 500 ms. */
  watchMs?: number;
  /** Two Ctrl-C presses within this long exit. Default 3000 ms. */
  exitWindowMs?: number;
}

/**
 * The terminal layer (docs/cli.md, sections 4 and 6): `readline` for editing and history, with bracketed paste, tab
 * completion, a spinner while a request runs, live display of entries other sessions add, and Ctrl-C. Lines go through
 * `PromptBuffer` and then the engine; blocked commands entered during a request wait for it, so typing ahead works.
 * `run()` resolves when the session ends.
 */
export class Terminal {
  readonly #engine: Engine;
  readonly #tty: Tty;
  readonly #style: Style;
  readonly #gate: Gate;
  readonly #rl: Interface;
  readonly #prompt: PromptBuffer;
  readonly #spinnerMs: number;
  readonly #watchMs: number;
  readonly #exitWindow: number;
  #pasting = false;
  #chain: Promise<void> = Promise.resolve();
  #spin: ReturnType<typeof setInterval> | undefined;
  #spinLabel = "working";
  #spinSince = 0;
  #exitArmed = 0;
  #closing = false;
  /** A selection is open: arrow keys move, Enter chooses, a letter jumps. Lines readline completes meanwhile are not input. */
  #selecting: ((key: { name?: string; ctrl?: boolean }) => void) | undefined;
  #swallowLines = false;
  #watch: AbortController | undefined;
  #done: () => void = () => undefined;
  readonly finished: Promise<void>;

  constructor(o: TerminalOptions) {
    this.#engine = o.engine;
    this.#tty = o.tty;
    this.#style = o.color === false ? plainStyle : ansiStyle;
    this.#spinnerMs = o.spinnerMs ?? 100;
    this.#watchMs = o.watchMs ?? 500;
    this.#exitWindow = o.exitWindowMs ?? 3000;
    this.#prompt = new PromptBuffer(this.#engine.state);
    this.#gate = new Gate(o.tty.output);
    this.finished = new Promise((r) => (this.#done = r));
    emitKeypressEvents(o.tty.input);
    this.#rl = createInterface({
      input: o.tty.input as NodeJS.ReadableStream,
      output: this.#gate,
      terminal: true,
      history: [...this.#engine.state.history].reverse(),
      historySize: 500,
      removeHistoryDuplicates: true,
      prompt: "> ",
      completer: (line: string, cb: (err: Error | null, r: [string[], string]) => void) => {
        this.#complete(line).then((r) => cb(null, r), () => cb(null, [[], line]));
      },
    });
    o.tty.input.on("keypress", this.#onKeypress);
    this.#rl.on("line", (l) => this.#onLine(l));
    this.#rl.on("SIGINT", () => this.#onInterrupt());
    this.#rl.on("close", () => void this.#end(true));
    this.#engine.onRebind = () => this.#startWatch();
    this.#engine.suspend = (fn) => this.#suspend(fn);
    this.#engine.ask = (q, fallback, choices) => (choices === undefined ? this.#ask(q, fallback) : this.#select(q, choices, fallback));
    this.#engine.onNotice = () => this.#flushNotices();
    this.#engine.prefill = (text) => this.#rl.write(text);
    this.#engine.childLine = (text) => this.#emit(this.#style.dim(text));
    this.#engine.onResume = () => {
      this.#chain = this.#chain.then(() => this.#dispatchResume());
    };
  }

  readonly #onKeypress = (_s: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
    if (this.#selecting !== undefined && key !== undefined) {
      this.#selecting(key);
      return;
    }
    if (key?.ctrl === true && key.name === "o" && !this.#pasting) {
      this.#stash();
      return;
    }
    if (key?.name === "paste-start") this.#pasting = true;
    else if (key?.name === "paste-end") this.#pasting = false;
  };

  /** Show the prompt and process input until the session ends. */
  async run(): Promise<void> {
    this.#tty.output.write(BRACKETED_PASTE_ON);
    this.#startWatch();
    this.#tty.output.write(`${this.#style.dim(await this.#engine.statusLine())}\n`);
    this.#showPrompt();
    await this.finished;
  }

  /** Write text above the prompt (or straight out while a request is streaming) and redraw the prompt under it. */
  print(text: string): void {
    this.#stopSpinner();
    if (this.#gate.muted) {
      this.#tty.output.write(text);
      return;
    }
    this.#tty.output.write(`\r\x1b[K${text}`);
    if (!this.#closing) this.#rl.prompt(true);
  }

  /** Leave: stop watching, restore the terminal. Idempotent. */
  async close(): Promise<void> {
    await this.#end(true);
  }

  /**
   * A question from the engine (a tool approval) in the middle of a request: the spinner and the muting step aside, what was
   * half-typed is dropped so it cannot be taken for the answer, and the answer is the next line the user enters.
   */
  async #ask(question: string, fallback?: string): Promise<string> {
    const stop = this.#engine.abort?.signal;
    if (stop?.aborted === true) return fallback ?? "";
    const wasMuted = this.#gate.muted;
    this.#stopSpinner();
    this.#gate.muted = false;
    this.#rl.write(null, { ctrl: true, name: "u" });
    this.#tty.output.write("\r\x1b[K");
    const asking = new AbortController();
    const answer = await new Promise<string>((resolve) => {
      const onStop = (): void => {
        asking.abort();
        resolve("");
      };
      stop?.addEventListener("abort", onStop, { once: true });
      this.#rl.question(`${question} `, { signal: asking.signal }, (a) => {
        stop?.removeEventListener("abort", onStop);
        resolve(a);
      });
    });
    this.#gate.muted = wasMuted;
    if (wasMuted && this.#engine.running) this.#startSpinner();
    const t = answer.trim();
    return t === "" ? (fallback ?? "") : t;
  }

  /**
   * A question with fixed answers, as a list to move through: up and down (or k and j) change the highlight, a key that names a choice
   * jumps to it, Enter chooses, Escape or Ctrl-C gives the default. Highlighting starts on the default, so Enter alone is the safe answer.
   * Returns the chosen key. The list is replaced by the answer once it is given.
   */
  async #select(question: string, choices: readonly Choice[], fallback = ""): Promise<string> {
    const stop = this.#engine.abort?.signal;
    if (stop?.aborted === true) return fallback;
    const wasMuted = this.#gate.muted;
    this.#stopSpinner();
    this.#gate.muted = true; // readline still sees the keys, but must not draw them
    this.#rl.write(null, { ctrl: true, name: "u" });
    const out = this.#tty.output;
    const style = this.#style;
    let index = Math.max(0, choices.findIndex((c) => c.key === fallback));
    const lines = (): string[] => choices.map((c, i) => (i === index ? style.bold(`❯ [${c.key}] ${c.label}`) : style.dim(`  [${c.key}] ${c.label}`)));
    const draw = (first: boolean): void => {
      if (!first) out.write(`\x1b[${choices.length}A`);
      out.write(lines().map((l) => `\r\x1b[K${l}\n`).join(""));
    };
    out.write(`\r\x1b[K${question}\n`);
    draw(true);
    const chosen = await new Promise<string>((resolve) => {
      const finish = (key: string): void => {
        stop?.removeEventListener("abort", onStop);
        this.#selecting = undefined;
        resolve(key);
      };
      const onStop = (): void => finish(fallback);
      stop?.addEventListener("abort", onStop, { once: true });
      this.#selecting = (key) => {
        const name = key.name ?? "";
        const hit = choices.findIndex((c) => c.key.toLowerCase() === name.toLowerCase());
        if (name === "up" || name === "k") index = (index + choices.length - 1) % choices.length;
        else if (name === "down" || name === "j") index = (index + 1) % choices.length;
        else if (name === "return" || name === "enter") return finish((choices[index] as Choice).key);
        else if (name === "escape" || (key.ctrl === true && name === "c")) return finish(fallback);
        else if (hit >= 0) index = hit;
        else return;
        draw(false);
      };
    });
    const picked = choices.find((c) => c.key === chosen);
    out.write(`\x1b[${choices.length}A\r\x1b[J${style.dim(`  → ${picked?.label ?? chosen}`)}\n`);
    // Readline gets the Enter after we do: keep it from being taken for a message, and drop what was typed on the way.
    this.#swallowLines = true;
    setImmediate(() => {
      this.#swallowLines = false;
      this.#rl.write(null, { ctrl: true, name: "u" });
    });
    this.#gate.muted = wasMuted;
    if (wasMuted && this.#engine.running) this.#startSpinner();
    return chosen;
  }

  /** Ctrl-O: put what is being typed (the draft so far and the current line) aside as a named draft, and leave the prompt empty. */
  #stash(): void {
    const text = [this.#prompt.draft, this.#rl.line].filter((t) => t !== "").join("\n");
    if (text.trim() === "") {
      this.print(`${this.#style.dim("(nothing to put aside)")}\n`);
      return;
    }
    const state = this.#engine.state;
    const name = nextDraftName(state.drafts);
    state.drafts = [...state.drafts, { name, text }];
    this.#prompt.clear();
    this.#rl.write(null, { ctrl: true, name: "u" });
    this.#engine.session?.touch();
    this.print(`${this.#style.dim(`(put aside as draft ${name}; /paste ${name} brings it back here, /send ${name} sends it, /draft ${name} edits it)`)}\n`);
  }

  #flushNotices(): void {
    const notes = this.#engine.notices.splice(0);
    if (notes.length > 0) this.print(`${notes.map((n) => this.#style.dim(`[${n}]`)).join("\n")}\n`);
  }

  /** A background job ended while idle and `background.resume` is on: let the model react. */
  async #dispatchResume(): Promise<void> {
    if (this.#closing || this.#engine.running) return;
    this.#startSpinner();
    const render = new PlainRenderer({ out: (t) => this.#emit(t), err: (t) => this.#emit(t) }, () => this.#engine.convo, this.#engine.state.thinking, this.#style, this.#engine.state.tools);
    render.width = () => this.#engine.width();
    try {
      this.#gate.muted = true;
      for await (const o of this.#engine.resume()) {
        if (o.type === "request_start") this.#spinLabel = `waiting for ${o.model}`;
        await render.render(o);
      }
    } catch (e) {
      this.#emit(this.#style.red(`error: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      this.#stopSpinner();
      this.#gate.muted = false;
    }
    this.#showPrompt();
  }

  /** Hand the terminal to a program that wants it (an editor): ordinary mode while it runs, ours again after. */
  async #suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.#rl.pause();
    this.#tty.input.setRawMode?.(false);
    this.#tty.output.write(BRACKETED_PASTE_OFF);
    this.#gate.muted = false;
    try {
      return await fn();
    } finally {
      this.#tty.output.write(BRACKETED_PASTE_ON);
      this.#tty.input.setRawMode?.(true);
      this.#rl.resume();
    }
  }

  #showPrompt(): void {
    if (this.#closing) return;
    this.#rl.setPrompt(this.#prompt.continuing ? this.#style.dim(". ") : "> ");
    this.#rl.prompt(true);
  }

  #onLine(line: string): void {
    // The Enter that chose an answer (and keys typed on the way) also reach readline: they are not messages.
    if (this.#selecting !== undefined || this.#swallowLines) return;
    const action = this.#prompt.line(line, this.#pasting);
    this.#exitArmed = 0;
    this.#engine.session?.touch();
    if (action.kind === "none") {
      this.#showPrompt();
      return;
    }
    const text = action.kind === "send" ? this.#engine.state.draft : action.line;
    const submission = action.kind === "send" ? "/say" : action.line;
    if (text.trim() !== "") {
      const h = this.#engine.state.history;
      if (h.at(-1) !== text) h.push(text);
      (this.#rl as unknown as { history: string[] }).history = [...h].reverse();
    }
    const cmd = parseCommand(submission);
    const known = cmd === undefined ? this.#engine.registry.find("say") : this.#engine.registry.find(cmd.name);
    // A command that may run during a request does so now; anything else waits its turn, so typed-ahead messages are sent in order.
    if (known?.busy === "allowed" && this.#engine.running) void this.#dispatch(submission);
    else this.#chain = this.#chain.then(() => this.#dispatch(submission));
    this.#showPrompt();
  }

  async #dispatch(line: string): Promise<void> {
    const cmd = parseCommand(line);
    const known = this.#engine.registry.find(cmd?.name ?? "say");
    const blocking = known?.busy === "blocked";
    if (blocking) this.#startSpinner();
    const paged = cmd !== undefined && cmd.name !== "exec";
    const render = new PlainRenderer({ out: (t) => (paged ? this.#page(t) : this.#emit(t)), err: (t) => this.#emit(t), clear: () => this.#tty.output.write("\x1b[2J\x1b[H") }, () => this.#engine.convo, this.#engine.state.thinking, this.#style, this.#engine.state.tools);
    render.width = () => this.#engine.width();
    try {
      if (blocking) this.#gate.muted = true;
      for await (const o of this.#engine.submit(line)) {
        if (o.type === "request_start") this.#spinLabel = `waiting for ${o.model}`;
        // A command that changed the draft out from under the prompt (say clears it) needs the prompt redrawn afterwards.
        await render.render(o);
      }
    } catch (e) {
      this.#emit(this.#style.red(`error: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      this.#stopSpinner();
      this.#gate.muted = false;
      this.#engine.session?.touch();
    }
    if (this.#engine.quit) {
      await this.#end(false);
      return;
    }
    this.#flushNotices();
    if (!this.#closing) this.print(`${this.#style.dim(await this.#engine.statusLine())}\n`);
    this.#showPrompt();
  }

  /** A command's output taller than the screen: one page now, the rest kept for /more. */
  #page(text: string): void {
    const rows = this.#engine.rows();
    const lines = text.split("\n");
    const room = rows === undefined ? Infinity : Math.max(5, rows - 4);
    if (lines.length - 1 <= room) {
      this.#emit(text);
      return;
    }
    const rest = lines.slice(room);
    this.#engine.more = rest.join("\n");
    this.#emit(`${lines.slice(0, room).join("\n")}\n${this.#style.dim(`-- ${rest.length - 1} more lines: /more shows the next page --`)}\n`);
  }

  /** Output from the renderer: written through while muted, above the prompt otherwise. */
  #emit(text: string): void {
    this.print(text);
  }

  #startSpinner(): void {
    if (this.#spinnerMs <= 0 || this.#spin !== undefined) return;
    this.#spinSince = Date.now();
    this.#spinLabel = "working";
    let i = 0;
    const draw = (): void => {
      const secs = Math.floor((Date.now() - this.#spinSince) / 1000);
      this.#tty.output.write(`\r\x1b[K${this.#style.dim(`${FRAMES[i++ % FRAMES.length]} ${this.#spinLabel} ${secs}s · Ctrl-C stops it`)}`);
    };
    this.#gate.muted = true;
    draw();
    this.#spin = setInterval(draw, this.#spinnerMs);
    this.#spin.unref();
  }

  #stopSpinner(): void {
    if (this.#spin === undefined) return;
    clearInterval(this.#spin);
    this.#spin = undefined;
    this.#tty.output.write("\r\x1b[K");
  }

  #onInterrupt(): void {
    if (this.#selecting !== undefined) {
      // Ctrl-C at a question gives the default answer, and stops the turn the question belongs to.
      this.#selecting({ name: "escape" });
      if (this.#engine.running) void this.#dispatch("/abort");
      return;
    }
    if (this.#engine.running) {
      void this.#dispatch("/abort");
      return;
    }
    const hadSomething = this.#rl.line !== "" || this.#prompt.draft !== "";
    const now = Date.now();
    if (!hadSomething && now - this.#exitArmed < this.#exitWindow) {
      void this.#end(false);
      return;
    }
    this.#prompt.clear();
    this.#rl.write(null, { ctrl: true, name: "u" });
    this.#engine.session?.touch();
    this.#exitArmed = now;
    this.print(`${this.#style.dim(hadSomething ? "(draft cleared; Ctrl-C again or Ctrl-D to quit)" : "(Ctrl-C again or Ctrl-D to quit)")}\n`);
  }

  async #complete(line: string): Promise<[string[], string]> {
    if (!line.startsWith("/") || line.startsWith("//")) return [[], line];
    const space = line.indexOf(" ");
    if (space < 0) {
      const hits = this.#engine.registry.names().map((n) => `/${n}`).filter((n) => n.startsWith(line));
      return [hits, line];
    }
    const name = line.slice(1, space);
    const cmd = this.#engine.registry.find(name);
    if (cmd?.complete === undefined) return [[], line];
    const words = line.slice(space + 1).split(" ");
    const partial = words.pop() ?? "";
    const hits = await cmd.complete(this.#engine.ctx, words.filter((w) => w !== ""), partial);
    return [hits, partial];
  }

  #startWatch(): void {
    this.#watch?.abort();
    const ac = new AbortController();
    this.#watch = ac;
    const convo = this.#engine.convo;
    void (async () => {
      try {
        for await (const e of convo.watch({ signal: ac.signal, pollMs: this.#watchMs })) {
          const text = await formatEntry(convo, e.value, { thinking: this.#engine.state.thinking, tools: this.#engine.state.tools, max: 600, style: this.#style, width: this.#engine.width() });
          if (text !== undefined) this.print(`${this.#style.dim("(from another session)")}\n${text}\n`);
        }
      } catch {
        /* the thread went away or the watch was aborted */
      }
    })();
  }

  async #end(waitForQueue: boolean): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#watch?.abort();
    // Let queued messages finish: closing the input (Ctrl-D, end of a pipe) does not throw away what was typed ahead.
    if (waitForQueue) await this.#chain;
    this.#stopSpinner();
    this.#tty.input.off("keypress", this.#onKeypress);
    this.#rl.close();
    this.#engine.onRebind = undefined;
    this.#engine.suspend = undefined;
    this.#engine.ask = undefined;
    this.#engine.onNotice = undefined;
    this.#engine.prefill = undefined;
    this.#engine.childLine = undefined;
    this.#engine.onResume = undefined;
    this.#tty.output.write(`${BRACKETED_PASTE_OFF}`);
    this.#done();
  }
}

