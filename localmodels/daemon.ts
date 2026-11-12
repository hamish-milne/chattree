import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { LocalModels } from "./config.ts";
import { ControlServer, type ControlTarget, type DaemonEvent, type DaemonStatus } from "./control.ts";
import { acquireLock, releaseLock, removeInfo, writeInfo } from "./daemon-files.ts";
import { LocalModelHost, type HostOptions } from "./host.ts";
import type { InstallPlan } from "./install.ts";

/**
 * The daemon (docs/local-models.md, section 3): one process per data directory that owns the host and serves the control API. Sessions
 * start it and never stop it; `chattree models stop` does. It outlives the session that started it, and a session that comes later
 * finds it through the state file.
 */

export interface SettingsSnapshot {
  config: LocalModels;
  /** Relative chat template paths are relative to this. */
  baseDir: string;
}

export interface DaemonOptions {
  data: string;
  /** Read the settings now. Called at start and on a reload; a rejection is the reason shown to the user. */
  loadSettings: () => Promise<SettingsSnapshot>;
  host: Omit<HostOptions, "data" | "config" | "baseDir" | "confirm">;
  /** The settings file to watch: a change is applied as a reload is. */
  watch?: { path: string; debounceMs?: number } | undefined;
  /** How often to look at whether the host has been idle long enough to exit. */
  idleCheckMs?: number | undefined;
  /** How long a minute is for `idle_exit_minutes` (tests make it short). */
  idleMinuteMs?: number | undefined;
}

export class DaemonRunning extends Error {
  override name = "DaemonRunning";
}

