import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalModels } from "./config.ts";
import { downloadFile } from "./download.ts";
import { Lock, LockError } from "./lock.ts";
import { fetchJson, type FetchFn } from "./net.ts";
import { findGpu, type GpuFinding } from "./gpu.ts";
import { isBuildTag, resolveBackend, resolveVersionTag, selectAsset, type Arch, type Platform, type ReleaseAsset } from "./release.ts";

/**
 * llama.cpp, fetched and unpacked (docs/local-models.md, section 5). Installing a program is a consent step: the caller is told the tag, the
 * files, their sizes and hashes before anything is downloaded. There is no implicit "latest": the settings name a tag.
 */

export class InstallError extends Error {
  override name = "InstallError";
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export class InstallDeclined extends Error {
  override name = "InstallDeclined";
}

export interface PlannedFile {
  name: string;
  url: string;
  size: number | undefined;
  sha256: string | undefined;
}

export interface InstallPlan {
  /** The build the settings' tag led to. */
  tag: string;
  backend: string;
  program: PlannedFile;
  runtime: PlannedFile | undefined;
  /** Where it will be installed. */
  dir: string;
}

export type InstallEvent =
  | { type: "release"; tag: string }
  | { type: "download"; file: string; received: number; total: number | undefined }
  | { type: "unpack"; file: string }
  | { type: "installed"; binary: string };

export interface InstallDeps {
  fetch?: FetchFn | undefined;
  /** The GitHub API address (tests). */
  apiBase?: string | undefined;
  /** Unpack an archive into a directory. Default: `tar`, which reads `.tar.gz` everywhere and `.zip` on Windows and macOS. */
  unpack?: ((archive: string, into: string) => Promise<void>) | undefined;
  /** Run the program to see that it starts. Default: `llama-server --version`. Resolves to the problem, or undefined when it is fine. */
  verify?: ((binary: string) => Promise<string | undefined>) | undefined;
}

export interface InstallOptions {
  data: string;
  config: LocalModels["llama_cpp"];
  platform: Platform;
  arch: Arch;
  lock: Lock;
  /** Asked before anything is downloaded; false is `InstallDeclined`. Without it the install goes ahead (the caller has already agreed, `-y`). */
  confirm?: ((plan: InstallPlan) => Promise<boolean>) | undefined;
  onEvent?: ((e: InstallEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
  deps?: InstallDeps | undefined;
  /** Look for a GPU when the backend is `auto` (default: `nvidia-smi`). */
  findGpu?: (() => Promise<GpuFinding>) | undefined;
}

export interface Installed {
  binary: string;
  tag: string;
  dir: string;
  /** The backend of this build, and for `auto` what led to it. */
  backend: string;
  backendNote: string | undefined;
}

const run = promisify(execFile);
const installDir = (data: string, tag: string, backend: string, cuda: string | undefined): string => join(data, "llama.cpp", `${tag}-${backend}${backend === "cuda" && cuda !== undefined ? `-${cuda}` : ""}`);
const exe = (platform: Platform): string => (platform === "windows" ? "llama-server.exe" : "llama-server");

const nodeUnpack = async (archive: string, into: string): Promise<void> => {
  try {
    await run("tar", ["-xf", archive, "-C", into]);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new InstallError(`tar could not unpack ${archive}: ${(err.stderr ?? err.message).trim()}`, "chattree needs a tar that reads this archive format (Windows 10 and later, macOS and Linux have one)");
  }
};

const nodeVerify = async (binary: string): Promise<string | undefined> => {
  try {
    await run(binary, ["--version"], { timeout: 30_000 });
    return undefined;
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return (err.stderr ?? err.message).trim().split("\n").slice(-3).join("\n");
  }
};

async function find(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await find(p, name);
      if (hit !== undefined) return hit;
    } else if (e.name === name) return p;
  }
  return undefined;
}

interface Release {
  body: string;
  assets: ReleaseAsset[];
}

async function getRelease(tag: string, d: InstallDeps, signal: AbortSignal | undefined): Promise<Release> {
  const base = d.apiBase ?? "https://api.github.com";
  let json: unknown;
  try {
    json = await fetchJson(`${base}/repos/ggml-org/llama.cpp/releases/tags/${encodeURIComponent(tag)}`, { fetch: d.fetch, signal, headers: { "x-github-api-version": "2022-11-28" } });
  } catch (e) {
    throw new InstallError(`could not read the llama.cpp release ${tag}: ${e instanceof Error ? e.message : String(e)}`, "check the tag in local_models.llama_cpp.tag, or set llama_cpp.path to a llama-server you have");
  }
  const r = json as { body?: unknown; assets?: unknown };
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  return {
    body: typeof r.body === "string" ? r.body : "",
    assets: assets.flatMap((a) =>
      typeof a["name"] === "string" && typeof a["browser_download_url"] === "string"
        ? [
            {
              name: a["name"],
              url: a["browser_download_url"],
              size: typeof a["size"] === "number" ? a["size"] : undefined,
              sha256: typeof a["digest"] === "string" && a["digest"].startsWith("sha256:") ? a["digest"].slice(7).toLowerCase() : undefined,
            },
          ]
        : [],
    ),
  };
}

const planned = (a: ReleaseAsset): PlannedFile => ({ name: a.name, url: a.url, size: a.size, sha256: a.sha256 });

/** The llama-server to run: the configured `path`, one already installed for this tag and backend, or the release's, downloaded and unpacked. */
export async function ensureLlamaServer(o: InstallOptions): Promise<Installed> {
  const c = o.config;
  const deps = o.deps ?? {};
  if (c.path !== undefined) {
    if ((await stat(c.path).catch(() => undefined))?.isFile() !== true) throw new InstallError(`llama_cpp.path ${c.path} is not a file`, "point it at a llama-server binary, or remove it to have chattree fetch one");
    return { binary: c.path, tag: "custom", dir: join(c.path, ".."), backend: "custom", backendNote: undefined };
  }
  if (c.tag === undefined) throw new InstallError("local_models.llama_cpp.tag is not set, so there is no llama.cpp to run", "set it to a release such as b12110 or v0.9.0 (chattree never picks the latest on its own), or set llama_cpp.path");
  let gpu: GpuFinding | undefined;
  if (c.backend === "auto" && o.platform !== "macos") gpu = await (o.findGpu ?? findGpu)();
  const backend = resolveBackend(c.backend, o.platform, gpu?.backend);
  const backendNote = c.backend === "auto" ? (o.platform === "macos" ? "Metal, the Mac's GPU" : gpu?.note) : undefined;

  // already installed? then the network is not needed (a version tag is remembered as the build it led to)
  const known = isBuildTag(c.tag) ? c.tag : o.lock.quant(`llama-tag:${c.tag}`)?.[0];
  if (known !== undefined) {
    const dir = installDir(o.data, known, backend, c.cuda);
    const rel = (await readFile(join(dir, "binary.txt"), "utf8").catch(() => undefined))?.trim();
    if (rel !== undefined) {
      const binary = join(dir, rel);
      if ((await stat(binary).catch(() => undefined))?.isFile() === true) return { binary, tag: known, dir, backend, backendNote };
    }
  }

  let tag = c.tag;
  let release: Release;
  if (isBuildTag(tag)) release = await getRelease(tag, deps, o.signal);
  else {
    const versionRelease = await getRelease(tag, deps, o.signal);
    const r = resolveVersionTag(tag, versionRelease.body);
    if (!r.ok) throw new InstallError(r.error);
    o.lock.setQuant(`llama-tag:${tag}`, [r.tag]);
    tag = r.tag;
    release = await getRelease(tag, deps, o.signal);
  }
  o.onEvent?.({ type: "release", tag });
  const sel = selectAsset(release.assets, { platform: o.platform, arch: o.arch, backend: c.backend, cuda: c.cuda, gpu: gpu?.backend });
  if (!sel.ok) throw new InstallError(`llama.cpp ${tag}: ${sel.error}`, "choose another backend or tag in local_models.llama_cpp");
  const { program, runtime } = sel.selection;
  const dir = installDir(o.data, tag, backend, c.cuda);

  for (const f of [program, runtime]) {
    if (f === undefined) continue;
    const locked = o.lock.file(`llama/${f.name}`);
    if (locked !== undefined && f.sha256 !== undefined && locked.sha256 !== f.sha256) throw new LockError(`${f.name} has a different hash than when it was first fetched (${locked.sha256} then, ${f.sha256} now); it was not installed`);
  }
  const plan: InstallPlan = { tag, backend, program: planned(program), runtime: runtime === undefined ? undefined : planned(runtime), dir };
  if (o.confirm !== undefined && !(await o.confirm(plan))) throw new InstallDeclined(`llama.cpp ${tag} was not installed`);

  await mkdir(join(o.data, "downloads"), { recursive: true });
  const work = await mkdtemp(join(o.data, "downloads", "unpack-"));
  try {
    const unpack = deps.unpack ?? nodeUnpack;
    const fetched: string[] = [];
    for (const f of [program, runtime]) {
      if (f === undefined) continue;
      const dest = join(o.data, "downloads", f.name);
      const got = await downloadFile({
        url: f.url,
        dest,
        sha256: f.sha256 ?? o.lock.file(`llama/${f.name}`)?.sha256,
        size: f.size,
        fetch: deps.fetch,
        signal: o.signal,
        onProgress: (p) => o.onEvent?.({ type: "download", file: f.name, received: p.received, total: p.total }),
      });
      o.lock.setFile(`llama/${f.name}`, { sha256: got.sha256, size: got.size });
      fetched.push(dest);
    }
    const into = join(work, "program");
    await mkdir(into);
    o.onEvent?.({ type: "unpack", file: program.name });
    await unpack(fetched[0] as string, into);
    const found = await find(into, exe(o.platform));
    if (found === undefined) throw new InstallError(`${program.name} has no ${exe(o.platform)} in it`);
    if (runtime !== undefined) {
      const rt = join(work, "runtime");
      await mkdir(rt);
      o.onEvent?.({ type: "unpack", file: runtime.name });
      await unpack(fetched[1] as string, rt);
      await cp(rt, join(found, ".."), { recursive: true });
    }
    const relative = found.slice(into.length + 1);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, ".."), { recursive: true });
    await rename(into, dir);
    await writeFile(join(dir, "binary.txt"), `${relative}\n`);
    const binary = join(dir, relative);
    const problem = await (deps.verify ?? nodeVerify)(binary);
    if (problem !== undefined) {
      await rm(dir, { recursive: true, force: true });
      throw new InstallError(`the llama-server from ${program.name} does not start: ${problem}`, "try another backend (local_models.llama_cpp.backend) that matches this machine's drivers");
    }
    await o.lock.save();
    for (const f of fetched) await rm(f, { force: true });
    o.onEvent?.({ type: "installed", binary });
    return { binary, tag, dir, backend, backendNote };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The newest llama.cpp release's build tag (a version release is followed to the build it links to). */
export async function latestTag(deps: InstallDeps = {}, signal?: AbortSignal): Promise<string> {
  const base = deps.apiBase ?? "https://api.github.com";
  let json: unknown;
  try {
    json = await fetchJson(`${base}/repos/ggml-org/llama.cpp/releases/latest`, { fetch: deps.fetch, signal, headers: { "x-github-api-version": "2022-11-28" } });
  } catch (e) {
    throw new InstallError(`could not find the newest llama.cpp release: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = json as { tag_name?: unknown; body?: unknown };
  if (typeof r.tag_name !== "string") throw new InstallError("GitHub did not name the newest llama.cpp release");
  if (isBuildTag(r.tag_name)) return r.tag_name;
  const via = resolveVersionTag(r.tag_name, typeof r.body === "string" ? r.body : "");
  if (!via.ok) throw new InstallError(via.error);
  return via.tag;
}
