import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { WebHost } from "../../ui/host/web-host.ts";
import type { World } from "./journey.ts";

const git = promisify(execFile);
const run = async (cwd: string, args: string[]): Promise<string | undefined> => {
  try {
    return (await git("git", args, { cwd })).stdout;
  } catch {
    return undefined;
  }
};

/**
 * The world of the journey on a real disk: `root` holds the workspace folder `folder`; what the product leaves there is
 * read back with the file system and git. `host` is the web host whose log tells which files the person asked to open.
 */
export function diskWorld(
  root: string,
  host: WebHost,
  base: Pick<World, "folder" | "tasks" | "replies" | "deliverable" | "asksBeforeWriting">,
): World {
  const dir = join(root, base.folder);
  return {
    ...base,
    async editByHand(path, text) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    },
    async fileInFolder(path) {
      return readFile(join(dir, path), "utf8").catch(() => undefined);
    },
    async fileOnBranch(branch, path) {
      return run(dir, ["show", `${branch}:${path}`]);
    },
    async checkedOutBranch() {
      return (await run(dir, ["branch", "--show-current"]))?.trim() ?? "";
    },
    async opened() {
      return host.log.intents.flatMap((i) => (i.type === "file.open" ? [i.path] : []));
    },
  };
}
