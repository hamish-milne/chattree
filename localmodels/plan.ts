import type { Host } from "../src/host.ts";
import { hfUrl, modelSource, type LocalModels, type ModelEntry, type Sampling } from "./config.ts";

/**
 * From settings to what the host has to do (docs/local-models.md, section 6): the files to have, the preset file and the arguments
 * that start llama-server in router mode. Pure and deterministic, so the same settings always give the same preset, which is how
 * the host knows whether a change needs a restart.
 */

type PathApi = Pick<Host["path"], "join">;

/** Where the data is kept: settings, then `CHATTREE_DATA`, then the user's data directory. */
export function dataDir(
  host: Pick<Host, "platform" | "path">,
  env: Readonly<Record<string, string | undefined>>,
  configured: string | undefined,
): string | undefined {
  if (configured !== undefined) return host.path.resolve(configured);
  const set = env["CHATTREE_DATA"];
  if (set !== undefined && set !== "") return host.path.resolve(set);
  const home = env["HOME"] === undefined || env["HOME"] === "" ? undefined : env["HOME"];
  const base = host.platform === "windows" ? env["LOCALAPPDATA"] : (env["XDG_DATA_HOME"] ?? (home === undefined ? undefined : host.path.join(home, ".local", "share")));
  return base === undefined || base === "" ? undefined : host.path.join(base, "chattree");
}

export interface Download {
  /** The model's name in the settings. */
  model: string;
  role: "model" | "mmproj";
  /** The address to fetch from; undefined while a Hugging Face quantisation has still to be resolved to a file. */
  url: string | undefined;
  file: string | undefined;
  sha256: string | undefined;
  /** The size, when it is known beforehand. */
  size?: number | undefined;
  /** The model's directory; files are kept in it. */
  dir: string;
  /** Where it is kept once downloaded. Undefined with `file`. */
  dest: string | undefined;
  /** What the downloader must ask Hugging Face before it can fetch: the repository and quantisation to find the file of. */
  resolve?: { repo: string; revision: string; quant: string | undefined };
}

export interface PlanIssue {
  model: string;
  message: string;
}

export const modelDir = (path: PathApi, data: string, model: string): string => path.join(data, "models", model);

/** The files the settings call for, in model order. A model that cannot be fetched (a URL that is not a GGUF file) is an issue, not a download. */
export function downloadList(config: LocalModels, path: PathApi, data: string): { downloads: Download[]; issues: PlanIssue[] } {
  const downloads: Download[] = [];
  const issues: PlanIssue[] = [];
  for (const model of Object.keys(config.models).sort()) {
    const m = config.models[model] as ModelEntry;
    const dir = modelDir(path, data, model);
    const source = modelSource(m);
    if (source === undefined) {
      issues.push({ model, message: "the url does not end in a .gguf file name; use hf, or a url that names the file" });
      continue;
    }
    if (source.kind === "hf-quant") {
      downloads.push({ model, role: "model", url: undefined, file: undefined, sha256: m.sha256, dir, dest: undefined, resolve: { repo: source.repo, revision: source.revision, quant: source.quant } });
    } else {
      const url = source.kind === "url" ? source.url : hfUrl(source.repo, source.revision, source.file);
      downloads.push({ model, role: "model", url, file: source.file, sha256: m.sha256, dir, dest: path.join(dir, source.file.split("/").at(-1) as string) });
    }
    const p = m.mmproj;
    if (p !== undefined) {
      if (p.url !== undefined) {
        const file = decodeURIComponent(new URL(p.url).pathname.split("/").filter((s) => s !== "").at(-1) ?? "");
        downloads.push({ model, role: "mmproj", url: p.url, file, sha256: p.sha256, dir, dest: path.join(dir, file) });
      } else if (source.kind !== "url") {
        const file = p.file as string;
        downloads.push({ model, role: "mmproj", url: hfUrl(source.repo, source.revision, file), file, sha256: p.sha256, dir, dest: path.join(dir, file.split("/").at(-1) as string) });
      }
    }
  }
  return { downloads, issues };
}

