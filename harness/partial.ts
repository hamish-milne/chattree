import type { Block } from "./context-builder.ts";
import type { Observed, StreamEvent, Usage } from "../providers/types.ts";

/**
 * Folds a stream's events into what is known so far: the complete blocks, the text received for a block that is
 * not finished, a tool call that has started, the usage and what the provider said about itself. It is how a turn
 * that ends early (the user stops it, the connection fails, the process dies and the journal is replayed) says what
 * it got, using the same rules each time (docs/providers.md, P5).
 */
export class StreamAccumulator {
  readonly #done = new Map<number, Block>();
  readonly #text = new Map<number, string>();
  readonly #calls = new Map<number, { call_id: string; name: string; args: string }>();
  usage: Usage | undefined;
  observed: Observed = {};
  started = false;

  add(e: StreamEvent): void {
    switch (e.type) {
      case "started":
        this.started = true;
        break;
      case "observed":
        this.observed = { ...this.observed, ...e.observed };
        break;
      case "usage":
        this.usage = e.usage;
        break;
      case "text.delta":
        this.#text.set(e.index, (this.#text.get(e.index) ?? "") + e.text);
        break;
      case "tool_call.start":
        this.#calls.set(e.index, { call_id: e.call_id, name: e.name, args: "" });
        break;
      case "tool_call.delta": {
        const c = this.#calls.get(e.index);
        if (c !== undefined) c.args += e.args_delta;
        break;
      }
      case "block.done":
        this.#done.set(e.index, e.block);
        this.#text.delete(e.index);
        this.#calls.delete(e.index);
        break;
      case "reasoning.delta":
        break; // unfinished reasoning cannot be replayed (its signature or payload is missing), so it is not kept
    }
  }

  /** Whether anything worth recording arrived: a block, some text, a started tool call, or billed tokens. */
  get hasContent(): boolean {
    return this.#done.size > 0 || [...this.#text.values()].some((t) => t !== "") || this.#calls.size > 0 || this.usage !== undefined;
  }

  /**
   * Complete blocks in order, then what was in flight: text so far as a text block, and a started tool call as a
   * call with no usable arguments (`args_raw` holds what arrived; the context builder shows it as a note, never as a call).
   */
  blocks(): Block[] {
    const all: [number, Block][] = [...this.#done];
    for (const [i, t] of this.#text) if (t !== "") all.push([i, { type: "text", text: t }]);
    for (const [i, c] of this.#calls) all.push([i, { type: "tool_call", call_id: c.call_id, name: c.name, args: {}, args_raw: c.args }]);
    return all.sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  }
}
