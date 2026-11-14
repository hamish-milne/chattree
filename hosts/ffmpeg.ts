/**
 * ffmpeg, for cutting and generating sound (the audio probes and benches; later codecs and microphone streaming). Like busybox it is
 * not part of this repository and the model never sees any of it. On Windows it is fetched on first use: the pinned gyan.dev "full"
 * build below (the only widely built ffmpeg that includes libflite, the speech synthesiser the benches use), used only if the zip's
 * SHA-256 is the one pinned here, kept in vendor/ffmpeg/ (ignored by git), nothing added to PATH. On other systems it is never
 * fetched: it must be on the PATH (or named by CHATTREE_FFMPEG), and a missing one is a `FfmpegError` that points to the package
 * manager. Whatever is found must list the `flite` filter, or it is refused (a slimmed build would fail the speech tests confusingly).
 * ffmpeg is GPL-3.0 software in this build.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Of } from "./busybox.ts";

/** The release that is fetched (Windows only) and the hash its zip must have. */
export const FFMPEG_RELEASE = {
  url: "https://github.com/GyanD/codexffmpeg/releases/download/2026-11-11-git-23c4540053/ffmpeg-2026-11-11-git-23c4540053-full_build.zip",
  sha256: "c7463db30f5d40f36e0eb3bc9601b8ce0c01fb3cad2dda572a5ff2ca6e68ec7a",
} as const;

/** Where the fetched ffmpeg.exe is kept: vendor/ffmpeg/ at the root of this package. */
export const FFMPEG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "ffmpeg");

export class FfmpegError extends Error {
  override name = "FfmpegError";
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

export const FFMPEG_HINT_WINDOWS = "download it yourself with `node tools/fetch-ffmpeg.ts --from <zip>` (a gyan.dev full build) or set CHATTREE_FFMPEG to an ffmpeg.exe that has libflite";
export const FFMPEG_HINT_OTHER = "install ffmpeg with your package manager (for example `apt install ffmpeg` or `brew install ffmpeg`), making sure the build has libflite (`ffmpeg -filters | grep flite`), or set CHATTREE_FFMPEG to one that does";

export interface FfmpegDeps {
  download(url: string): Promise<Uint8Array>;
  unpack(zip: string, into: string): Promise<void>;
  /** Whether `exe` runs as ffmpeg and lists the flite filter: `ok`, `no-flite`, or `broken` when it does not run. */
  probe(exe: string): Promise<"ok" | "no-flite" | "broken">;
}

export const nodeFfmpegDeps: FfmpegDeps = {
  async download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async unpack(zip, into) {
    const t = spawnSync("tar", ["-xf", zip, "-C", into], { encoding: "utf8" });
    if (t.status !== 0) throw new Error(`tar could not unpack the zip: ${t.stderr || t.error?.message}`);
  },
  async probe(exe) {
    const r = spawnSync(exe, ["-hide_banner", "-filters"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return "broken";
    return /\bflite\b/.test(r.stdout ?? "") ? "ok" : "no-flite";
  },
};

const isFile = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isFile() === true;
const exeName = (platform: NodeJS.Platform): string => (platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/** An ffmpeg that is already available, without fetching: CHATTREE_FFMPEG, the one fetched into `dir` (Windows), else the PATH. */
export async function findFfmpeg(o: { env?: Readonly<Record<string, string | undefined>>; dir?: string; platform?: NodeJS.Platform } = {}): Promise<string | undefined> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const named = env["CHATTREE_FFMPEG"];
  const candidates = [named, ...(platform === "win32" ? [join(o.dir ?? FFMPEG_DIR, "ffmpeg.exe")] : [])];
  for (const p of (env["PATH"] ?? env["Path"] ?? "").split(delimiter)) if (p !== "") candidates.push(join(p, exeName(platform)));
  for (const c of candidates) if (c !== undefined && c !== "" && (await isFile(c))) return c;
  return undefined;
}

async function find(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await find(p, name);
      if (hit !== undefined) return hit;
    } else if (e.name.toLowerCase() === name) return p;
  }
  return undefined;
}

/** Take ffmpeg.exe out of a zip, check it, and install it in `dir`. Returns the installed path. */
export async function installFfmpegFromZip(zip: string, dir: string, deps: FfmpegDeps = nodeFfmpegDeps): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "chattree-ffmpeg-"));
  try {
    await deps.unpack(zip, work);
    const exe = await find(work, "ffmpeg.exe");
    if (exe === undefined) throw new Error("ffmpeg.exe is not in that zip");
    const p = await deps.probe(exe);
    if (p === "broken") throw new Error(`${exe} does not run as ffmpeg`);
    if (p === "no-flite") throw new Error("that ffmpeg has no flite filter, so it cannot make speech; use a full build");
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "ffmpeg.exe");
    await copyFile(exe, dest);
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface EnsureFfmpegOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  say?: (message: string) => void;
  deps?: FfmpegDeps;
  release?: { url: string; sha256: string };
  dir?: string;
  /** Require the flite filter (default true: the speech benches need it). Converting pictures and sound does not, so it passes false. */
  flite?: boolean;
}

/**
 * The ffmpeg to use. One that is already there is checked for flite and used. On Windows with none, the pinned release is fetched
 * (and `say` is told before the download starts, since it is large); elsewhere a missing ffmpeg is an error that says what to install.
 */
export async function ensureFfmpeg(o: EnsureFfmpegOptions = {}): Promise<string> {
  const platform = o.platform ?? process.platform;
  const deps = o.deps ?? nodeFfmpegDeps;
  const hint = platform === "win32" ? FFMPEG_HINT_WINDOWS : FFMPEG_HINT_OTHER;
  const have = await findFfmpeg({ ...(o.env === undefined ? {} : { env: o.env }), ...(o.dir === undefined ? {} : { dir: o.dir }), platform });
  if (have !== undefined) {
    const p = await deps.probe(have);
    if (p === "ok" || (p === "no-flite" && o.flite === false)) return have;
    throw new FfmpegError(p === "broken" ? `${have} does not run as ffmpeg` : `${have} has no flite filter, so it cannot make speech`, hint);
  }
  if (platform !== "win32") throw new FfmpegError("ffmpeg was not found on the PATH", hint);
  const release = o.release ?? FFMPEG_RELEASE;
  o.say?.(`fetching ffmpeg for the audio benches (GPL-3.0 software, a large download, from ${release.url})`);
  let bytes: Uint8Array;
  try {
    bytes = await deps.download(release.url);
  } catch (e) {
    throw new FfmpegError(`could not fetch ffmpeg from ${release.url}: ${e instanceof Error ? e.message : String(e)}`, hint);
  }
  const got = sha256Of(bytes);
  if (got !== release.sha256) throw new FfmpegError(`the ffmpeg download is not the expected file (sha256 ${got}, expected ${release.sha256}), so it was not used`, hint);
  const work = await mkdtemp(join(tmpdir(), "chattree-ffmpeg-zip-"));
  try {
    const zip = join(work, "ffmpeg.zip");
    await writeFile(zip, bytes);
    return await installFfmpegFromZip(zip, o.dir ?? FFMPEG_DIR, deps);
  } catch (e) {
    throw new FfmpegError(`could not install ffmpeg: ${e instanceof Error ? e.message : String(e)}`, hint);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
