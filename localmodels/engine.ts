import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { LocalModels } from "./config.ts";
import { routerArgs } from "./plan.ts";

/**
 * The engine seam (docs/local-models.md, section 3): a program that serves the models. The first is llama-server's router mode; the host
 * is written against these types so another (llama-swap) can be added. Nothing here knows about settings files, downloads or restarts.
 */

export type ModelState = "unloaded" | "loading" | "loaded" | "sleeping" | "unknown";

export interface ModelStatus {
  name: string;
  state: ModelState;
}

export interface EngineSpec {
  binary: string;
  config: LocalModels;
  presetPath: string;
  port: number;
  cwd: string;
  /** Each line the program prints, on either stream. */
  onLog: (line: string) => void;
  signal?: AbortSignal | undefined;
}

export interface EngineProcess {
  /** The server address; the OpenAI-compatible API is under `/v1`. */
  readonly baseUrl: string;
  /** Settles when the program ends, however it ends. */
  readonly exited: Promise<{ code: number | null }>;
  models(): Promise<ModelStatus[]>;
  /** Read the preset file again. */
  reload(): Promise<void>;
  load(model: string): Promise<void>;
  unload(model: string): Promise<void>;
  /** Stop the program and wait for it. */
  stop(): Promise<void>;
}

export interface Engine {
  /** Start the program and resolve when it answers. Rejects (with the end of its output) when it does not. */
  start(spec: EngineSpec): Promise<EngineProcess>;
}

export class EngineError extends Error {
  override name = "EngineError";
}

/** A started program, as much as the router engine needs of it. */
export interface Child {
  kill(): void;
  exit: Promise<{ code: number | null }>;
}

export type SpawnFn = (binary: string, args: string[], o: { cwd: string; onLine: (line: string) => void }) => Child;

export const nodeSpawn: SpawnFn = (binary, args, o) => {
  const child = spawn(binary, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on("line", o.onLine);
  const exit = new Promise<{ code: number | null }>((resolve) => {
    child.on("error", (e) => {
      o.onLine(`could not start ${binary}: ${e.message}`);
      resolve({ code: null });
    });
    child.on("close", (code) => resolve({ code }));
  });
  return {
    kill() {
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    },
    exit,
  };
};

const connectHost = (host: string): string => (host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host);
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const STATES = new Set<ModelState>(["unloaded", "loading", "loaded", "sleeping"]);

export interface RouterOptions {
  spawn?: SpawnFn | undefined;
  fetch?: typeof fetch | undefined;
  /** Time between checks while waiting for the program to answer. */
  pollMs?: number | undefined;
}

/** llama-server in router mode: one process, models loaded and unloaded by name, the preset file read again on request. */
export class RouterEngine implements Engine {
  readonly #spawn: SpawnFn;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;

  constructor(o: RouterOptions = {}) {
    this.#spawn = o.spawn ?? nodeSpawn;
    this.#fetch = o.fetch ?? fetch;
    this.#pollMs = o.pollMs ?? 250;
  }

  async start(spec: EngineSpec): Promise<EngineProcess> {
    const tail: string[] = [];
    const child = this.#spawn(spec.binary, routerArgs(spec.config, spec.presetPath, spec.port), {
      cwd: spec.cwd,
      onLine: (line) => {
        tail.push(line);
        if (tail.length > 20) tail.shift();
        spec.onLog(line);
      },
    });
    const baseUrl = `http://${connectHost(spec.config.server.host)}:${spec.port}`;
    const get = (path: string, init?: RequestInit) => this.#fetch(`${baseUrl}${path}`, init);
    const proc: EngineProcess = {
      baseUrl,
      exited: child.exit,
      async models() {
        const res = await get("/v1/models");
        if (!res.ok) throw new EngineError(`llama-server answered ${res.status} to the model list`);
        return parseModels(await res.json());
      },
      async reload() {
        const res = await get("/models?reload=1");
        if (!res.ok) throw new EngineError(`llama-server answered ${res.status} to the reload`);
        await res.body?.cancel();
      },
      load: (model) => post(get, "/models/load", model),
      unload: (model) => post(get, "/models/unload", model),
      async stop() {
        child.kill();
        await child.exit;
      },
    };

    let ended = false;
    void child.exit.then(() => (ended = true));
    const deadline = Date.now() + spec.config.server.health_timeout * 1000;
    while (!ended && spec.signal?.aborted !== true) {
      try {
        await proc.models();
        return proc;
      } catch {
        // not answering yet
      }
      if (Date.now() > deadline) {
        child.kill();
        await child.exit;
        throw new EngineError(`llama-server did not answer within ${spec.config.server.health_timeout} s${tail.length > 0 ? `; it printed:\n${tail.join("\n")}` : ""}`);
      }
      await sleep(this.#pollMs, spec.signal);
    }
    if (ended) {
      const { code } = await child.exit;
      throw new EngineError(`llama-server stopped at start (exit code ${code ?? "none"})${tail.length > 0 ? `; it printed:\n${tail.join("\n")}` : ""}`);
    }
    child.kill();
    await child.exit;
    throw new EngineError("the start was cancelled");
  }
}

async function post(get: (path: string, init?: RequestInit) => Promise<Response>, path: string, model: string): Promise<void> {
  const res = await get(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
  const text = await res.text();
  if (!res.ok) throw new EngineError(`llama-server answered ${res.status} to ${path} for ${model}: ${text.slice(0, 200)}`);
}

/** `GET /v1/models` of the router: `data[].id` and `data[].status.value`. */
export function parseModels(json: unknown): ModelStatus[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((m: Record<string, unknown>) => {
    if (typeof m["id"] !== "string") return [];
    const v = (m["status"] as { value?: unknown } | undefined)?.value;
    return [{ name: m["id"], state: typeof v === "string" && STATES.has(v as ModelState) ? (v as ModelState) : "unknown" }];
  });
}
