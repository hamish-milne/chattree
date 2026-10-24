import type { Host } from "../../src/index.ts";

/** Thrown by `faultyHost` at the chosen operation, standing in for a crash. */
export class InjectedFault extends Error {
  override name = "InjectedFault";
}

/**
 * A host that fails the Nth side-effecting operation (running a program, or any file write) and every one
 * after it, as a crashed process would. Reads still work so a test can inspect what was left behind.
 * `ops` counts operations so far; `arm(n)` makes the nth operation from now fail. With `failAt = Infinity` it only counts.
 */
export function faultyHost(inner: Host, failAt: number): Host & { ops: number; log: string[]; arm(afterOps: number): void } {
  const state = { ops: 0, log: [] as string[], failAt };
  const tick = (what: string): void => {
    state.ops++;
    state.log.push(what);
    if (state.ops >= state.failAt) throw new InjectedFault(`injected fault at operation ${state.ops}: ${what}`);
  };
  const fs = inner.fs;
  return {
    get ops() { return state.ops; },
    get log() { return state.log; },
    /** Fail the Nth operation from now on (1 = the very next one). */
    arm(afterOps: number) { state.failAt = state.ops + afterOps; state.log.length = 0; },
    path: inner.path,
    nullDevice: inner.nullDevice,
    exec: (program, args, opts) => {
      // Read-only commands do not count: a crash between them changes nothing.
      const mutating = args.some((a) => ["add", "commit", "update-index", "hash-object", "restore", "init", "config", "branch", "worktree", "merge", "reset"].includes(a));
      if (mutating) tick(`${program} ${args.filter((a) => !a.startsWith("-") && !a.includes("=")).slice(0, 2).join(" ")}`);
      return inner.exec(program, args, opts);
    },
    fs: {
      ...fs,
      writeAtomic: (p, d) => (tick(`writeAtomic ${p}`), fs.writeAtomic(p, d)),
      append: (p, d, o) => (tick(`append ${p}`), fs.append(p, d, o)),
      createExclusive: (p, d) => (tick(`createExclusive ${p}`), fs.createExclusive(p, d)),
      truncate: (p, n) => (tick(`truncate ${p}`), fs.truncate(p, n)),
      rename: (a, b) => (tick(`rename ${a}`), fs.rename(a, b)),
      remove: (p) => (tick(`remove ${p}`), fs.remove(p)),
      mkdir: (p) => (tick(`mkdir ${p}`), fs.mkdir(p)),
    },
  };
}
