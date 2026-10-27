/**
 * busybox.exe for Windows, fetched on first use (docs/tools.md, 4.1). Busybox is GPL-2.0 software and is not part of this
 * repository. The download is the xPack windows-build-tools release below, and it is used only if the zip's SHA-256 is the
 * one pinned here; the exe taken from it must also answer `--list` like busybox. It is kept in vendor/busybox/ (ignored by
 * git), nothing is added to PATH, and the agent never sees any of this: a failure is the user's to fix, so it is a
 * `BusyboxError` that the CLI shows with what to do.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSYBOX_DIR, findBusybox } from "./node.ts";

/** The release that is fetched and the hash its zip must have. */
export const BUSYBOX_RELEASE = {
  url: "https://github.com/xpack-dev-tools/windows-build-tools-xpack/releases/download/v4.4.1-3/xpack-windows-build-tools-4.4.1-3-win32-x64.zip",
  sha256: "",
} as const;

export class BusyboxError extends Error {
  override name = "BusyboxError";
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

export const BUSYBOX_HINT = "download it yourself with `node tools/fetch-busybox.ts --from <zip>` or point tools.run.busybox in harness.yml at a busybox.exe; or remove the run and script tools from harness.yml";

/** The parts of fetching that touch the outside world, so they can be replaced in tests. */
export interface BusyboxDeps {
  download(url: string): Promise<Uint8Array>;
  /** Unpack a zip into a directory. */
  unpack(zip: string, into: string): Promise<void>;
  /** The applets a busybox.exe lists, or undefined when it does not run. */
  applets(exe: string): Promise<string[] | undefined>;
}

export const nodeBusyboxDeps: BusyboxDeps = {
  async download(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async unpack(zip, into) {
    const t = spawnSync("tar", ["-xf", zip, "-C", into], { encoding: "utf8" });
    if (t.status !== 0) throw new Error(`tar could not unpack the zip: ${t.stderr || t.error?.message}`);
  },
  async applets(exe) {
    const r = spawnSync(exe, ["--list"], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout ?? "").split(/\r?\n/).filter(Boolean) : undefined;
  },
};

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

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Take busybox.exe out of a zip, check it, and install it in `dir`. Returns the installed path. */
export async function installBusyboxFromZip(zip: string, dir: string, deps: BusyboxDeps = nodeBusyboxDeps): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "chattree-busybox-"));
  try {
    await deps.unpack(zip, work);
    const exe = await find(work, "busybox.exe");
    if (exe === undefined) throw new Error("busybox.exe is not in that zip");
    const applets = await deps.applets(exe);
    if (applets === undefined || !applets.includes("cat")) throw new Error(`${exe} does not look like busybox (--list gave ${applets?.length ?? 0} applets)`);
    await mkdir(dir, { recursive: true });
    const dest = join(dir, "busybox.exe");
    await copyFile(exe, dest);
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface EnsureOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Told before the download starts. */
  say?: (message: string) => void;
  deps?: BusyboxDeps;
  release?: { url: string; sha256: string };
  dir?: string;
}

/** The busybox.exe to use: one that is already there, else the pinned release, fetched. Throws `BusyboxError` when there is none to be had. */
export async function ensureBusybox(o: EnsureOptions = {}): Promise<string> {
  const have = await findBusybox(o.env ?? process.env);
  if (have !== undefined) return have;
  const release = o.release ?? BUSYBOX_RELEASE;
  const deps = o.deps ?? nodeBusyboxDeps;
  if (release.sha256 === "") throw new BusyboxError("this version of chattree has no pinned busybox release to fetch", BUSYBOX_HINT);
  o.say?.(`fetching busybox for the run tool (GPL-2.0 software, from ${release.url})`);
  let bytes: Uint8Array;
  try {
    bytes = await deps.download(release.url);
  } catch (e) {
    throw new BusyboxError(`could not fetch busybox from ${release.url}: ${e instanceof Error ? e.message : String(e)}`, BUSYBOX_HINT);
  }
  const got = sha256Of(bytes);
  if (got !== release.sha256) throw new BusyboxError(`the busybox download is not the expected file (sha256 ${got}, expected ${release.sha256}), so it was not used`, BUSYBOX_HINT);
  const work = await mkdtemp(join(tmpdir(), "chattree-busybox-zip-"));
  try {
    const zip = join(work, "busybox.zip");
    await writeFile(zip, bytes);
    return await installBusyboxFromZip(zip, o.dir ?? BUSYBOX_DIR, deps);
  } catch (e) {
    throw new BusyboxError(`could not install busybox: ${e instanceof Error ? e.message : String(e)}`, BUSYBOX_HINT);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

