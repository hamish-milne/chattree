/**
 * What a background job has printed, as it prints it: the lines of a terminal, each tagged with the channel it came on. `stdin` is
 * what was typed (the command line); `stdout` and `stderr` are what came back. Held in memory for the life of the process and capped,
 * so a job that never stops talking cannot grow it without limit; the oldest text goes first.
 */

export type LogChannel = "stdin" | "stdout" | "stderr";

export interface LogChunk {
  channel: LogChannel;
  text: string;
}

/** The most text kept per job. */
export const MAX_LOG_CHARS = 1_000_000;

// Colour and cursor sequences. Commands are asked not to print them (`PLAIN_ENV`), and what still comes is removed here.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");

export class JobLog {
  #chunks: LogChunk[] = [];
  #size = 0;
  #dropped = 0;
  readonly #subs = new Set<(chunk: LogChunk) => void>();

  append(channel: LogChannel, raw: string): void {
    const text = stripAnsi(raw);
    if (text === "") return;
    const last = this.#chunks[this.#chunks.length - 1];
    if (last?.channel === channel) last.text += text;
    else this.#chunks.push({ channel, text });
    this.#size += text.length;
    while (this.#size > MAX_LOG_CHARS && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const over = this.#size - MAX_LOG_CHARS;
      if (first.text.length <= over) {
        this.#chunks.shift();
        this.#size -= first.text.length;
        this.#dropped += first.text.length;
      } else {
        first.text = first.text.slice(over);
        this.#size -= over;
        this.#dropped += over;
      }
    }
    for (const fn of this.#subs) fn({ channel, text });
  }

  chunks(): readonly LogChunk[] {
    return this.#chunks.map((c) => ({ ...c }));
  }

  /** Characters that were dropped from the front because the log was full. */
  get dropped(): number {
    return this.#dropped;
  }

  /** What the job printed (stdout and stderr in the order they came, not the command line). */
  output(): string {
    return this.#chunks
      .filter((c) => c.channel !== "stdin")
      .map((c) => c.text)
      .join("");
  }

  subscribe(fn: (chunk: LogChunk) => void): () => void {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }
}
