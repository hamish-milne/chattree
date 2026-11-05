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

  /** Stop the host and the process. */
  stop(): void {
    void this.close();
  }

  async close(): Promise<void> {
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
