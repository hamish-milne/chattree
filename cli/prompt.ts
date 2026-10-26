import type { SessionState } from "./engine.ts";

/** What the prompt wants done with a line the user entered. */
export type PromptAction =
  /** Nothing yet: the line was added to the draft, or ignored. */
  | { kind: "none" }
  /** Send the draft as a message. */
  | { kind: "send" }
  /** Run this slash command (the draft is left alone). */
  | { kind: "command"; line: string };

/**
 * The rules for turning lines into messages and commands (docs/cli.md, sections 4 and 10), with no terminal in them:
 * a line starting with `/` is a command and runs at once; other text accumulates in the draft, one line per Enter, and a
 * blank line sends it; a trailing `\\` continues the line (so a paragraph break can be typed); a pasted block is taken
 * whole, blank lines and slashes included; `//x` is the text `/x`. The draft lives in the session state, so it is saved and
 * comes back.
 */
export class PromptBuffer {
  readonly #state: SessionState;

  constructor(state: SessionState) {
    this.#state = state;
  }

  get draft(): string {
    return this.#state.draft;
  }

  /** The prompt shows a continuation marker while a draft is open. */
  get continuing(): boolean {
    return this.#state.draft !== "";
  }

  #append(line: string): void {
    this.#state.draft = this.#state.draft === "" ? line : `${this.#state.draft}\n${line}`;
  }

  /** A line from Enter. `pasted` is true for lines inside a bracketed paste. */
  line(text: string, pasted = false): PromptAction {
    if (pasted) {
      this.#append(text);
      return { kind: "none" };
    }
    // Recalled from history: the whole (possibly multi-line) message arrives as one line, and is sent again.
    if (text.includes("\n")) {
      this.#state.draft = text;
      return { kind: "send" };
    }
    if (text.endsWith("\\")) {
      this.#append(text.slice(0, -1));
      return { kind: "none" };
    }
    if (text.trim() === "") {
      if (this.#state.draft.trim() === "") {
        this.#state.draft = "";
        return { kind: "none" };
      }
      return { kind: "send" };
    }
    if (text.startsWith("/") && !text.startsWith("//")) return { kind: "command", line: text };
    this.#append(text.startsWith("//") ? text.slice(1) : text);
    return { kind: "none" };
  }

  clear(): void {
    this.#state.draft = "";
  }
}
