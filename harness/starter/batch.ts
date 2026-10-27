import type { Host } from "../../src/host.ts";
import { globRegex } from "./run-keys.ts";

/**
 * Windows batch programs (`npm.cmd`, `pnpm.cmd`, `build.bat`) for `run`, behind `tools.run.batch` in harness.yml.
 *
 * Why it is off by default: a batch file can only be started through `cmd.exe`, which re-reads the command line and treats
 * `% ^ & | < > "` and `!` as syntax whatever quoting was used (Node refuses to spawn them directly since the "BatchBadBut"
 * fix, CVE-2024-27980). An argument written by a model could then run another command. With the flag on, the arguments are
 * not escaped but checked: any argument containing one of those characters (or a line break) is refused, and the rest are
 * passed verbatim, in double quotes when they hold spaces.
 *
 * Programs are found as the shell would find them (`PATH`, relative entries from the workspace, never the bare current
 * directory), and one that resolves inside the workspace (a planted or built `.cmd`) must also be listed in `tools.run.local`,
 * for example `./node_modules/.bin/*.cmd`, or it is refused. Without the flag the lookup is only made to say what to set.
 */

const UNSAFE = /[%^&|<>"!\r\n\0]/;
const EXTENSIONS = [".com", ".exe", ".bat", ".cmd"] as const;

export const isBatch = (file: string): boolean => /\.(cmd|bat)$/i.test(file);

/** Why these arguments cannot be given to a batch file, or undefined. */
export function batchProblem(file: string, args: readonly string[]): string | undefined {
  if (UNSAFE.test(file)) return `the path ${file} contains a character that cmd.exe would interpret`;
  for (const a of args) {
    if (UNSAFE.test(a)) return `the argument ${JSON.stringify(a)} contains one of % ^ & | < > " ! or a line break, which cmd.exe would interpret when it starts a batch file; pass it another way (a file, or a program that is not a batch file)`;
    if (/[\s]/.test(a) && a.endsWith("\\")) return `the argument ${JSON.stringify(a)} ends with a backslash inside quotes`;
  }
  return undefined;
}

/** The stage that starts a batch file: `cmd.exe /d /s /c ""file" args"`, to be run with verbatim arguments. Call `batchProblem` first. */
export function batchStage(comspec: string, file: string, args: readonly string[]): string[] {
  const quoteArg = (a: string): string => (a === "" || /\s/.test(a) ? `"${a}"` : a);
  const command = [`"${file}"`, ...args.map(quoteArg)].join(" ");
  return [comspec, "/d", "/s", "/c", `"${command}"`];
}

const slash = (s: string): string => s.replaceAll("\\", "/");

/** Where a program name leads, and whether that is inside the workspace (then `local` is its `./relative` path). */
export interface Found {
  path: string;
  local?: string;
}

/**
 * Where a program name leads on Windows, resolved plainly: a name with a directory or a batch extension is taken relative to
 * the workspace, a bare name is searched along `PATH` (relative entries relative to the workspace, as the shell would), the
 * first match among `.com .exe .bat .cmd` in each directory. Links are followed. Undefined when nothing is found.
 */
export async function findProgram(host: Host, workspace: string, name: string, env: Readonly<Record<string, string | undefined>>): Promise<Found | undefined> {
  const isFile = async (p: string): Promise<boolean> => (await host.fs.stat(p))?.isFile === true;
  const root = (await host.fs.realpath(workspace)) ?? host.path.resolve(workspace);
  const found = async (p: string): Promise<Found> => {
    const real = (await host.fs.realpath(p)) ?? p;
    const rel = slash(host.path.relative(root, real));
    const inside = rel === "" || (rel !== ".." && !rel.startsWith("../") && !host.path.isAbsolute(rel));
    return { path: p, ...(inside ? { local: `./${rel}` } : {}) };
  };
  if (/[\\/]/.test(name) || isBatch(name)) {
    const abs = host.path.resolve(workspace, name);
    if (await isFile(abs)) return found(abs);
    if (!/\.[A-Za-z]+$/.test(name)) for (const ext of EXTENSIONS) if (await isFile(abs + ext)) return found(abs + ext);
    return undefined;
  }
  for (const dir of (env["PATH"] ?? env["Path"] ?? "").split(";")) {
    if (dir === "") continue;
    const abs = host.path.resolve(workspace, dir);
    for (const ext of EXTENSIONS) {
      const candidate = host.path.join(abs, name + ext);
      if (await isFile(candidate)) return found(candidate);
    }
  }
  return undefined;
}

/** Is a batch file inside the workspace listed in `tools.run.local`? Globs are compared with the `./relative` path, ignoring case. */
export function localAllowed(local: string, allowed: readonly string[]): boolean {
  return allowed.some((g) => globRegex(g.startsWith("./") ? g.toLowerCase() : `./${g.toLowerCase()}`).test(local.toLowerCase()));
}
