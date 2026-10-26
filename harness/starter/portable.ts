/**
 * Cross-platform commands for `run` (docs/tools.md, 4.1). The model writes `cat`, `ls`, `grep`, `sed` and the rest as it
 * would anywhere. On POSIX they are the system's own programs. On Windows, where they do not exist (or are different
 * programs: `find`, `sort`, `date`), the command is started as `busybox.exe <applet> ...`. Nothing is added to PATH, and
 * programs that are not on the list (`git`, `node`, `npm`, `python`) are started as they are.
 */

/** Commands that busybox provides in place of the system's on Windows. */
export const BUSYBOX_APPLETS: ReadonlySet<string> = new Set([
  "awk", "base64", "basename", "cat", "chmod", "cksum", "cmp", "comm", "cp", "cut", "date", "dd", "diff", "dirname", "dos2unix", "du",
  "echo", "egrep", "env", "expand", "expr", "false", "fgrep", "find", "fold", "grep", "gunzip", "gzip", "head", "hexdump", "ln", "ls",
  "md5sum", "mkdir", "mv", "nl", "od", "paste", "patch", "printenv", "printf", "pwd", "readlink", "realpath", "rev", "rm", "rmdir",
  "sed", "seq", "sh", "ash", "sha1sum", "sha256sum", "sha512sum", "sleep", "sort", "split", "stat", "tac", "tail", "tee", "test", "touch", "tr",
  "true", "truncate", "uname", "uniq", "unix2dos", "wc", "which", "xargs", "yes", "zcat",
]);

export class NotAvailable extends Error {
  override name = "NotAvailable";
}

/** The command name as the model wrote it: no directory, no `.exe`, lower case. Undefined when a path was given. */
const applet = (program: string): string | undefined => {
  if (/[\\/]/.test(program)) return undefined;
  return program.toLowerCase().replace(/\.exe$/, "");
};

/** The stage to start: busybox standing in for a missing utility on Windows, otherwise the stage itself. */
export function portableStage(stage: readonly string[], platform: "windows" | "posix" | undefined, busybox: string | undefined): string[] {
  const [program, ...args] = stage as readonly [string, ...string[]];
  if (platform !== "windows") return [...stage];
  const name = applet(program);
  if (name === undefined || !BUSYBOX_APPLETS.has(name)) return [...stage];
  if (busybox === undefined) {
    throw new NotAvailable(`${name} is not available on this Windows machine (busybox is not installed for the agent; run \`node tools/fetch-busybox.ts\`). Use the read tool to view files, or a program that is available, such as git or node.`);
  }
  return [busybox, name, ...args];
}

/**
 * The stage for a `script`: POSIX `sh -c <script>` everywhere. On Windows it is busybox's `sh`, so a script means the
 * same on every host and does not depend on which bash (or WSL launcher) happens to be installed; bash, python or
 * powershell are programs the model can start with `run` when the host has them.
 */
export function shellStage(script: string, platform: "windows" | "posix" | undefined, busybox: string | undefined): string[] {
  if (platform !== "windows") return ["sh", "-c", script];
  if (busybox === undefined) {
    throw new NotAvailable("script needs a POSIX shell, which on this Windows machine comes from busybox (it is not installed for the agent; run `node tools/fetch-busybox.ts`). Use run for single commands.");
  }
  return [busybox, "sh", "-c", script];
}
