import { emitKeypressEvents, createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { Engine } from "./engine.ts";
import type { Tty } from "./io.ts";
import { ansiStyle, formatEntry, PlainRenderer, plainStyle, type Style } from "./output.ts";
import { parseCommand } from "./registry.ts";
import { PromptBuffer } from "./prompt.ts";

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
  }

  readonly #onKeypress = (_s: string | undefined, key: { name?: string } | undefined): void => {
    if (key?.name === "paste-start") this.#pasting = true;
    else if (key?.name === "paste-end") this.#pasting = false;
  };

  /** Show the prompt and process input until the session ends. */
  async run(): Promise<void> {
    this.#tty.output.write(BRACKETED_PASTE_ON);
    this.#startWatch();
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
    const render = new PlainRenderer({ out: (t) => this.#emit(t), err: (t) => this.#emit(t) }, () => this.#engine.convo, this.#engine.state.thinking, this.#style);
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
    this.#showPrompt();
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
          const text = await formatEntry(convo, e.value, { thinking: this.#engine.state.thinking, max: 600 });
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
    this.#tty.output.write(`${BRACKETED_PASTE_OFF}`);
    this.#done();
  }
}

