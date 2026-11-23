/**
 * Why can a code repository that has a conversation linked to it not be renamed on Windows (EPERM)? Each step builds the situation a bit
 * further, then tries to rename the repository's folder, retrying for up to two seconds, and prints what happened.
 *
 *   node --no-warnings tools/rename-probe.ts
 *
 * The first step that needs retries or fails names what holds the folder. Nothing is left behind: everything is under the system temp directory.
 */
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quickStart } from "../app/quick-start.ts";
import { Conversation } from "../harness/conversation.ts";
import { nodeHost } from "../hosts/node.ts";
import { Git } from "../src/index.ts";

const host = nodeHost();
const person = { name: "p", email: "p@p" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function repo(dir: string): Promise<Git> {
  const git = await Git.init(host, dir, { branch: "main" });
  await writeFile(join(dir, "a.txt"), "one\n");
  await git.add(["."]);
  await git.commit({ message: "c1", author: person, committer: person });
  return git;
}

/** Rename `from` to `to`, retrying for two seconds; says how many tries it took, or the error. */
async function tryRename(from: string, to: string): Promise<string> {
  const start = Date.now();
  let last = "";
  for (let n = 1; Date.now() - start < 2000; n++) {
    try {
      await rename(from, to);
      return n === 1 ? "renamed at once" : `renamed after ${n} tries (${Date.now() - start} ms): first error ${last}`;
    } catch (e) {
      last = last === "" ? ((e as NodeJS.ErrnoException).code ?? String(e)) : last;
      await sleep(100);
    }
  }
  return `FAILED for 2 s: ${last}`;
}

const steps: [string, (work: string) => Promise<string>][] = [
  [
    "a repository alone",
    async (w) => {
      await repo(join(w, "code"));
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
  [
    "a junction elsewhere points at it",
    async (w) => {
      await repo(join(w, "code"));
      await mkdir(join(w, "conv"));
      await symlink(join(w, "code"), join(w, "conv", "link"), "junction");
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
  [
    "a junction, and git has run through it",
    async (w) => {
      const git = await repo(join(w, "code"));
      await mkdir(join(w, "conv"));
      await symlink(join(w, "code"), join(w, "conv", "link"), "junction");
      await (await Git.open(host, { cwd: join(w, "conv", "link") })).status();
      void git;
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
  [
    "a linked worktree of it exists",
    async (w) => {
      const git = await repo(join(w, "code"));
      await git.run(["worktree", "add", "--detach", join(w, "wt"), "HEAD"]);
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
  [
    "quick start, then at once",
    async (w) => {
      await repo(join(w, "code"));
      await quickStart({ host, cwd: w, env: { CHATTREE_DATA: join(w, "data") }, now: Date.now }, { code: join(w, "code"), key: "." });
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
  [
    "quick start, then a conversation opened on it and closed",
    async (w) => {
      await repo(join(w, "code"));
      const { project } = await quickStart(
        { host, cwd: w, env: { CHATTREE_DATA: join(w, "data") }, now: Date.now },
        { code: join(w, "code"), key: "." },
      );
      const convo = await Conversation.open(host, project);
      await convo.close();
      return tryRename(join(w, "code"), join(w, "moved"));
    },
  ],
];

console.log(`${process.platform} node ${process.version}`);
for (const [name, run] of steps) {
  const w = await mkdtemp(join(tmpdir(), "rename-probe-"));
  try {
    console.log(`${name}: ${await run(w)}`);
  } catch (e) {
    console.log(`${name}: ERROR ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await rm(w, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
