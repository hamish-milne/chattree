import type { Host } from "../src/host.ts";
import { nodeHost } from "../hosts/node.ts";

/**
 * Everything the CLI needs from the process, so tests can run it in-process: where output goes, the environment, the
 * working directory, whether there is a terminal, and the clock. Only `nodeIo` touches `process`.
 */
export interface Io {
  host: Host;
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Standard input is a terminal (and so is standard output): user mode is possible. */
  interactive: boolean;
  /** Read all of standard input (for `say -`). */
  readStdin(): Promise<Uint8Array>;
  now(): number;
  /** The terminal's streams, present when `interactive`; tests supply their own. */
  tty?: Tty;
  /** Run `fn` when the process is asked to stop (SIGTERM, SIGHUP, SIGINT); returns the way to stop listening. Absent in tests. */
  onSignal?(fn: (signal: string) => void): () => void;
  /** Ask the user a question and return the answer (the default when they just press Enter). Present only when `interactive`. */
  ask?(question: string, fallback?: string): Promise<string>;
}

export interface Tty {
  input: NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown; isTTY?: boolean };
  output: NodeJS.WritableStream & { columns?: number };
}

export function nodeIo(): Io {
  return {
    host: nodeHost(),
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async readStdin() {
      const chunks: Uint8Array[] = [];
      for await (const c of process.stdin) chunks.push(c as Uint8Array);
      return Buffer.concat(chunks);
    },
    now: Date.now,
    tty: { input: process.stdin, output: process.stdout },
    onSignal(fn) {
      const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const handlers = names.map((n) => {
        const h = (): void => fn(n);
        process.on(n, h);
        return h;
      });
      return () => names.forEach((n, i) => process.off(n, handlers[i] as () => void));
    },
    async ask(question, fallback) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const a = (await rl.question(`${question}${fallback === undefined ? "" : ` [${fallback}]`} `)).trim();
        return a === "" ? (fallback ?? "") : a;
      } finally {
        rl.close();
      }
    },
  };
}

/** A failure the user can act on: shown as `error: message` and exit status 1, no stack trace. */
export class CliError extends Error {
  override name = "CliError";
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
