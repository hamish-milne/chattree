import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, constants, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExecOptions, ExecResult, FileStat, Fs, Host, HostProcess, PathOps, RunOutcome, RunSpec } from "../src/host.ts";

const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

const isCode = (e: unknown, code: string): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Git for Windows puts a launcher called git.exe on PATH (in `cmd\`, or `bin\`) which starts the real mingw64\bin\git.exe: two
 * process starts for every git call, and starting processes is what is slow on Windows. This finds the real one next to the
 * launcher. It returns undefined, and the caller keeps using plain `git`, unless PATH has such a launcher and the real exe is there and
 * answers `version`.
 */
export function findRealGit(
  pathVar: string | undefined,
  deps: { isFile(p: string): boolean; works(p: string): boolean } = { isFile: (p) => statSync(p, { throwIfNoEntry: false })?.isFile() === true, works: (p) => spawnSync(p, ["version"], { windowsHide: true }).status === 0 },
): string | undefined {
  const w = nodePath.win32;
  for (const dir of (pathVar ?? "").split(";")) {
    if (dir === "" || !["cmd", "bin"].includes(w.basename(dir.replace(/[\\/]+$/, "")).toLowerCase())) continue;
    if (!deps.isFile(w.join(dir, "git.exe"))) continue;
    const real = w.join(dir, "..", "mingw64", "bin", "git.exe");
    if (deps.isFile(real) && deps.works(real)) return real;
  }
  return undefined;
}

/** `CHATTREE_SPAWN_LOG=<file>` appends one line per process started (program and git subcommand): tools/test.ts uses it to count them. */
function logSpawn(program: string, args: readonly string[]): void {
  const file = process.env["CHATTREE_SPAWN_LOG"];
  if (file === undefined) return;
  const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
  appendFileSync(file, `${nodePath.basename(program)} ${sub}\n`);
}

let realGit: string | undefined | null = null;
/** `git` on a Windows PATH becomes the real git.exe when one can be found (see findRealGit); every other program is left alone. */
function resolveProgram(program: string): string {
  if (program !== "git" || process.platform !== "win32") return program;
  if (realGit === null) realGit = findRealGit(process.env["PATH"] ?? process.env["Path"]);
  return realGit ?? program;
}

function exec(program: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  program = resolveProgram(program);
  logSpawn(program, args);
  return new Promise((resolve, reject) => {
    const limit = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
    const child = spawn(program, [...args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: Error | undefined;
    const fail = (e: Error): void => {
      if (failure === undefined) failure = e;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (c: Uint8Array) => {
      outBytes += c.length;
      if (outBytes > limit) fail(new Error(`${program}: stdout exceeded ${limit} bytes`));
      else out.push(c);
    });
    child.stderr.on("data", (c: Uint8Array) => {
      errBytes += c.length;
      if (errBytes > limit) fail(new Error(`${program}: stderr exceeded ${limit} bytes`));
      else err.push(c);
    });
    child.stdin.on("error", () => {
      /* the process may exit without reading its input; the exit code tells the story */
    });
    child.on("error", (e) => reject(failure ?? e));
    child.on("close", (code, signal) => {
      if (failure !== undefined) reject(failure);
      else resolve({ exitCode: code ?? (signal === null ? 1 : 128), stdout: concat(out, outBytes), stderr: concat(err, errBytes) });
    });
    child.stdin.end(opts.stdin);
  });
}

function spawnProcess(program: string, args: readonly string[], opts: Pick<ExecOptions, "cwd" | "env">): Promise<HostProcess> {
  program = resolveProgram(program);
  logSpawn(program, args);
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const err: Uint8Array[] = [];
    let errBytes = 0;
    child.stderr.on("data", (c: Uint8Array) => {
      if (errBytes < 64 * 1024) {
        err.push(c);
        errBytes += c.length;
      }
    });
    child.stdin.on("error", () => {
      /* the exit code tells the story */
    });
    const exit = new Promise<{ exitCode: number; stderr: Uint8Array }>((done) => {
      child.on("close", (code, signal) => done({ exitCode: code ?? (signal === null ? 1 : 128), stderr: concat(err, errBytes) }));
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.removeListener("error", reject);
      child.on("error", () => undefined);
      resolve({
        write: (data) =>
          new Promise<void>((ok, bad) => {
            if (child.stdin.destroyed) bad(new Error(`${program} is no longer running`));
            else child.stdin.write(data, (e) => (e == null ? ok() : bad(e)));
          }),
        closeInput: () =>
          new Promise<void>((ok) => {
            if (child.stdin.destroyed || child.stdin.writableEnded) ok();
            else child.stdin.end(() => ok());
          }),
        output: child.stdout,
        kill: () => void child.kill("SIGKILL"),
        exit,
      });
    });
  });
}

const DEFAULT_RUN_OUTPUT = 8 * 1024 * 1024;

/** Kill a child and everything it started: its process group on POSIX, its tree on Windows. */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function runCommand(spec: RunSpec): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const limit = spec.maxOutput ?? DEFAULT_RUN_OUTPUT;
    const env: Record<string, string | undefined> = { ...process.env, ...(spec.env ?? {}) };
    const pattern = spec.unsetEnvPattern === undefined ? undefined : new RegExp(spec.unsetEnvPattern, "i");
    for (const name of Object.keys(env)) if ((spec.unsetEnv ?? []).includes(name) || (pattern?.test(name) === true && !(name in (spec.env ?? {})))) delete env[name];

    const output: Uint8Array[] = [];
    const stdoutChunks: Uint8Array[] = [];
    let outBytes = 0;
    let stdoutBytes = 0;
    let dropped = 0;
    const keep = (into: Uint8Array[], size: number, chunk: Uint8Array): number => {
      const room = limit - size;
      if (room <= 0) {
        dropped += chunk.length;
        return size;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      dropped += chunk.length - part.length;
      into.push(part);
      return size + part.length;
    };

    const children: ReturnType<typeof spawn>[] = [];
    const codes: number[] = new Array<number>(spec.stages.length).fill(-1);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let pending = spec.stages.length;
    const killAll = (): void => {
      for (const c of children) killTree(c);
    };
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (fallback !== undefined) clearTimeout(fallback);
      spec.signal?.removeEventListener("abort", onAbort);
      const last = codes[codes.length - 1] as number;
      resolve({
        exitCode: last,
        stageCodes: codes,
        output: concat(output, outBytes),
        ...(spec.captureStdout === true ? { stdout: concat(stdoutChunks, stdoutBytes) } : {}),
        dropped,
        timedOut,
        aborted,
      });
    };
    const stopped = (): void => {
      // After a kill, wait a moment for the pipes to drain, then give up on any that something else holds open.
      fallback ??= setTimeout(() => {
        for (let i = 0; i < codes.length; i++) if (codes[i] === -1) codes[i] = 137;
        finish();
      }, 2000);
    };
    const onAbort = (): void => {
      aborted = true;
      killAll();
      stopped();
    };
    const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killAll();
      stopped();
    }, spec.timeoutMs);
    if (spec.signal?.aborted === true) {
      onAbort();
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    spec.stages.forEach((stage, i) => {
      const [program, ...args] = stage as readonly [string, ...string[]];
      const last = i === spec.stages.length - 1;
      const child = spawn(program, args, { cwd: spec.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: spec.verbatim?.[i] === true });
      children.push(child);
      let done = false;
      const end = (code: number): void => {
        if (done) return;
        done = true;
        codes[i] = code;
        if (--pending === 0) finish();
      };
      child.stdin.on("error", () => undefined);
      child.stdout.on("error", () => undefined);
      child.stderr.on("error", () => undefined);
      child.stderr.on("data", (c: Uint8Array) => {
        outBytes = keep(output, outBytes, c);
      });
      if (!last) {
        const next = i + 1;
        // The next stage is spawned after this one in the loop; connect once it exists.
        queueMicrotask(() => {
          const target = children[next]?.stdin;
          if (target !== null && target !== undefined) child.stdout.pipe(target);
        });
      } else if (spec.captureStdout === true) {
        child.stdout.on("data", (c: Uint8Array) => {
          stdoutBytes = keep(stdoutChunks, stdoutBytes, c);
        });
      } else {
        child.stdout.on("data", (c: Uint8Array) => {
          outBytes = keep(output, outBytes, c);
        });
      }
      if (i === 0) child.stdin.end(spec.stdin);
      child.on("error", (e: NodeJS.ErrnoException) => {
        outBytes = keep(output, outBytes, new TextEncoder().encode(e.code === "ENOENT" ? `${program}: command not found\n` : `${program}: ${e.message}\n`));
        end(127);
      });
      child.on("close", (code, signal) => end(code ?? (signal === null ? 1 : 128 + ((signal === "SIGKILL" && 9) || (signal === "SIGTERM" && 15) || 1))));
    });
  });
}

async function writeFlushed(handle: fsp.FileHandle, data: Uint8Array): Promise<void> {
  let at = 0;
  while (at < data.length) at += (await handle.write(data, at, data.length - at)).bytesWritten;
}

async function syncDir(dir: string): Promise<void> {
  // Best effort: directories cannot be opened for syncing on every platform.
  try {
    const h = await fsp.open(dir, "r");
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    /* ignore */
  }
}

const nodeFs: Fs = {
  async read(path) {
    return new Uint8Array(await fsp.readFile(path));
  },
  async readRange(path, offset, length) {
    const h = await fsp.open(path, "r");
    try {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await h.read(buf, got, length - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return got === length ? buf : buf.subarray(0, got);
    } finally {
      await h.close();
    }
  },
  async stat(path): Promise<FileStat | undefined> {
    try {
      const s = await fsp.stat(path);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs };
    } catch (e) {
      if (isCode(e, "ENOENT") || isCode(e, "ENOTDIR")) return undefined;
      throw e;
    }
  },
  async writeAtomic(path, data, opts) {
    const dir = nodePath.dirname(path);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    const mode = opts?.keepMode === true ? await fsp.stat(path).then((s) => s.mode & 0o7777, () => undefined) : undefined;
    const h = await fsp.open(tmp, "wx");
    try {
      if (mode !== undefined) await h.chmod(mode);
      await writeFlushed(h, data);
      await h.sync();
    } catch (e) {
      await h.close();
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    await h.close();
    try {
      await fsp.rename(tmp, path);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    await syncDir(dir);
  },
  async append(path, data, opts) {
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    const h = await fsp.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o666);
    try {
      await writeFlushed(h, data);
      if (opts?.sync === true) await h.sync();
    } finally {
      await h.close();
    }
  },
  async createExclusive(path, data) {
    const dir = nodePath.dirname(path);
    await fsp.mkdir(dir, { recursive: true });
    // Publish complete content atomically: write a temporary file, then hard-link it into place. link() fails
    // with EEXIST if the target exists, and a reader can never see a half-written file.
    const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    const h = await fsp.open(tmp, "wx");
    try {
      await writeFlushed(h, data);
      await h.sync();
    } catch (e) {
      await h.close();
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    await h.close();
    try {
      await fsp.link(tmp, path);
      return true;
    } catch (e) {
      if (isCode(e, "EEXIST")) return false;
      if (!isCode(e, "EPERM") && !isCode(e, "ENOSYS") && !isCode(e, "EXDEV") && !isCode(e, "ENOTSUP")) throw e;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    // The file system has no hard links: fall back to exclusive creation.
    let direct: fsp.FileHandle;
    try {
      direct = await fsp.open(path, "wx");
    } catch (e) {
      if (isCode(e, "EEXIST")) return false;
      throw e;
    }
    try {
      await writeFlushed(direct, data);
      await direct.sync();
    } finally {
      await direct.close();
    }
    return true;
  },
  async truncate(path, length) {
    const h = await fsp.open(path, "r+");
    try {
      await h.truncate(length);
      await h.sync();
    } finally {
      await h.close();
    }
  },
  rename: (from, to) => fsp.rename(from, to),
  async remove(path) {
    try {
      await fsp.unlink(path);
      return true;
    } catch (e) {
      if (isCode(e, "ENOENT")) return false;
      throw e;
    }
  },
  async mkdir(path) {
    await fsp.mkdir(path, { recursive: true });
  },
  readdir: (path) => fsp.readdir(path),
  async realpath(path) {
    try {
      return await fsp.realpath(path);
    } catch (e) {
      if (isCode(e, "ENOENT") || isCode(e, "ENOTDIR")) return undefined;
      throw e;
    }
  },
};

/** A host for the machine this process runs on. Programs run without a shell; the environment is `process.env` plus `opts.env`. */
export function nodeHost(): Host {
  const path: PathOps = { join: (...s) => nodePath.join(...s), dirname: (p) => nodePath.dirname(p), resolve: (...s) => nodePath.resolve(...s), relative: (a, b) => nodePath.relative(a, b), isAbsolute: (p) => nodePath.isAbsolute(p) };
  return { exec, spawn: spawnProcess, run: runCommand, fs: nodeFs, path, nullDevice: process.platform === "win32" ? "NUL" : "/dev/null", platform: process.platform === "win32" ? "windows" : "posix" };
}

/** Where `tools/fetch-busybox.ts` puts busybox.exe: vendor/busybox/ at the root of this package. */
export const BUSYBOX_DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "busybox");

/**
 * The busybox.exe that stands in for cat, ls, grep and the rest of the everyday utilities on Windows: the path in
 * `CHATTREE_BUSYBOX`, else the one `tools/fetch-busybox.ts` installed. Undefined elsewhere, and when there is none.
 */
export async function findBusybox(env: Readonly<Record<string, string | undefined>> = process.env, dir: string = BUSYBOX_DIR): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  for (const candidate of [env["CHATTREE_BUSYBOX"], nodePath.join(dir, "busybox.exe")]) {
    if (candidate !== undefined && candidate !== "" && (await nodeFs.stat(candidate))?.isFile === true) return candidate;
  }
  return undefined;
}
