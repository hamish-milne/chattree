/**
 * How a session finds the daemon: `run/daemon.json` in the data directory holds the process id, the control port and the token (readable
 * by the user only); `run/daemon.lock` is held by the one daemon that runs, so a second start cannot happen. A state file whose process
 * is gone is stale and is ignored.
 */
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasCode } from "../src/json.ts";
import { jsonOr } from "../src/json.ts";

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export const runDir = (data: string): string => join(data, "run");
export const stateFile = (data: string): string => join(runDir(data), "daemon.json");
export const lockFile = (data: string): string => join(runDir(data), "daemon.lock");
export const logFile = (data: string): string => join(runDir(data), "daemon.log");

/** Whether a process exists. Signal 0 only tests for it; EPERM means it exists but belongs to someone else, so it counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return hasCode(e, "EPERM");
  }
}

export async function readInfo(data: string): Promise<DaemonInfo | undefined> {
  const text = await readFile(stateFile(data), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const v = jsonOr(JSON.parse(text));
    const { pid, port, token, startedAt } = v;
    return typeof pid === "number" && typeof port === "number" && typeof token === "string" && typeof startedAt === "number"
      ? { pid, port, token, startedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Written to a temp file and renamed, so a reader never sees half of it. Owner-only, since the file holds the control token. */
export async function writeInfo(data: string, info: DaemonInfo): Promise<void> {
  await mkdir(runDir(data), { recursive: true });
  const tmp = `${stateFile(data)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined); // Windows has no modes
  await rename(tmp, stateFile(data));
}

export async function removeInfo(data: string): Promise<void> {
  await rm(stateFile(data), { force: true });
}

/** Take the lock; false when a live daemon holds it. A lock of a process that is gone is taken over. */
export async function acquireLock(data: string): Promise<boolean> {
  await mkdir(runDir(data), { recursive: true });
  // `wx` creates the file only if it is absent, so two starts cannot both win; a stale lock is removed once and the take is retried.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockFile(data), "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return true;
    } catch (e) {
      if (!hasCode(e, "EEXIST")) throw e;
      const holder = Number((await readFile(lockFile(data), "utf8").catch(() => "")).trim());
      if (holder > 0 && pidAlive(holder)) return false;
      await rm(lockFile(data), { force: true });
    }
  }
  return false;
}

/** Removes the lock only while it still names this process, so a daemon that took over a stale lock is not undone. */
export async function releaseLock(data: string): Promise<void> {
  const holder = Number((await readFile(lockFile(data), "utf8").catch(() => "")).trim());
  if (holder === process.pid) await rm(lockFile(data), { force: true });
}