// ---- the preset file -------------------------------------------------------------------------------------------

const SAMPLING_KEYS: Readonly<Record<keyof Sampling, string>> = {
  temperature: "temp",
  top_p: "top-p",
  top_k: "top-k",
  min_p: "min-p",
  repeat_penalty: "repeat-penalty",
  presence_penalty: "presence-penalty",
  frequency_penalty: "frequency-penalty",
};

const PARAM_KEYS = {
  ctx_size: "ctx-size",
  n_gpu_layers: "n-gpu-layers",
  flash_attn: "flash-attn",
  threads: "threads",
  parallel: "parallel",
  jinja: "jinja",
  cache_type_k: "cache-type-k",
  cache_type_v: "cache-type-v",
  sleep_idle_seconds: "sleep-idle-seconds",
} as const;

type Params = Partial<Record<keyof typeof PARAM_KEYS, string | number | boolean>> & { options?: Record<string, string | number | boolean> | undefined };

function paramLines(p: Params): [string, string | number | boolean][] {
  const out: [string, string | number | boolean][] = [];
  for (const k of Object.keys(PARAM_KEYS) as (keyof typeof PARAM_KEYS)[]) {
    const v = p[k];
    if (v !== undefined) out.push([PARAM_KEYS[k], v]);
  }
  for (const k of Object.keys(p.options ?? {}).sort()) out.push([k, (p.options as Record<string, string | number | boolean>)[k] as string | number | boolean]);
  return out;
}

export interface ModelFiles {
  /** The model file's path. */
  file: string;
  mmproj?: string;
  /** The chat template file, as a path. */
  template?: string;
}

const ini = (v: string | number | boolean): string => {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error("a preset value cannot contain a line break");
  return s;
};

/**
 * The router's preset file. `version = 1`, `[*]` for what every model shares, then one section per model by name. Sampling goes in as
 * the server's defaults for that model; the agent setup pins them again per call (docs/local-models.md, section 7). A model's aliases are
 * not written: the provider resolves them before it asks the server.
 */
export function presetIni(config: LocalModels, files: Readonly<Record<string, ModelFiles>>): string {
  const lines: string[] = ["version = 1", ""];
  const shared = paramLines(config.defaults as Params);
  lines.push("[*]");
  for (const [k, v] of shared) lines.push(`${k} = ${ini(v)}`);
  for (const model of Object.keys(config.models).sort()) {
    const m = config.models[model] as ModelEntry;
    const f = files[model];
    if (f === undefined) continue;
    lines.push("", `[${model}]`, `model = ${ini(f.file)}`);
    if (f.mmproj !== undefined) lines.push(`mmproj = ${ini(f.mmproj)}`);
    if (f.template !== undefined) lines.push(`chat-template-file = ${ini(f.template)}`);
    for (const [k, v] of paramLines(m as Params)) lines.push(`${k} = ${ini(v)}`);
    const s = (m.sampling ?? {}) as Sampling;
    for (const k of Object.keys(SAMPLING_KEYS) as (keyof Sampling)[]) if (s[k] !== undefined) lines.push(`${SAMPLING_KEYS[k]} = ${ini(s[k] as number)}`);
    if (m.load_on_startup !== undefined) lines.push(`load-on-startup = ${ini(m.load_on_startup)}`);
    if (m.embeddings === true) lines.push("embeddings = true");
  }
  return `${lines.join("\n")}\n`;
}

/** The arguments that start llama-server in router mode. `port` is the number the host settled on when the setting is `auto`. */
export function routerArgs(config: LocalModels, presetPath: string, port: number): string[] {
  const s = config.server;
  const args = ["--models-preset", presetPath, "--host", s.host, "--port", String(port), "--models-max", String(s.models_max)];
  if (!s.webui) args.push("--no-webui");
  return args;
}
