import { GitError } from "../errors.ts";
import type { HostProcess } from "../host.ts";
import type { ObjectInfo } from "./git.ts";

/** Reads git objects by name (`<rev>:<path>`, a hash, ...). Missing objects come back as undefined. */
export interface ObjectReader {
  info(spec: string): Promise<ObjectInfo | undefined>;
  read(spec: string): Promise<Uint8Array | undefined>;
  /** Release the underlying process, if any. Safe to call more than once. */
  close(): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function assertObjectName(spec: string): void {
  if (spec.includes("\n") || spec.includes("\u0000") || spec.startsWith("-") || spec === "") throw new GitError(`invalid object name: ${JSON.stringify(spec)}`);
}

/** Pulls lines and exact byte counts out of a stream of chunks. */
class ByteReader {
  readonly #it: AsyncIterator<Uint8Array>;
  #buf = new Uint8Array(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#it = source[Symbol.asyncIterator]();
  }

  async #more(): Promise<boolean> {
    const r = await this.#it.next();
    if (r.done === true) return false;
    const next = new Uint8Array(this.#buf.length + r.value.length);
    next.set(this.#buf);
    next.set(r.value, this.#buf.length);
    this.#buf = next;
    return true;
  }

  async line(): Promise<string> {
    let from = 0;
    for (;;) {
      const nl = this.#buf.indexOf(10, from);
      if (nl >= 0) {
        const text = dec.decode(this.#buf.subarray(0, nl));
        this.#buf = this.#buf.subarray(nl + 1);
        return text;
      }
      from = this.#buf.length;
      if (!(await this.#more())) throw new GitError("git cat-file ended unexpectedly");
    }
  }

  async bytes(n: number): Promise<Uint8Array> {
    while (this.#buf.length < n) if (!(await this.#more())) throw new GitError("git cat-file ended unexpectedly");
    const out = this.#buf.slice(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
}

const HEADER = /^([0-9a-f]{40,64}) (\S+) (\d+)$/;

/**
 * One long-lived `git cat-file --batch-command` process answering many requests, instead of a process per
 * request. Requests are answered in order; if the process dies, pending and later requests reject.
 */
export class CatFileSession implements ObjectReader {
  readonly #proc: HostProcess;
  readonly #out: ByteReader;
  #writes: Promise<unknown> = Promise.resolve();
  #reads: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(proc: HostProcess) {
    this.#proc = proc;
    this.#out = new ByteReader(proc.output);
  }

  /**
   * Requests are written in call order without waiting for earlier answers (git answers in order), so a burst
   * of requests costs one round trip, not one each. Answers are read in the same order.
   */
  #ask<T>(command: string, spec: string, answer: (header: string) => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new GitError("the cat-file session is closed"));
    const wrote = this.#writes.then(async () => {
      assertObjectName(spec);
      await this.#proc.write(enc.encode(`${command} ${spec}\n`));
    });
    this.#writes = wrote.catch(() => undefined);
    const run = this.#reads.then(async () => {
      await wrote; // rejects if the request was invalid or could not be sent: nothing to read
      return answer(await this.#out.line());
    });
    this.#reads = run.catch(() => undefined);
    return run;
  }

  info(spec: string): Promise<ObjectInfo | undefined> {
    return this.#ask("info", spec, async (h) => {
      const m = HEADER.exec(h);
      return m === null ? undefined : { oid: m[1] as string, type: m[2] as string, size: Number(m[3]) };
    });
  }

  read(spec: string): Promise<Uint8Array | undefined> {
    return this.#ask("contents", spec, async (h) => {
      const m = HEADER.exec(h);
      if (m === null) return undefined;
      const data = await this.#out.bytes(Number(m[3]));
      await this.#out.bytes(1); // the newline after the content
      return data;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writes;
    await this.#reads;
    await this.#proc.closeInput();
    await this.#proc.exit;
  }
}
