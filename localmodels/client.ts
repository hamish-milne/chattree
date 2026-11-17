/**
 * Talking to the daemon: finding it, starting it when it is not there, and its control API (control.ts on the other end). Every
 * answer is checked against a schema before it is used, since the daemon may be a different build from this client.
 */
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DaemonEvent, DaemonStatus } from "./control.ts";
import { logFile, pidAlive, readInfo, removeInfo, runDir, type DaemonInfo } from "./daemon-files.ts";
import { streamChunks } from "../src/stream.ts";
import { asString, jsonOr } from "../src/json.ts";
import { Type, type StaticDecode, type TSchema } from "typebox";
import { safeParse } from "../src/validate.ts";

export class DaemonError extends Error {
  override name = "DaemonError";
}

export type ClientEvent = DaemonEvent | { type: "status"; status: DaemonStatus };

// What comes over the control API. The daemon outlives the sessions that start it, so it may be an older or newer build than this client:
// what the client reads is checked, and what a response is missing is said, not read as undefined. The depth of the host's state, of an
// install plan and of the events is the daemon's own contract (`control.ts`), so those are checked as far as the client acts on them (the
// kind of event, the fields it shows) and are typed as that contract.
const record = Type.Record(Type.String(), Type.Unknown());
const status = Type.Unsafe<DaemonStatus>(Type.Object({ pid: Type.Number(), startedAt: Type.Number(), state: record }));
const logs = Type.Object({ lines: Type.Array(Type.String()) });
const removed = Type.Object({ files: Type.Number(), bytes: Type.Number(), kept: Type.Number() });
const EVENT_KINDS = ["state", "install", "store", "models", "pulled", "log", "consent", "settings", "status"];
const clientEvent = Type.Unsafe<ClientEvent>(
  Type.Object({ type: Type.Union(EVENT_KINDS.map((k) => Type.Literal(k))) }, { additionalProperties: true }),
);

export class DaemonClient {
  readonly info: DaemonInfo;
  readonly #fetch: typeof fetch;

  constructor(info: DaemonInfo, f: typeof fetch = fetch) {
    this.info = info;
    this.#fetch = f;
  }

  /**
   * One request to the daemon, with the token as a bearer. A connection failure or a non-OK answer is a `DaemonError` that says what
   * happened; an answer that does not match `schema` is a `DaemonError` naming the fields, which suggests stopping the daemon, since it
   * may be a different version.
   */
  async #call<S extends TSchema>(schema: S, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<StaticDecode<S>> {
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
      throw new DaemonError(
        `the model host does not answer (${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)})`,
      );
    }
    if (!res.ok)
      throw new DaemonError(
        `the model host answered ${res.status}: ${asString(jsonOr(await res.json().catch(() => ({})))["error"]) ?? res.statusText}`,
      );
    const r = safeParse(schema, await res.json().catch(() => undefined));
    if (!r.ok)
      throw new DaemonError(
        `the model host answered something this version of chattree does not understand (${r.issues.map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ")}); it may be another version, so \`chattree models stop\` and try again`,
      );
    return r.value;
  }

  status(): Promise<DaemonStatus> {
    return this.#call(status, "GET", "/status");
  }
  async logs(lines = 200): Promise<string[]> {
    return (await this.#call(logs, "GET", `/logs?lines=${lines}`)).lines;
  }
  start(opts: { yes?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call(status, "POST", "/start", { yes: opts.yes === true });
  }
  restart(opts: { yes?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call(status, "POST", "/restart", { yes: opts.yes === true });
  }
  /** Begin fetching models (all when none are named); the `pulled` event ends it. */
  pull(models: string[] = [], opts: { force?: boolean } = {}): Promise<DaemonStatus> {
    return this.#call(status, "POST", "/pull", { models, force: opts.force === true });
  }
  remove(model: string): Promise<{ files: number; bytes: number; kept: number }> {
    return this.#call(removed, "POST", "/rm", { model });
  }
  async stop(): Promise<void> {
    await this.#call(Type.Unknown(), "POST", "/stop", {});
  }
  reload(): Promise<DaemonStatus> {
    return this.#call(status, "POST", "/reload", {});
  }
  async consent(accept: boolean): Promise<void> {
    await this.#call(Type.Unknown(), "POST", "/consent", { accept });
  }
  async load(model: string): Promise<void> {
    await this.#call(Type.Unknown(), "POST", "/models/load", { model });
  }
  async unload(model: string): Promise<void> {
    await this.#call(Type.Unknown(), "POST", "/models/unload", { model });
  }

  /** Follow the event stream until it ends (the daemon stopped) or `signal` aborts. The first event is the current status. */
  async events(onEvent: (e: ClientEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.#fetch(`http://127.0.0.1:${this.info.port}/events`, {
      headers: { authorization: `Bearer ${this.info.token}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!res.ok || res.body === null) throw new DaemonError(`the model host answered ${res.status} to the event stream`);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of streamChunks(res.body)) {
        buffer += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data === "") continue;
          // An event this client does not know (a newer daemon's) or cannot read is skipped; the stream goes on.
          const event = safeParse(clientEvent, JSON.parse(data));
          if (event.ok) onEvent(event.value);
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

/** Wait until a process has exited; false when it has not within `ms`. */
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/**
 * Start a daemon that outlives this process: its output goes to `run/daemon.log`. It is this program run as `models serve`, detached so
 * that it keeps running after the session that started it ends. A failure to start shows up as the daemon never answering, which
 * `ensureDaemon` reports.
 */
export async function launchDetached(data: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  await mkdir(runDir(data), { recursive: true });
  const log = await open(logFile(data), "a");
  const entry = fileURLToPath(new URL("../cli/chattree.ts", import.meta.url));
  const child = spawn(process.execPath, ["--no-warnings", entry, "models", "serve"], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
    env: env,
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

/**
 * The daemon for this data directory, started when there is none. Two sessions starting at once end up with one: the second process
 * cannot take the lock and leaves.
 */
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
