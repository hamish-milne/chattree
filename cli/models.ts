import { dirname } from "node:path";
import { Daemon, DaemonRunning } from "../localmodels/daemon.ts";
import { ensureDaemon, findDaemon, launchDetached, DaemonError, type ClientEvent, type DaemonClient } from "../localmodels/client.ts";
import { dataDir } from "../localmodels/plan.ts";
import type { DaemonStatus } from "../localmodels/control.ts";
import type { InstallPlan } from "../localmodels/install.ts";
import { thisMachine } from "../localmodels/release.ts";
import { CliError, type Io } from "./io.ts";
import { loadSettings, settingsPath } from "./settings.ts";

/** `chattree models ...` (docs/local-models.md, section 3): the local model host, which runs as a daemon of its own. */

const USAGE = "usage: chattree models start|stop|status|serve";

export const bytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`);

function dataOf(io: Pick<Io, "host" | "env" | "settings">): string {
  const data = dataDir(io.host, io.env, io.settings?.data_dir);
  if (data === undefined) throw new CliError("there is no data directory on this machine", "set data_dir in the settings file, or CHATTREE_DATA");
  return data;
}

function requireLocal(io: Pick<Io, "settings">): void {
  if (io.settings?.local_models === undefined) throw new CliError("the settings file has no local_models section", "add one with `chattree settings edit` (docs/local-models.md shows what goes in it)");
}

export function describePlan(p: InstallPlan): string {
  const line = (label: string, f: InstallPlan["program"]): string => `  ${label}: ${f.name}${f.size === undefined ? "" : ` (${bytes(f.size)})`}\n    from ${f.url}\n    sha256 ${f.sha256 ?? "(not published; it will be recorded on first fetch)"}`;
  return `llama.cpp ${p.tag} (${p.backend}) is not installed. It will be downloaded and unpacked into ${p.dir}:\n${line("program", p.program)}${p.runtime === undefined ? "" : `\n${line("CUDA runtime", p.runtime)}`}`;
}

function describeStatus(s: DaemonStatus): string {
  const st = s.state;
  const lines = [`model host: ${st.phase}${st.baseUrl === undefined ? "" : ` at ${st.baseUrl}`} (process ${s.pid})`];
  if (st.tag !== undefined) lines.push(`llama.cpp:  ${st.tag}`);
  if (st.restarts > 0) lines.push(`restarts:   ${st.restarts}`);
  for (const m of st.models) lines.push(`  ${m.name.padEnd(24)} ${m.state}${st.ids[m.name] === undefined ? "" : `   ${st.ids[m.name]}`}`);
  if (st.error !== undefined) lines.push(`error: ${st.error}`);
  if (s.settingsError !== undefined) lines.push(`the settings file is not valid, the old settings still run: ${s.settingsError}`);
  if (s.consent !== undefined) lines.push("waiting for you to agree to an installation: `chattree models start`");
  return lines.join("\n");
}

/** Print what the daemon reports while it starts. Resolves to the exit status when the host is ready or has failed. */
async function follow(io: Io, client: DaemonClient, yes: boolean): Promise<number> {
  const ac = new AbortController();
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finish = resolve));
  const progress = new Map<string, number>();
  let asked = false;

  const say = (t: string): void => io.err(`${t}\n`);
  const tick = (key: string, label: string, received: number, total: number | undefined): void => {
    const step = total === undefined ? Math.floor(received / 50e6) : Math.floor((received / total) * 10);
    if (progress.get(key) === step) return;
    progress.set(key, step);
    say(`${label}: ${bytes(received)}${total === undefined ? "" : ` of ${bytes(total)}`}`);
  };

  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => (markOpened = resolve));
  const onEvent = (e: ClientEvent): void => {
    if (e.type === "status") markOpened();
    const state = e.type === "status" ? e.status.state : e.type === "state" ? e.state : undefined;
    if (e.type === "status" && e.status.consent !== undefined) void askConsent(e.status.consent);
    switch (e.type) {
      case "consent":
        if (e.plan !== undefined) void askConsent(e.plan);
        break;
      case "install":
        if (e.event.type === "release") say(`llama.cpp ${e.event.tag}`);
        else if (e.event.type === "download") tick(`i:${e.event.file}`, `downloading ${e.event.file}`, e.event.received, e.event.total);
        else if (e.event.type === "unpack") say(`unpacking ${e.event.file}`);
        else say(`installed ${e.event.binary}`);
        break;
      case "store":
        if (e.event.type === "resolve") say(`looking up ${e.event.what} on Hugging Face`);
        else if (e.event.type === "download") tick(`m:${e.event.model}:${e.event.file}`, `downloading ${e.event.model} (${e.event.file})`, e.event.received, e.event.total);
        else if (e.event.type === "have") say(`${e.event.model}: ${e.event.file} is already here`);
        else say(`${e.event.model}: ${e.event.file} done (${bytes(e.event.size)})`);
        break;
      default:
    }
    if (state === undefined) return;
    if (state.phase === "starting" && progress.get("phase") !== 1) (progress.set("phase", 1), say("starting llama-server"));
    if (state.phase === "ready") {
      say(`ready at ${state.baseUrl ?? ""}${state.models.length > 0 ? `\nmodels: ${state.models.map((m) => m.name).join(", ")}` : ""}`);
      if (state.error !== undefined) say(`note: ${state.error}`);
      finish(0);
    } else if (e.type !== "status" && state.phase === "error") {
      say(`error: ${state.error ?? "the model host failed"}`);
      finish(1);
    } else if (e.type !== "status" && state.phase === "stopped") finish(1);
    // (the status the stream opens with can still be the end of an earlier start: only what follows our own start counts)
  };

  async function askConsent(plan: InstallPlan): Promise<void> {
    if (asked) return;
    asked = true;
    say(describePlan(plan));
    const yesNo = io.ask === undefined ? "n" : (await io.ask("install it? (y/N)", "n")).toLowerCase();
    const ok = yesNo === "y" || yesNo === "yes";
    if (!ok && io.ask === undefined) say("there is no terminal to ask on: run `chattree models start -y` to agree");
    await client.consent(ok).catch(() => undefined);
  }

  const off = io.onSignal?.(() => {
    say("the model host keeps working in the background; `chattree models status` shows it");
    finish(130);
  });
  const stream = client.events(onEvent, ac.signal).then(
    () => {
      if (!ac.signal.aborted) say("error: the connection to the model host ended");
      finish(1);
    },
    (e: unknown) => {
      say(`error: ${e instanceof Error ? e.message : String(e)}`);
      finish(1);
    },
  );
  try {
    await Promise.race([opened, done]);
    await client.start({ yes });
    return await done;
  } finally {
    off?.();
    ac.abort();
    await stream;
  }
}

/** Run the daemon in this process until it is stopped (what a detached start runs). */
export async function serve(io: Io): Promise<number> {
  const data = dataOf(io);
  requireLocal(io);
  const path = settingsPath(io.host, io.env);
  const daemon = new Daemon({
    data,
    host: { ...thisMachine(), env: io.env },
    loadSettings: async () => {
      const s = await loadSettings(io);
      if (s.local_models === undefined) throw new CliError("the settings file has no local_models section");
      return { config: s.local_models, baseDir: path === undefined ? data : dirname(path) };
    },
  });
  try {
    const { port } = await daemon.open();
    io.out(`model host serving its control API on 127.0.0.1:${port} (process ${process.pid})\n`);
  } catch (e) {
    if (e instanceof DaemonRunning) {
      io.out("a model host is already running\n");
      return 0;
    }
    throw e;
  }
  const off = io.onSignal?.(() => void daemon.close());
  try {
    await daemon.done;
  } finally {
    off?.();
  }
  return 0;
}

export async function runModels(io: Io, args: readonly string[], o: { yes: boolean; fetch?: typeof fetch | undefined; launch?: (() => Promise<void>) | undefined }): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || rest.length > 0) throw new CliError(USAGE);
  if (sub === "serve") return await serve(io);
  const data = dataOf(io);
  try {
    if (sub === "status") {
      const client = await findDaemon(data, o.fetch);
      if (client === undefined) {
        io.out("model host: not running\n");
        return 0;
      }
      io.out(`${describeStatus(await client.status())}\n`);
      return 0;
    }
    if (sub === "stop") {
      const client = await findDaemon(data, o.fetch);
      if (client === undefined) {
        io.out("the model host is not running\n");
        return 0;
      }
      await client.stop();
      io.out("the model host is stopping\n");
      return 0;
    }
    if (sub === "start") {
      requireLocal(io);
      const client = await ensureDaemon({ data, fetch: o.fetch, launch: o.launch ?? (() => launchDetached(data, io.env)), onLaunch: () => io.err("starting the model host\n") });
      return await follow(io, client, o.yes);
    }
  } catch (e) {
    if (e instanceof DaemonError) throw new CliError(e.message);
    throw e;
  }
  throw new CliError(`models ${sub} is not a command`, USAGE);
}
