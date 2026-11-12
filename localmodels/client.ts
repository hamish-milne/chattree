import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DaemonEvent, DaemonStatus } from "./control.ts";
import { logFile, pidAlive, readInfo, removeInfo, runDir, type DaemonInfo } from "./daemon-files.ts";

/** Talking to the daemon (docs/local-models.md, section 3): finding it, starting it when it is not there, and its control API. */

export class DaemonError extends Error {
  override name = "DaemonError";
}

export type ClientEvent = DaemonEvent | { type: "status"; status: DaemonStatus };

export class DaemonClient {
  readonly info: DaemonInfo;
  readonly #fetch: typeof fetch;

  constructor(info: DaemonInfo, f: typeof fetch = fetch) {
    this.info = info;
    this.#fetch = f;
  }

  async #call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`http://127.0.0.1:${this.info.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (e) {
      if (signal?.aborted === true) throw e;
      throw new DaemonError(`the model host does not answer (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)})`);
    }
    if (!res.ok) throw new DaemonError(`the model host answered ${res.status}: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText}`);
    return (await res.json()) as T;
  }

  status(): Promise<DaemonStatus> {
    return this.#call("GET", "/status");
  }
  async logs(lines = 200): Promise<string[]> {
    return (await this.#call<{ lines: string[] }>("GET", `/logs?lines=${lines}`)).lines;
  }
  start(opts: { yes?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call("POST", "/start", { yes: opts.yes === true });
  }
  restart(opts: { yes?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call("POST", "/restart", { yes: opts.yes === true });
  }
  /** Begin fetching models (all when none are named); the `pulled` event ends it. */
  pull(models: string[] = [], opts: { force?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call("POST", "/pull", { models, force: opts.force === true });
  }
  remove(model: string): Promise<{ files: number; bytes: number; kept: number }> {
    return this.#call("POST", "/rm", { model });
  }
  async stop(): Promise<void> {
    await this.#call("POST", "/stop", {});
  }
  reload(): Promise<DaemonStatus> {
    return this.#call("POST", "/reload", {});
  }
  async consent(accept: boolean): Promise<void> {
    await this.#call("POST", "/consent", { accept });
  }
  async load(model: string): Promise<void> {
    await this.#call("POST", "/models/load", { model });
  }
  async unload(model: string): Promise<void> {
    await this.#call("POST", "/models/unload", { model });
  }

  /** Follow the event stream until it ends (the daemon stopped) or `signal` aborts. The first event is the current status. */
  async events(onEvent: (e: ClientEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.#fetch(`http://127.0.0.1:${this.info.port}/events`, { headers: { authorization: `Bearer ${this.info.token}` }, ...(signal === undefined ? {} : { signal }) });
    if (!res.ok || res.body === null) throw new DaemonError(`the model host answered ${res.status} to the event stream`);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data !== "") onEvent(JSON.parse(data) as ClientEvent);
        }
      }
    } catch {
      // the daemon went away, or we stopped listening: the stream is over either way
    }
  }
}

/** The daemon that is running for this data directory, or undefined. A state file whose process is gone is removed. */
export async function findDaemon(data: string, f: typeof fetch = fetch): Promise<DaemonClient | undefined> {
  const info = await readInfo(data);
  if (info === undefined) return undefined;
  if (!pidAlive(info.pid)) {
    await removeInfo(data);
    return undefined;
  }
  const client = new DaemonClient(info, f);
  try {
    await client.status();
    return client;
  } catch {
    return undefined;
  }
}

/** Start a daemon that outlives this process: its output goes to `run/daemon.log`. */
export async function launchDetached(data: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  await mkdir(runDir(data), { recursive: true });
  const log = await open(logFile(data), "a");
  const entry = fileURLToPath(new URL("../cli/chattree.ts", import.meta.url));
  const child = spawn(process.execPath, ["--no-warnings", entry, "models", "serve"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
    env: env as NodeJS.ProcessEnv,
  });
  child.on("error", () => undefined);
  child.unref();
  await log.close();
}

export interface EnsureOptions {
  data: string;
  /** Start a daemon (default: `launchDetached`). */
  launch?: (() => Promise<void>) | undefined;
  /** Told when a daemon is being started. */
  onLaunch?: (() => void) | undefined;
  /** How long to wait for it to answer. */
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
}

/** The daemon for this data directory, started when there is none. Two sessions starting at once end up with one: the second process cannot take the lock and leaves. */
export async function ensureDaemon(o: EnsureOptions): Promise<DaemonClient> {
  const found = await findDaemon(o.data, o.fetch);
  if (found !== undefined) return found;
  o.onLaunch?.();
  await (o.launch ?? (() => launchDetached(o.data)))();
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const c = await findDaemon(o.data, o.fetch);
    if (c !== undefined) return c;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new DaemonError(`the model host did not start; its log is ${logFile(o.data)}`);
}
