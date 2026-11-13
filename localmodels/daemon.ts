import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  /**
   * The settings file to watch: a change is applied as a reload is. The watch does not rely on the operating system's events alone: it also
   * looks at the file every `pollMs` (default 1000), re-attaches the events when they fail, and says in `settingsError` when the file cannot
   * be read, so a change is never silently missed.
   */
  watch?: { path: string; debounceMs?: number; pollMs?: number } | undefined;
  /**
   * The daemon's own code: when a file under `dirs` (relative to `root`; the `.ts`, `.mjs`, `.js` and `.json` files in them) changes, the
   * daemon stops once the change has settled, and the next session that needs the host starts a new one with the new code.
   */
  codeWatch?: { root: string; dirs: readonly string[]; pollMs?: number; settleMs?: number } | undefined;
  /** Where the daemon says what it is doing (default: nowhere). */
  log?: ((message: string) => void) | undefined;
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
  #unreadable = false;
  #settingsPoll: NodeJS.Timeout | undefined;
  #codePoll: NodeJS.Timeout | undefined;
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
      await this.#watchCode();
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
    clearInterval(this.#settingsPoll);
    clearInterval(this.#codePoll);
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

  /**
   * Apply the settings file when it changes, however it changes. Editors replace files, so the directory is watched, and the file is also
   * looked at on a timer, so a missed or failed event costs a second and not the change. A save that changes nothing is ignored. A file that
   * cannot be read, or does not pass the schema, is `settingsError` (the old settings keep running, and a consumer that asks for the host is
   * told why it is not on the new ones); the next good save clears it.
   */
  async #watchSettings(): Promise<void> {
    const w = this.#o.watch;
    if (w === undefined) return;
    const content = async (): Promise<string | { unreadable: string }> => {
      try {
        return createHash("sha256").update(await readFile(w.path)).digest("hex");
      } catch (e) {
        return { unreadable: e instanceof Error ? e.message : String(e) };
      }
    };
    const first = await content();
    this.#seen = typeof first === "string" ? first : undefined;
    const check = async (): Promise<void> => {
      const now = await content();
      if (typeof now !== "string") {
        const text = `the settings file cannot be read, so the settings that were running still are: ${now.unreadable}`;
        if (!this.#unreadable || this.#settingsError !== text) {
          this.#unreadable = true;
          this.#settingsError = text;
          this.#emit({ type: "settings", error: text });
        }
        return;
      }
      if (now === this.#seen && !this.#unreadable) return;
      this.#unreadable = false;
      this.#seen = now;
      await this.reload();
    };
    let checking = false;
    const run = (): void => {
      if (checking) return;
      checking = true;
      void check().finally(() => (checking = false));
    };
    const attach = (): void => {
      if (this.#watcher !== undefined) return;
      try {
        const watcher = watch(dirname(w.path), (_kind, name) => {
          if (name !== null && name !== basename(w.path)) return;
          clearTimeout(this.#watchTimer);
          this.#watchTimer = setTimeout(run, w.debounceMs ?? 400);
        });
        const lost = (): void => {
          watcher.close();
          if (this.#watcher === watcher) this.#watcher = undefined; // the next tick attaches another
        };
        watcher.on("error", lost);
        watcher.on("close", lost);
        this.#watcher = watcher;
      } catch {
        // the directory cannot be watched now (it may not exist): the timer still looks, and tries again
      }
    };
    attach();
    this.#settingsPoll = setInterval(() => {
      attach();
      run();
    }, w.pollMs ?? 1000);
    this.#settingsPoll.unref();
  }

  /** Stop when the daemon's own code changes (`codeWatch`). */
  async #watchCode(): Promise<void> {
    const w = this.#o.codeWatch;
    if (w === undefined) return;
    let baseline = await sourceSignature(w.root, w.dirs);
    let pending: string | undefined;
    let busy = false;
    this.#codePoll = setInterval(() => {
      if (busy) return;
      busy = true;
      void sourceSignature(w.root, w.dirs)
        .then((now) => {
          if (now === baseline) return void (pending = undefined);
          // a change must hold for a whole tick before we act, so a checkout or a build that is still writing is waited out
          if (pending !== now) return void (pending = now);
          baseline = now;
          this.#o.log?.("the daemon's code changed on disk: stopping, so that the next use starts the new code");
          void this.close();
        })
        .catch(() => undefined)
        .finally(() => (busy = false));
    }, w.pollMs ?? 2000);
    this.#codePoll.unref();
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

/** A fingerprint of the source files under `dirs`: their paths, sizes and modification times. Equal while nothing has been saved. */
export async function sourceSignature(root: string, dirs: readonly string[]): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(path);
      } else if (/\.(ts|mjs|js|json)$/.test(e.name)) {
        const st = await stat(path).catch(() => undefined);
        if (st !== undefined) parts.push(`${path}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  for (const d of dirs) await walk(join(root, d));
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
