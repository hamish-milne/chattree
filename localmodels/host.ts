import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalModels } from "./config.ts";
import { RouterEngine, type Engine, type EngineProcess, type ModelStatus } from "./engine.ts";
import type { GpuFinding } from "./gpu.ts";
import { ensureLlamaServer, type InstallDeps, type InstallEvent, type InstallPlan } from "./install.ts";
import { Lock } from "./lock.ts";
import { removeModelFiles } from "./inventory.ts";
import { downloadList, presetIni, type ModelFiles } from "./plan.ts";
import type { Arch, Platform } from "./release.ts";
import { fetchDownloads, modelId, resolveDownloads, type Fetched, type StoreEvent } from "./store.ts";

/**
 * The local model host (docs/local-models.md, section 3): settings in, a running llama-server out. It installs the program, fetches the
 * models, writes the preset, starts the engine, restarts it when it dies, and applies a changed settings section to the running server
 * without stopping it when it can. It does not read the settings file or serve a control API; the daemon (step 4) does both.
 */

export type Phase = "idle" | "installing" | "downloading" | "starting" | "ready" | "restarting" | "stopping" | "stopped" | "error";

export interface HostState {
  phase: Phase;
  /** The server address while there is one. */
  baseUrl: string | undefined;
  /** What went wrong: the reason for `error`, or for a failed `apply` while the old settings keep running. */
  error: string | undefined;
  models: ModelStatus[];
  /** The llama.cpp build in use. */
  tag: string | undefined;
  /** Its backend (`cuda`, `cpu`, `metal`...), and for `backend: auto` what was found and so chosen. */
  backend: string | undefined;
  backendNote: string | undefined;
  /** How many times the supervisor has restarted the server since it was started. */
  restarts: number;
  /** Model ids (`name@hash8`) of what is fetched. */
  ids: Record<string, string>;
}

export type HostEvent =
  | { type: "state"; state: HostState }
  | { type: "install"; event: InstallEvent }
  | { type: "store"; event: StoreEvent }
  | { type: "models"; models: ModelStatus[] }
  | { type: "pulled"; models: string[]; error: string | undefined }
  | { type: "log"; line: string };

export interface Backoff {
  initialMs: number;
  maxMs: number;
  /** Consecutive failed starts before the host gives up. */
  maxFailures: number;
  /** A server that ran this long counts as healthy again. */
  stableMs: number;
}

export interface HostOptions {
  data: string;
  config: LocalModels;
  platform: Platform;
  arch: Arch;
  /** Relative chat template paths are relative to this (the settings file's directory). Default: `data`. */
  baseDir?: string | undefined;
  engine?: Engine | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  fetch?: typeof fetch | undefined;
  installDeps?: InstallDeps | undefined;
  /** Look for a GPU when the backend is `auto` (tests). */
  findGpu?: (() => Promise<GpuFinding>) | undefined;
  confirm?: ((plan: InstallPlan) => Promise<boolean>) | undefined;
  freePort?: ((host: string) => Promise<number>) | undefined;
  backoff?: Partial<Backoff> | undefined;
  /** How often the model states are read while the server is up. */
  pollMs?: number | undefined;
  /** Another Hugging Face address (tests). */
  hfBase?: string | undefined;
}

const DEFAULT_BACKOFF: Backoff = { initialMs: 1000, maxMs: 30_000, maxFailures: 5, stableMs: 60_000 };
const LOG_LINES = 500;

export async function freePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolvePort(port));
    });
  });
}

/** What makes the engine process itself different: a change here is a restart. */
const processKey = (c: LocalModels): string => JSON.stringify({ e: c.engine, l: c.llama_cpp, s: { ...c.server, idle_exit_minutes: undefined }, t: c.hf_token_env });

/** A preset file split into its sections, to see which models a change touches. */
function sections(ini: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of ini.split(/\n(?=\[)/)) {
    const m = /^\[([^\]]+)\]/.exec(part);
    if (m !== null) out.set(m[1] as string, part.trim());
  }
  return out;
}

