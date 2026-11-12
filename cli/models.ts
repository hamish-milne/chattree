import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { Daemon, DaemonRunning } from "../localmodels/daemon.ts";
import { ensureDaemon, findDaemon, launchDetached, DaemonError, type ClientEvent, type DaemonClient } from "../localmodels/client.ts";
import { logFile } from "../localmodels/daemon-files.ts";
import { LocalModelHost } from "../localmodels/host.ts";
import { latestTag, type InstallPlan } from "../localmodels/install.ts";
import { inventory, pruneFiles, type ModelInfo } from "../localmodels/inventory.ts";
import { Lock } from "../localmodels/lock.ts";
import { dataDir } from "../localmodels/plan.ts";
import type { DaemonStatus } from "../localmodels/control.ts";
import { samplingYaml } from "../localmodels/sampling.ts";
import { thisMachine } from "../localmodels/release.ts";
import { CliError, type Io } from "./io.ts";
import { lookupSampling } from "./providers.ts";
import { loadSettings, settingsPath } from "./settings.ts";

/** `chattree models ...` (docs/local-models.md, section 3): the local model host, which runs as a daemon of its own. */

const USAGE = "usage: chattree models start|restart|stop|status|list|info <name>|pull [name...]|rm <name>|prune|logs|update|reload";

export const bytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);

function dataOf(io: Pick<Io, "host" | "env" | "settings">): string {
  const data = dataDir(io.host, io.env, io.settings?.data_dir);
  if (data === undefined) throw new CliError("there is no data directory on this machine", "set data_dir in the settings file, or CHATTREE_DATA");
  return data;
}

function localConfig(io: Pick<Io, "settings">) {
  const config = io.settings?.local_models;
  if (config === undefined) throw new CliError("the settings file has no local_models section", "add one with `chattree settings edit` (docs/local-models.md shows what goes in it)");
  return config;
}

export function describePlan(p: InstallPlan): string {
  const line = (label: string, f: InstallPlan["program"]): string => `  ${label}: ${f.name}${f.size === undefined ? "" : ` (${bytes(f.size)})`}\n    from ${f.url}\n    sha256 ${f.sha256 ?? "(not published; it will be recorded on first fetch)"}`;
  return `llama.cpp ${p.tag} (${p.backend}) is not installed. It will be downloaded and unpacked into ${p.dir}:\n${line("program", p.program)}${p.runtime === undefined ? "" : `\n${line("CUDA runtime", p.runtime)}`}`;
}

function describeStatus(s: DaemonStatus): string {
  const st = s.state;
  const lines = [`model host: ${st.phase}${st.baseUrl === undefined ? "" : ` at ${st.baseUrl}`} (process ${s.pid})`];
  if (st.tag !== undefined) lines.push(`llama.cpp:  ${st.tag}${st.backend === undefined || st.backend === "custom" ? "" : ` (${st.backend})`}`);
  if (st.backendNote !== undefined) lines.push(`backend:    ${st.backendNote}`);
  if (st.restarts > 0) lines.push(`restarts:   ${st.restarts}`);
  for (const m of st.models) lines.push(`  ${m.name.padEnd(24)} ${m.state}${st.ids[m.name] === undefined ? "" : `   ${st.ids[m.name]}`}`);
  if (st.error !== undefined) lines.push(`error: ${st.error}`);
  if (s.settingsError !== undefined) lines.push(`the settings file is not valid, the old settings still run: ${s.settingsError}`);
  if (s.consent !== undefined) lines.push("waiting for you to agree to an installation: `chattree models start`");
  return lines.join("\n");
}

/** Prints what installing and fetching report; shared by a follow of the daemon and a fetch done here. */
function printer(io: Io): (e: ClientEvent) => void {
  const progress = new Map<string, number>();
  const say = (t: string): void => io.err(`${t}\n`);
  const tick = (key: string, label: string, received: number, total: number | undefined): void => {
    const step = total === undefined ? Math.floor(received / 50e6) : Math.floor((received / total) * 10);
    if (progress.get(key) === step) return;
    progress.set(key, step);
    say(`${label}: ${bytes(received)}${total === undefined ? "" : ` of ${bytes(total)}`}`);
  };
  return (e) => {
    if (e.type === "install") {
      if (e.event.type === "release") say(`llama.cpp ${e.event.tag}`);
      else if (e.event.type === "download") tick(`i:${e.event.file}`, `downloading ${e.event.file}`, e.event.received, e.event.total);
      else if (e.event.type === "unpack") say(`unpacking ${e.event.file}`);
      else say(`installed ${e.event.binary}`);
    } else if (e.type === "store") {
      if (e.event.type === "resolve") say(`looking up ${e.event.what} on Hugging Face`);
      else if (e.event.type === "download") tick(`m:${e.event.model}:${e.event.file}`, `downloading ${e.event.model} (${e.event.file})`, e.event.received, e.event.total);
      else if (e.event.type === "have") say(`${e.event.model}: ${e.event.file} is already here`);
      else say(`${e.event.model}: ${e.event.file} done (${bytes(e.event.size)})`);
    }
  };
}

