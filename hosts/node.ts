import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { randomBytes } from "node:crypto";
import type { ExecOptions, ExecResult, FileStat, Fs, Host, HostProcess, PathOps } from "../src/host.ts";

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

function exec(program: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
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
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (e) {
      if (isCode(e, "ENOENT") || isCode(e, "ENOTDIR")) return undefined;
      throw e;
    }
  },
  async writeAtomic(path, data) {
    const dir = nodePath.dirname(path);
    await fsp.mkdir(dir, { recursive: true });
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
};

/** A host for the machine this process runs on. Programs run without a shell; the environment is `process.env` plus `opts.env`. */
export function nodeHost(): Host {
  const path: PathOps = { join: (...s) => nodePath.join(...s), dirname: (p) => nodePath.dirname(p) };
  return { exec, spawn: spawnProcess, fs: nodeFs, path, nullDevice: process.platform === "win32" ? "NUL" : "/dev/null" };
}