export class LocalModelHost {
  readonly #o: HostOptions;
  readonly #engine: Engine;
  readonly #listeners = new Set<(e: HostEvent) => void>();
  readonly #log: string[] = [];
  #config: LocalModels;
  #state: HostState = { phase: "idle", baseUrl: undefined, error: undefined, models: [], tag: undefined, backend: undefined, backendNote: undefined, restarts: 0, ids: {} };
  #proc: EngineProcess | undefined;
  #binary: string | undefined;
  #port: number | undefined;
  #preset = "";
  #files: Record<string, ModelFiles> = {};
  #chain: Promise<unknown> = Promise.resolve();
  #abort = new AbortController();
  #wanted = false;
  #poll: NodeJS.Timeout | undefined;
  #lock: Lock | undefined;

  constructor(o: HostOptions) {
    this.#o = o;
    this.#config = o.config;
    this.#engine = o.engine ?? new RouterEngine({ fetch: o.fetch });
  }

  get state(): HostState {
    return this.#state;
  }

  get config(): LocalModels {
    return this.#config;
  }

  logs(lines = LOG_LINES): string[] {
    return this.#log.slice(-lines);
  }

  on(listener: (e: HostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Install, fetch, and start. Resolves when the server is up; rejects with the reason when it is not (and the state is `error`). */
  start(): Promise<HostState> {
    this.#wanted = true;
    this.#abort = new AbortController();
    // The phase changes now, not when the queue gets to it, so whoever asked sees a start in progress and not the end of the last one.
    if (this.#proc === undefined && ["idle", "stopped", "error"].includes(this.#state.phase)) this.#set({ phase: "installing", error: undefined });
    return this.#enqueue(async () => {
      if (this.#proc !== undefined) return this.#state;
      await this.#bringUp(this.#config);
      return this.#state;
    });
  }

  /** Stop the server. The host can be started again. */
  async stop(): Promise<void> {
    this.#wanted = false;
    this.#abort.abort();
    await this.#enqueue(async () => {
      if (this.#state.phase === "idle" || this.#state.phase === "stopped") return;
      this.#set({ phase: "stopping" });
      await this.#teardown();
      this.#set({ phase: "stopped", baseUrl: undefined, models: [], error: undefined });
    });
  }

  /**
   * Use new settings. A change to the program, its backend or the server (address, port, how many models) restarts the server; anything
   * else is written to the preset and read by the running server, and the models whose section changed are unloaded so they come back
   * with the new settings. A change that cannot be applied (a download fails) leaves the old settings running and says why in `state.error`.
   */
  apply(config: LocalModels): Promise<HostState> {
    return this.#enqueue(async () => {
      const old = this.#config;
      if (this.#proc === undefined || this.#state.phase !== "ready") {
        this.#config = config;
        if (this.#state.phase === "error" && this.#wanted) await this.#bringUp(config);
        return this.#state;
      }
      this.#set({ error: undefined });
      if (processKey(old) !== processKey(config)) {
        await this.#teardown();
        this.#config = config;
        await this.#bringUp(config);
        return this.#state;
      }
      try {
        const prepared = await this.#prepare(config);
        const next = presetIni(config, prepared.files);
        const before = sections(this.#preset);
        const after = sections(next);
        this.#config = config;
        this.#files = prepared.files;
        if (next !== this.#preset) {
          await writeFile(join(this.#o.data, "run", "preset.ini"), next);
          this.#preset = next;
          const proc = this.#proc;
          await proc.reload();
          const shared = before.get("*") !== after.get("*");
          const loaded = new Set((await proc.models()).filter((m) => m.state === "loaded" || m.state === "loading" || m.state === "sleeping").map((m) => m.name));
          for (const name of loaded) if (shared || before.get(name) !== after.get(name)) await proc.unload(name).catch(() => undefined);
        }
        this.#set({ ids: prepared.ids, error: undefined });
        await this.#refreshModels();
      } catch (e) {
        this.#set({ error: message(e) });
      }
      return this.#state;
    });
  }

  /**
   * Fetch models without starting the server: the named ones, or all of them. With `force` they are deleted first and fetched again
   * (what to do when the file upstream has changed). Needs the server stopped when forcing. The `pulled` event ends it.
   */
  pull(names?: readonly string[], opts: { force?: boolean } = {}): Promise<void> {
    return this.#enqueue(async () => {
      const config = this.#config;
      const wanted = names === undefined || names.length === 0 ? Object.keys(config.models) : [...names];
      const unknown = wanted.filter((n) => config.models[n] === undefined);
      const prev = this.#state;
      try {
        if (unknown.length > 0) throw new Error(`no model named ${unknown.join(", ")} in the settings`);
        if (opts.force === true && this.#proc !== undefined) throw new Error("stop the model host first (`chattree models stop`): a model that is loaded cannot be fetched again");
        this.#lock ??= await Lock.open(join(this.#o.data, "lock.json"));
        if (opts.force === true) for (const n of wanted) await removeModelFiles(config, this.#lock, this.#o.data, n, { shared: true });
        const subset = { ...config, models: Object.fromEntries(wanted.map((n) => [n, config.models[n]])) } as LocalModels;
        const prepared = await this.#prepare(subset);
        this.#set({ phase: prev.phase, ids: { ...prev.ids, ...prepared.ids } });
        this.#emit({ type: "pulled", models: wanted, error: undefined });
      } catch (e) {
        this.#set({ phase: prev.phase });
        this.#emit({ type: "pulled", models: wanted, error: message(e) });
        throw e;
      }
    });
  }

  /** Delete a model's downloaded files (they are fetched again the next time the model is wanted). Needs the server stopped. */
  remove(name: string): Promise<{ files: number; bytes: number; kept: number }> {
    return this.#enqueue(async () => {
      if (this.#proc !== undefined) throw new Error("stop the model host first (`chattree models stop`): its models are in use");
      this.#lock ??= await Lock.open(join(this.#o.data, "lock.json"));
      if (this.#config.models[name] === undefined && this.#lock.filesUnder(`models/${name}/`).length === 0) throw new Error(`no model named ${name}`);
      const r = await removeModelFiles(this.#config, this.#lock, this.#o.data, name);
      const { [name]: _gone, ...ids } = this.#state.ids;
      this.#set({ ids });
      return r;
    });
  }

  load(model: string): Promise<void> {
    return this.#need().load(model);
  }

  unload(model: string): Promise<void> {
    return this.#need().unload(model);
  }

  #need(): EngineProcess {
    if (this.#proc === undefined) throw new Error("the model host is not running");
    return this.#proc;
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(op, op);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #set(patch: Partial<HostState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit({ type: "state", state: this.#state });
  }

  #emit(e: HostEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  #token(c: LocalModels): string | undefined {
    const name = c.hf_token_env;
    return name === undefined ? undefined : (this.#o.env ?? process.env)[name];
  }

  async #prepare(config: LocalModels): Promise<{ files: Record<string, ModelFiles>; ids: Record<string, string> }> {
    this.#set({ phase: this.#state.phase === "ready" ? "ready" : "downloading" });
    const { data } = this.#o;
    this.#lock ??= await Lock.open(join(data, "lock.json"));
    const { downloads, issues } = downloadList(config, { join }, data);
    if (issues.length > 0) throw new Error(issues.map((i) => `${i.model}: ${i.message}`).join("\n"));
    const opts = {
      lock: this.#lock,
      data,
      fetch: this.#o.fetch,
      token: this.#token(config),
      hfBase: this.#o.hfBase,
      signal: this.#abort.signal,
      onEvent: (event: StoreEvent) => this.#emit({ type: "store", event }),
    };
    const fetched = await fetchDownloads(await resolveDownloads(downloads, opts), opts);
    await this.#lock.save();
    const files: Record<string, ModelFiles> = {};
    const ids: Record<string, string> = {};
    const base = this.#o.baseDir ?? data;
    for (const name of Object.keys(config.models)) {
      const model = fetched.filter((f: Fetched) => f.model === name && f.role === "model").sort((a, b) => a.dest.localeCompare(b.dest))[0];
      if (model === undefined) continue;
      const mm = fetched.find((f) => f.model === name && f.role === "mmproj");
      const dr = fetched.find((f) => f.model === name && f.role === "draft");
      const template = config.models[name]?.chat_template;
      files[name] = { file: model.dest, ...(mm === undefined ? {} : { mmproj: mm.dest }), ...(dr === undefined ? {} : { draft: dr.dest }), ...(template === undefined ? {} : { template: resolve(base, template) }) };
      const id = modelId(name, fetched);
      if (id !== undefined) ids[name] = id;
    }
    return { files, ids };
  }

  async #bringUp(config: LocalModels): Promise<void> {
    try {
      this.#set({ phase: "installing", error: undefined, restarts: 0 });
      this.#lock ??= await Lock.open(join(this.#o.data, "lock.json"));
      const installed = await ensureLlamaServer({
        data: this.#o.data,
        config: config.llama_cpp,
        platform: this.#o.platform,
        arch: this.#o.arch,
        lock: this.#lock,
        confirm: this.#o.confirm,
        signal: this.#abort.signal,
        onEvent: (event) => this.#emit({ type: "install", event }),
        findGpu: this.#o.findGpu,
        deps: { fetch: this.#o.fetch, ...this.#o.installDeps },
      });
      this.#binary = installed.binary;
      this.#set({ tag: installed.tag, backend: installed.backend, backendNote: installed.backendNote });
      const prepared = await this.#prepare(config);
      this.#files = prepared.files;
      this.#preset = presetIni(config, prepared.files);
      await mkdir(join(this.#o.data, "run"), { recursive: true });
      await writeFile(join(this.#o.data, "run", "preset.ini"), this.#preset);
      this.#port = config.server.port === "auto" ? await (this.#o.freePort ?? freePort)(config.server.host) : config.server.port;
      this.#set({ ids: prepared.ids });
      await this.#launch();
    } catch (e) {
      this.#proc = undefined;
      this.#set({ phase: "error", baseUrl: undefined, models: [], error: message(e) });
      throw e;
    }
  }

  /** Start the engine process with what is already prepared, and watch it. */
  async #launch(): Promise<void> {
    this.#set({ phase: "starting" });
    const proc = await this.#engine.start({
      binary: this.#binary as string,
      config: this.#config,
      presetPath: join(this.#o.data, "run", "preset.ini"),
      port: this.#port as number,
      cwd: this.#o.data,
      signal: this.#abort.signal,
      onLog: (line) => {
        this.#log.push(line);
        if (this.#log.length > LOG_LINES) this.#log.shift();
        this.#emit({ type: "log", line });
      },
    });
    this.#proc = proc;
    const startedAt = Date.now();
    const models = await proc.models().catch(() => []);
    this.#set({ phase: "ready", baseUrl: proc.baseUrl, error: undefined, models });
    this.#startPolling();
    void proc.exited.then(() => this.#died(proc, startedAt));
  }

  #died(proc: EngineProcess, startedAt: number): void {
    if (this.#proc !== proc || !this.#wanted) return;
    this.#proc = undefined;
    this.#stopPolling();
    void this.#enqueue(() => this.#restart(Date.now() - startedAt));
  }

  async #restart(livedMs: number): Promise<void> {
    const b = { ...DEFAULT_BACKOFF, ...this.#o.backoff };
    let failures = livedMs >= b.stableMs ? 0 : 1;
    for (;;) {
      if (!this.#wanted) return;
      this.#set({ phase: "restarting", baseUrl: undefined, models: [], restarts: this.#state.restarts + 1 });
      await new Promise((r) => setTimeout(r, Math.min(b.initialMs * 2 ** (failures - 1 < 0 ? 0 : failures - 1), b.maxMs)));
      if (!this.#wanted) return;
      try {
        await this.#launch();
        return;
      } catch (e) {
        failures++;
        if (failures > b.maxFailures) {
          this.#set({ phase: "error", error: `llama-server keeps stopping, so the host gave up after ${b.maxFailures} restarts: ${message(e)}` });
          return;
        }
      }
    }
  }

  async #teardown(): Promise<void> {
    this.#stopPolling();
    const proc = this.#proc;
    this.#proc = undefined;
    await proc?.stop();
  }

  async #refreshModels(): Promise<void> {
    const proc = this.#proc;
    if (proc === undefined) return;
    try {
      const models = await proc.models();
      if (JSON.stringify(models) !== JSON.stringify(this.#state.models)) {
        this.#state = { ...this.#state, models };
        this.#emit({ type: "models", models });
        this.#emit({ type: "state", state: this.#state });
      }
    } catch {
      // the supervisor notices a process that is gone
    }
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#poll = setInterval(() => void this.#refreshModels(), this.#o.pollMs ?? 1000);
    this.#poll.unref();
  }

  #stopPolling(): void {
    if (this.#poll !== undefined) clearInterval(this.#poll);
    this.#poll = undefined;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