type Action = { kind: "start" | "restart"; yes: boolean } | { kind: "pull"; models: string[]; force: boolean };

/** Ask the daemon to do something and print what happens. Resolves to the exit status when the host is ready, the fetch is done, or it failed. */
async function follow(io: Io, client: DaemonClient, action: Action): Promise<number> {
  const ac = new AbortController();
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finish = resolve));
  const show = printer(io);
  let asked = false;
  let phaseShown = false;
  let leftReady = false;
  const say = (t: string): void => io.err(`${t}\n`);
  let markOpened!: () => void;
  const opened = new Promise<void>((resolve) => (markOpened = resolve));

  const onEvent = (e: ClientEvent): void => {
    if (e.type === "status") markOpened();
    show(e);
    if (e.type === "status" && e.status.consent !== undefined) void askConsent(e.status.consent);
    if (e.type === "consent" && e.plan !== undefined) void askConsent(e.plan);
    if (e.type === "pulled") {
      if (e.error === undefined) {
        say(`fetched ${e.models.join(", ")}`);
        finish(0);
      } else {
        say(`error: ${e.error}`);
        finish(1);
      }
      return;
    }
    if (action.kind === "pull") return;
    const state = e.type === "status" ? e.status.state : e.type === "state" ? e.state : undefined;
    if (state === undefined) return;
    if (state.phase === "starting" && !phaseShown) {
      phaseShown = true;
      if (state.backend !== undefined && state.backend !== "custom") say(`backend: ${state.backend}${state.backendNote === undefined ? "" : ` (${state.backendNote})`}`);
      say("starting llama-server");
    }
    if (state.phase !== "ready" && e.type !== "status") leftReady = true;
    // a restart is over when the host is ready again, not when the status we opened with says it is
    if (state.phase === "ready" && (action.kind !== "restart" || leftReady)) {
      say(`ready at ${state.baseUrl ?? ""}${state.models.length > 0 ? `\nmodels: ${state.models.map((m) => m.name).join(", ")}` : ""}`);
      if (state.error !== undefined) say(`note: ${state.error}`);
      finish(0);
    } else if (e.type !== "status" && state.phase === "error") {
      say(`error: ${state.error ?? "the model host failed"}`);
      finish(1);
    } else if (e.type !== "status" && state.phase === "stopped" && action.kind === "start") finish(1);
    // (the status the stream opens with can still be the end of an earlier start: only what follows our own request counts)
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
    if (action.kind === "pull") await client.pull(action.models, { force: action.force });
    else if (action.kind === "restart") await client.restart({ yes: action.yes });
    else await client.start({ yes: action.yes });
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
  localConfig(io);
  const path = settingsPath(io.host, io.env);
  const daemon = new Daemon({
    data,
    host: { ...thisMachine(), env: io.env },
    watch: path === undefined ? undefined : { path },
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

export interface ModelsOptions {
  yes: boolean;
  force?: boolean | undefined;
  follow?: boolean | undefined;
  lines?: number | undefined;
  fetch?: typeof fetch | undefined;
  launch?: (() => Promise<void>) | undefined;
  /** Another GitHub API address (tests). */
  apiBase?: string | undefined;
  /** Another Hugging Face address (tests). */
  hfBase?: string | undefined;
}

async function readInventory(io: Io, data: string): Promise<ModelInfo[]> {
  const lock = await Lock.open(join(data, "lock.json"));
  return inventory(localConfig(io), lock, data);
}

/** A host that is not started: fetching and deleting files need none of the server, and no daemon should be started for them. */
function idleHost(io: Io, data: string, o: ModelsOptions): LocalModelHost {
  const path = settingsPath(io.host, io.env);
  return new LocalModelHost({ data, config: localConfig(io), baseDir: path === undefined ? data : dirname(path), ...thisMachine(), env: io.env, fetch: o.fetch });
}

function describeModels(models: ModelInfo[], states: Map<string, string>): string {
  if (models.length === 0) return "no models in the settings";
  return models
    .map((m) => {
      const size = m.files.reduce((n, f) => n + f.size, 0);
      const have = m.complete ? `downloaded, ${bytes(size)}` : m.files.length > 0 ? "incomplete" : "not downloaded";
      return `${m.name.padEnd(24)} ${have.padEnd(24)} ${(states.get(m.name) ?? "").padEnd(9)} ${m.source}`;
    })
    .join("\n");
}

export async function runModels(io: Io, args: readonly string[], o: ModelsOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined) throw new CliError(USAGE);
  if (sub === "serve" && rest.length === 0) return await serve(io);
  const data = dataOf(io);
  const need = (n: number): void => {
    if (rest.length !== n) throw new CliError(USAGE);
  };
  const running = async (): Promise<DaemonClient | undefined> => await findDaemon(data, o.fetch);
  const states = async (): Promise<Map<string, string>> => new Map((await (await running())?.status())?.state.models.map((m) => [m.name, m.state]) ?? []);
  try {
    switch (sub) {
      case "status": {
        need(0);
        const client = await running();
        io.out(client === undefined ? "model host: not running\n" : `${describeStatus(await client.status())}\n`);
        return 0;
      }
      case "stop": {
        need(0);
        const client = await running();
        if (client === undefined) return (io.out("the model host is not running\n"), 0);
        await client.stop();
        io.out("the model host is stopping\n");
        return 0;
      }
      case "start":
      case "restart": {
        need(0);
        localConfig(io);
        const client = await ensureDaemon({ data, fetch: o.fetch, launch: o.launch ?? (() => launchDetached(data, io.env)), onLaunch: () => io.err("starting the model host\n") });
        return await follow(io, client, { kind: sub, yes: o.yes });
      }
      case "reload": {
        need(0);
        const client = await running();
        if (client === undefined) return (io.out("the model host is not running; it reads the settings when it starts\n"), 0);
        io.out(`${describeStatus(await client.reload())}\n`);
        return 0;
      }
      case "list": {
        need(0);
        io.out(`${describeModels(await readInventory(io, data), await states())}\n`);
        return 0;
      }
      case "info": {
        need(1);
        const name = rest[0] as string;
        const m = (await readInventory(io, data)).find((x) => x.name === name);
        const cfg = localConfig(io).models[name];
        if (m === undefined || cfg === undefined) throw new CliError(`no model named ${name} in the settings`, "`chattree models list` shows them");
        const state = (await states()).get(name);
        const lines = [`${m.name}${m.id === undefined ? "" : `   ${m.id}`}`, `  source:   ${m.source}`, `  state:    ${state ?? (m.complete ? "downloaded" : "not downloaded")}`];
        for (const f of m.files) lines.push(`  ${f.role === "mmproj" ? "projector" : f.role === "draft" ? "draft" : "file"}:     ${f.dest} (${bytes(f.size)})\n            sha256 ${f.sha256}`);
        const settings = Object.entries(cfg).filter(([k, v]) => v !== undefined && !["url", "hf", "file", "revision", "mmproj", "sha256"].includes(k));
        for (const [k, v] of settings.filter(([k]) => k !== "sampling")) lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
        const found = await lookupSampling(io, name, { fetch: o.fetch, hfBase: o.hfBase, localFile: m.files.find((f) => f.role === "model")?.dest });
        if (found.source === undefined) lines.push("  sampling: none set (the server's own defaults apply)");
        else {
          lines.push(`  sampling: ${Object.entries(found.values).map(([k, v]) => `${k} ${v}`).join(", ")}`, `            from ${found.detail}`);
          if (found.source !== "settings") lines.push("            not in the settings yet: `chattree init` pins it; to fix it here, add", ...samplingYaml(name, found.values).split("\n").map((l) => `              ${l}`));
        }
        for (const n of found.notes) lines.push(`  note: ${n}`);
        io.out(`${lines.join("\n")}\n`);
        return 0;
      }
      case "pull": {
        const names = [...rest];
        const client = await running();
        if (client !== undefined) return await follow(io, client, { kind: "pull", models: names, force: o.force === true });
        const host = idleHost(io, data, o);
        const show = printer(io);
        host.on((e) => (e.type === "store" ? show(e) : undefined));
        try {
          await host.pull(names, { force: o.force === true });
        } catch (e) {
          throw new CliError(e instanceof Error ? e.message : String(e));
        }
        io.err(`fetched ${(names.length > 0 ? names : Object.keys(localConfig(io).models)).join(", ") || "nothing"}\n`);
        return 0;
      }
      case "rm": {
        need(1);
        const name = rest[0] as string;
        const client = await running();
        let r: { files: number; bytes: number; kept: number };
        try {
          r = client !== undefined ? await client.remove(name) : await idleHost(io, data, o).remove(name);
        } catch (e) {
          if (e instanceof DaemonError) throw new CliError(e.message);
          throw new CliError(e instanceof Error ? e.message : String(e));
        }
        io.out(`deleted ${r.files} file${r.files === 1 ? "" : "s"} (${bytes(r.bytes)}) of ${name}${r.kept > 0 ? `; ${r.kept} more stay, since another model uses them` : ""}; it is fetched again when the host starts, while it is in the settings\n`);
        return 0;
      }
      case "prune": {
        need(0);
        if ((await running()) !== undefined) throw new CliError("stop the model host first (`chattree models stop`)");
        const lock = await Lock.open(join(data, "lock.json"));
        const r = await pruneFiles(localConfig(io), lock, data);
        io.out(`deleted ${r.files} file${r.files === 1 ? "" : "s"} (${bytes(r.bytes)}) that no model in the settings uses\n`);
        return 0;
      }
      case "logs": {
        need(0);
        const client = await running();
        const n = o.lines ?? 200;
        if (client === undefined) {
          const text = await readFile(logFile(data), "utf8").catch(() => undefined);
          if (text === undefined) return (io.out("there is no log: the model host has not run\n"), 0);
          io.out(`${text.split("\n").slice(-n - 1).join("\n")}`);
          return 0;
        }
        for (const l of await client.logs(n)) io.out(`${l}\n`);
        if (o.follow !== true) return 0;
        const ac = new AbortController();
        const off = io.onSignal?.(() => ac.abort());
        try {
          await client.events((e) => (e.type === "log" ? io.out(`${e.line}\n`) : undefined), ac.signal);
        } finally {
          off?.();
        }
        return 0;
      }
      case "update": {
        need(0);
        const config = localConfig(io);
        const path = settingsPath(io.host, io.env);
        if (path === undefined) throw new CliError("there is no settings location on this machine");
        let latest: string;
        try {
          latest = await latestTag({ fetch: o.fetch, apiBase: o.apiBase });
        } catch (e) {
          throw new CliError(e instanceof Error ? e.message : String(e));
        }
        const current = config.llama_cpp.tag;
        if (current === latest) return (io.out(`llama.cpp ${latest} is the newest\n`), 0);
        io.out(`the newest llama.cpp is ${latest}; the settings have ${current ?? "no tag"}\n`);
        let ok = o.yes;
        if (!ok && io.ask !== undefined) ok = ["y", "yes"].includes((await io.ask(`set local_models.llama_cpp.tag to ${latest} in ${path}? (y/N)`, "n")).toLowerCase());
        if (!ok) {
          io.out(`not changed: set llama_cpp.tag to ${latest} yourself, or run with -y\n`);
          return 1;
        }
        const doc = parseDocument(await readFile(path, "utf8"));
        doc.setIn(["local_models", "llama_cpp", "tag"], latest);
        await io.host.fs.writeAtomic(path, new TextEncoder().encode(String(doc)));
        io.out(`set llama_cpp.tag to ${latest}. A running model host applies it and asks before downloading; otherwise \`chattree models start\` does\n`);
        return 0;
      }
      default:
    }
  } catch (e) {
    if (e instanceof DaemonError) throw new CliError(e.message);
    throw e;
  }
  throw new CliError(`models ${sub} is not a command`, USAGE);
}

/**
 * Make sure the model host is up before a request that needs it: what `chattree models start` does, with the same progress and the same
 * question before installing llama.cpp. Quick when the host is ready already.
 */
export async function ensureLocalModels(io: Io, o: Partial<ModelsOptions> = {}): Promise<void> {
  const data = dataOf(io);
  localConfig(io);
  const client = await findDaemon(data, o.fetch);
  if (client !== undefined && (await client.status()).state.phase === "ready") return;
  const code = await runModels(io, ["start"], { yes: o.yes === true, fetch: o.fetch, launch: o.launch });
  if (code !== 0) throw new CliError("the local model host is not running", "`chattree models status` shows why; `chattree models start -y` agrees to installing llama.cpp without asking");
}
