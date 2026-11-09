import type { Backend } from "./config.ts";

/**
 * llama.cpp releases (docs/local-models.md, section 5): which of a release's files is the one for this machine, and how a version
 * tag leads to the build tag that has the files. Pure: the release listing comes from the installer, which does the fetching.
 */

export type Platform = "windows" | "linux" | "macos";
export type Arch = "x64" | "arm64";

export interface ReleaseAsset {
  name: string;
  url: string;
  /** The `sha256:` digest GitHub shows for the file, as hex. */
  sha256?: string | undefined;
  size?: number | undefined;
}

export interface ParsedAsset {
  /** `llama` is the program; `cudart` is the CUDA runtime that goes beside it. */
  kind: "llama" | "cudart";
  /** The build tag in the name; the Windows CUDA runtime has none. */
  tag: string | undefined;
  os: string;
  arch: string;
  backend: string;
  /** The CUDA version of a cuda backend: `12.8`. */
  cuda: string | undefined;
  ext: "zip" | "tar.gz";
}

const ARCHES = ["x64", "arm64", "s390x"];
const KNOWN_BACKENDS = ["cpu", "cuda", "vulkan", "rocm", "sycl", "openvino", "opencl", "snapdragon", "zdnn"];

/** A release file's name taken apart; undefined for anything that is not a program archive (the source code, the UI bundle, the xcframework). */
export function parseAssetName(name: string): ParsedAsset | undefined {
  const m = /^(llama|cudart-llama)-(?:(b\d+)-)?bin-(.+)\.(tar\.gz|zip)$/.exec(name);
  if (m === null) return undefined;
  const tokens = (m[3] as string).split("-");
  const os = tokens.shift() as string;
  const archAt = tokens.findIndex((t) => ARCHES.includes(t));
  if (archAt < 0) return undefined;
  const arch = tokens.splice(archAt, 1)[0] as string;
  // What is left is the backend, with its version or variant; a bare version such as "26.04" is the operating system's.
  const rest = tokens.filter((t) => !/^\d+(\.\d+)*$/.test(t) || tokens[0] !== t);
  const first = rest[0];
  const kind = m[1] === "llama" ? "llama" : "cudart";
  const backend = first !== undefined && KNOWN_BACKENDS.includes(first) ? first : os === "macos" ? "metal" : "cpu";
  const cuda = backend === "cuda" ? rest[1] : undefined;
  return { kind, tag: m[2], os, arch, backend, cuda, ext: m[4] as "zip" | "tar.gz" };
}

const OS_NAME: Record<Platform, string> = { windows: "win", linux: "ubuntu", macos: "macos" };

/** `auto` is Metal on a Mac, else the GPU backend the host found (localmodels/gpu.ts), else the CPU. */
export function resolveBackend(requested: Backend, platform: Platform, gpu?: Exclude<Backend, "auto" | "cpu"> | undefined): Exclude<Backend, "auto"> {
  if (requested !== "auto") return requested;
  return platform === "macos" ? "metal" : (gpu ?? "cpu");
}

const versionParts = (v: string): number[] => v.split(".").map(Number);
function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface Selection {
  program: ReleaseAsset;
  /** The CUDA runtime to unpack beside the program, when the release has one for this version. */
  runtime?: ReleaseAsset;
}

export interface SelectOptions {
  platform: Platform;
  arch: Arch;
  backend: Backend;
  /** The CUDA version to prefer; default the newest. */
  cuda?: string | undefined;
  /** What `auto` should pick when it is not a Mac: the GPU backend that was found. */
  gpu?: Exclude<Backend, "auto" | "cpu"> | undefined;
}

export type SelectResult = { ok: true; selection: Selection } | { ok: false; error: string };

/** The release's file for this platform, architecture and backend. A cuda backend takes the requested or newest CUDA version, and the runtime file of that version. */
export function selectAsset(assets: readonly ReleaseAsset[], opts: SelectOptions): SelectResult {
  const backend = resolveBackend(opts.backend, opts.platform, opts.gpu);
  const os = OS_NAME[opts.platform];
  const parsed = assets.flatMap((asset) => {
    const p = parseAssetName(asset.name);
    return p === undefined ? [] : [{ asset, p }];
  });
  const matching = parsed.filter(({ p }) => p.os === os && p.arch === opts.arch && p.backend === backend);
  const programs = matching.filter(({ p }) => p.kind === "llama");
  if (programs.length === 0) {
    const offered = [...new Set(parsed.filter(({ p }) => p.kind === "llama" && p.os === os && p.arch === opts.arch).map(({ p }) => p.backend))].sort();
    return { ok: false, error: `this release has no ${backend} build for ${opts.platform} ${opts.arch}${offered.length > 0 ? ` (it has: ${offered.join(", ")})` : ""}` };
  }
  let chosen = programs;
  if (backend === "cuda") {
    const versions = [...new Set(programs.map(({ p }) => p.cuda ?? "0"))].sort(compareVersions);
    const want = opts.cuda === undefined ? versions.at(-1) : versions.find((v) => v === opts.cuda || v.startsWith(`${opts.cuda}.`));
    if (want === undefined) return { ok: false, error: `this release has no CUDA ${opts.cuda} build for ${opts.platform} ${opts.arch} (it has: ${versions.join(", ")})` };
    chosen = programs.filter(({ p }) => (p.cuda ?? "0") === want);
  }
  const program = chosen[0] as (typeof chosen)[number];
  const runtime = matching.find(({ p }) => p.kind === "cudart" && p.cuda === program.p.cuda && (p.tag === undefined || p.tag === program.p.tag));
  return { ok: true, selection: { program: program.asset, ...(runtime === undefined ? {} : { runtime: runtime.asset }) } };
}

/** The build tag a release page points at: the first `releases/tag/bNNNN` link in its text. */
export function nightlyTagIn(text: string): string | undefined {
  return /releases\/tag\/(b\d+)\b/.exec(text)?.[1];
}

export const isBuildTag = (tag: string): boolean => /^b\d+$/.test(tag);

/** What to do with a configured tag: a build tag is used as it is; a version tag needs its release read for the build it points at. */
export function tagStep(tag: string): { kind: "build"; tag: string } | { kind: "release"; tag: string } {
  return isBuildTag(tag) ? { kind: "build", tag } : { kind: "release", tag };
}

/** The build a version tag's release points at, from the release's description. */
export function resolveVersionTag(version: string, releaseBody: string): { ok: true; tag: string } | { ok: false; error: string } {
  const tag = nightlyTagIn(releaseBody);
  return tag === undefined ? { ok: false, error: `the release ${version} does not link to a build; set llama_cpp.tag to a build such as b12110` } : { ok: true, tag };
}

export const releaseApiUrl = (tag: string): string => `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${encodeURIComponent(tag)}`;

/** The platform and architecture of this process, in the release's terms. */
export function thisMachine(): { platform: Platform; arch: Arch } {
  return { platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", arch: process.arch === "arm64" ? "arm64" : "x64" };
}
