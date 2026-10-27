import type { Host } from "../../src/host.ts";

/**
 * Windows batch programs (`npm.cmd`, `pnpm.cmd`, `build.bat`) for `run`, behind `tools.run.batch` in harness.yml.
 *
 * Why it is off by default: a batch file can only be started through `cmd.exe`, which re-reads the command line and treats
 * `% ^ & | < > "` and `!` as syntax whatever quoting was used (Node refuses to spawn them directly since the "BatchBadBut"
 * fix, CVE-2024-27980). An argument written by a model could then run another command. With the flag on, the arguments are
 * not escaped but checked: any argument containing one of those characters (or a line break) is refused, and the rest are
 * passed verbatim, in double quotes when they hold spaces.
 *
 * Also, only what is found is run: bare names are looked up in the absolute `PATH` entries outside the workspace (Windows
 * itself would look in the current directory first, so a planted `git.cmd` would win); a path or `.cmd`/`.bat` name must be a
 * file inside the workspace. Without the flag the same lookup is made only to say what to set.
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

/**
 * Where a program name leads on Windows: the first match along `PATH` (absolute entries outside the workspace only) among
 * `.com .exe .bat .cmd`; a name with a directory or a `.cmd`/`.bat` extension is looked for in the workspace. Undefined when not found.
 */
export async function findProgram(host: Host, workspace: string, name: string, env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const isFile = async (p: string): Promise<boolean> => (await host.fs.stat(p))?.isFile === true;
  if (/[\\/]/.test(name) || isBatch(name)) {
    const abs = host.path.resolve(workspace, name);
    const rel = slash(host.path.relative(workspace, abs));
    if (rel === ".." || rel.startsWith("../") || host.path.isAbsolute(rel)) return undefined;
    if (await isFile(abs)) return abs;
    for (const ext of EXTENSIONS) if (!/\.[A-Za-z]+$/.test(name) && (await isFile(abs + ext))) return abs + ext;
    return undefined;
  }
  const path = env["PATH"] ?? env["Path"] ?? "";
  for (const dir of path.split(";")) {
    if (dir === "" || !host.path.isAbsolute(dir)) continue;
    const rel = slash(host.path.relative(workspace, dir));
    if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !host.path.isAbsolute(rel))) continue; // inside the workspace
    for (const ext of EXTENSIONS) {
      const candidate = host.path.join(dir, name + ext);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