export class Daemon implements ControlTarget {
  readonly #o: DaemonOptions;
  readonly #listeners = new Set<(e: DaemonEvent) => void>();
  readonly #startedAt = Date.now();
  #host: LocalModelHost | undefined;
  #control: ControlServer | undefined;
  #consent: { plan: InstallPlan; answer: (accept: boolean) => void } | undefined;
  #yes = false;
  #settingsError: string | undefined;
  #watcher: FSWatcher | undefined;
  #watchTimer: NodeJS.Timeout | undefined;
  #seen: string | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #stopped!: () => void;
  readonly done = new Promise<void>((resolve) => (this.#stopped = resolve));

  constructor(o: DaemonOptions) {
    this.#o = o;
  }

  /** Take the lock, read the settings, serve the API and write the state file. Throws `DaemonRunning` when another daemon has the lock. */
  async open(): Promise<{ port: number }> {
    if (!(await acquireLock(this.#o.data))) throw new DaemonRunning("a model host is already running for this data directory");
    try {
      const snap = await this.#o.loadSettings();
      this.#host = new LocalModelHost({ ...this.#o.host, data: this.#o.data, config: snap.config, baseDir: snap.baseDir, confirm: (plan) => this.#ask(plan) });
      this.#host.on((e) => this.#emit(e));
      this.#control = new ControlServer(this);
      const port = await this.#control.listen();
      this.#host.on((e) => {
        if (e.type === "state" && (e.state.phase === "ready" || e.state.phase === "error")) this.#yes = false; // a yes is for the start it was given with
      });
      await this.#watchSettings();
      this.#watchIdle();
      await writeInfo(this.#o.data, { pid: process.pid, port, token: this.#control.token, startedAt: this.#startedAt });
      return { port };
    } catch (e) {
      await this.#control?.close();
      await releaseLock(this.#o.data);
      throw e;
    }
  }

  status(): DaemonStatus {
    return { pid: process.pid, startedAt: this.#startedAt, state: (this.#host as LocalModelHost).state, consent: this.#consent?.plan, settingsError: this.#settingsError };
  }

  subscribe(listener: (e: DaemonEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  logs(lines: number): string[] {
    return (this.#host as LocalModelHost).logs(lines);
  }

  /** Begin starting the host; progress is in the events. A failure is in the state (`error`), not thrown here. */
  start(opts: { yes: boolean }): void {
    this.#yes = opts.yes;
    void (this.#host as LocalModelHost).start().catch(() => undefined);
  }

  /** Stop the server and start it again with the settings as they are now. */
  restart(opts: { yes: boolean }): void {
    const host = this.#host as LocalModelHost;
    this.#yes = opts.yes;
    void host.stop().then(() => host.start()).catch(() => undefined);
  }

  pull(models: string[], force: boolean): void {
    void (this.#host as LocalModelHost).pull(models, { force }).catch(() => undefined);
  }

  remove(model: string): Promise<{ files: number; bytes: number; kept: number }> {
    return (this.#host as LocalModelHost).remove(model);
  }

  /** Stop the host and the process. */
  stop(): void {
    void this.close();
  }

  async close(): Promise<void> {
    this.#watcher?.close();
    clearTimeout(this.#watchTimer);
    clearInterval(this.#idleTimer);
    this.#consent?.answer(false);
    await this.#host?.stop().catch(() => undefined);
    await removeInfo(this.#o.data);
    await this.#control?.close();
    await releaseLock(this.#o.data);
    this.#stopped();
  }

  async reload(): Promise<DaemonStatus> {
    try {
      const snap = await this.#o.loadSettings();
      this.#settingsError = undefined;
      await (this.#host as LocalModelHost).apply(snap.config);
    } catch (e) {
      this.#settingsError = e instanceof Error ? e.message : String(e);
    }
    this.#emit({ type: "settings", error: this.#settingsError });
    return this.status();
  }

  consent(accept: boolean): boolean {
    const c = this.#consent;
    if (c === undefined) return false;
    c.answer(accept);
    return true;
  }

  load(model: string): Promise<void> {
    return (this.#host as LocalModelHost).load(model);
  }

  unload(model: string): Promise<void> {
    return (this.#host as LocalModelHost).unload(model);
  }

  /** Apply the settings file when it changes. Editors replace files, so the directory is watched; a save that changes nothing is ignored. */
  async #watchSettings(): Promise<void> {
    const w = this.#o.watch;
    if (w === undefined) return;
    const content = async (): Promise<string | undefined> => {
      const text = await readFile(w.path).catch(() => undefined);
      return text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
    };
    this.#seen = await content();
    try {
      this.#watcher = watch(dirname(w.path), (_kind, name) => {
        if (name !== null && name !== basename(w.path)) return;
        clearTimeout(this.#watchTimer);
        this.#watchTimer = setTimeout(() => {
          void content().then((now) => {
            if (now === undefined || now === this.#seen) return;
            this.#seen = now;
            return this.reload();
          });
        }, w.debounceMs ?? 400);
      });
      this.#watcher.on("error", () => undefined);
    } catch {
      // a directory that cannot be watched: `models reload` still works
    }
  }

  /** `server.idle_exit_minutes`: exit when no model is in memory and nothing has used the control API, with no session attached, for that long. */
  #watchIdle(): void {
    this.#idleTimer = setInterval(() => {
      const minutes = (this.#host as LocalModelHost).config.server.idle_exit_minutes;
      const control = this.#control as ControlServer;
      if (minutes === undefined || control.streams > 0 || this.#consent !== undefined) return;
      const state = (this.#host as LocalModelHost).state;
      if (state.models.some((m) => m.state === "loaded" || m.state === "loading")) {
        control.touch();
        return;
      }
      if (state.phase !== "ready" && state.phase !== "idle" && state.phase !== "stopped" && state.phase !== "error") return;
      if (Date.now() - control.lastActivity >= minutes * (this.#o.idleMinuteMs ?? 60_000)) void this.close();
    }, this.#o.idleCheckMs ?? 30_000);
    this.#idleTimer.unref();
  }

  async #ask(plan: InstallPlan): Promise<boolean> {
    if (this.#yes) return true;
    const answer = await new Promise<boolean>((resolve) => {
      this.#consent = { plan, answer: resolve };
      this.#emit({ type: "consent", plan });
    });
    this.#consent = undefined;
    this.#emit({ type: "consent", plan: undefined });
    return answer;
  }

  #emit(e: DaemonEvent): void {
    for (const l of this.#listeners) {
      try {
        l(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }
}
