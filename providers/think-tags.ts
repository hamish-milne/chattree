/**
 * Splits a model's reasoning out of its answer when a server leaves it inline as `<think>…</think>` (vLLM without a
 * reasoning parser, llama-server with reasoning parsing off, gateways for DeepSeek-R1 and Qwen3-style models).
 *
 * The rule is deliberately narrow, so that it can run on every response without harming those that have no tags:
 * only the very start of the content is looked at. If, ignoring leading whitespace, the content begins with the opening
 * tag, everything up to the closing tag is reasoning and the rest (minus the whitespace right after the closing tag) is
 * the answer; otherwise the splitter turns itself off for the rest of the response at the first non-matching character.
 * A tag later in the answer is never touched, and nothing is decoded or unescaped: a model's text has no escaping, so a
 * literal `<think>` at the start of an answer cannot be told from the delimiter (set `think_tags: off` for such use).
 *
 * `implicit_open` is for chat templates that put the opening tag in the prompt, so the output starts mid-thought and
 * only `</think>` appears: everything before the closing tag is reasoning. A response from such a model that skips
 * thinking and sends no closing tag is therefore all reasoning, which is why it is opt-in.
 */
export interface ThinkOptions {
  open: string;
  close: string;
  implicitOpen?: boolean;
}

export const DEFAULT_THINK: ThinkOptions = { open: "<think>", close: "</think>" };

/** `reasoning_end` marks the closing tag: the reasoning block is complete even if no answer follows. */
export type Piece = { kind: "reasoning" | "text"; text: string } | { kind: "reasoning_end" };

type Mode = "detect" | "thinking" | "trim" | "answer";

export class ThinkSplitter {
  readonly #open: string;
  readonly #close: string;
  #mode: Mode;
  #buf = "";

  constructor(opts: ThinkOptions = DEFAULT_THINK) {
    this.#open = opts.open;
    this.#close = opts.close;
    this.#mode = opts.implicitOpen === true ? "thinking" : "detect";
  }

  /** Feed the next piece of content; returns what can be said so far (held-back text is a possible tag in progress). */
  push(chunk: string): Piece[] {
    const out: Piece[] = [];
    this.#feed(chunk, out);
    return out;
  }

  /** The content ended: whatever is held back was not a tag after all, or is unfinished reasoning. */
  end(): Piece[] {
    const out: Piece[] = [];
    if (this.#buf !== "") {
      out.push({ kind: this.#mode === "thinking" ? "reasoning" : "text", text: this.#buf });
      this.#buf = "";
    }
    return out;
  }

  /** True while the splitter is inside a reasoning block. */
  get thinking(): boolean {
    return this.#mode === "thinking";
  }

  #feed(chunk: string, out: Piece[]): void {
    let rest = chunk;
    while (rest !== "") {
      if (this.#mode === "answer") {
        out.push({ kind: "text", text: rest });
        return;
      }
      if (this.#mode === "trim") {
        rest = rest.trimStart();
        if (rest === "") return;
        this.#mode = "answer";
        continue;
      }
      this.#buf += rest;
      rest = "";
      if (this.#mode === "detect") {
        const head = this.#buf.trimStart();
        if (head === "") return; // only whitespace so far
        if (head.startsWith(this.#open)) {
          rest = head.slice(this.#open.length).trimStart();
          this.#buf = "";
          this.#mode = "thinking";
        } else if (this.#open.startsWith(head)) {
          return; // a proper prefix of the opening tag: wait for more
        } else {
          out.push({ kind: "text", text: this.#buf });
          this.#buf = "";
          this.#mode = "answer";
        }
        continue;
      }
      // thinking: look for the closing tag, holding back a tail that may be the start of one
      const at = this.#buf.indexOf(this.#close);
      if (at >= 0) {
        const reasoning = this.#buf.slice(0, at);
        if (reasoning !== "") out.push({ kind: "reasoning", text: reasoning });
        rest = this.#buf.slice(at + this.#close.length);
        this.#buf = "";
        this.#mode = "trim";
        out.push({ kind: "reasoning_end" });
        continue;
      }
      let hold = 0;
      for (let n = Math.min(this.#close.length - 1, this.#buf.length); n > 0; n--) {
        if (this.#buf.endsWith(this.#close.slice(0, n))) {
          hold = n;
          break;
        }
      }
      const emit = this.#buf.slice(0, this.#buf.length - hold);
      if (emit !== "") out.push({ kind: "reasoning", text: emit });
      this.#buf = this.#buf.slice(this.#buf.length - hold);
    }
  }
}
