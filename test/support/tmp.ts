import { cp, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Git } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";

const dirs: string[] = [];

// A background process (git maintenance, a closing session) can still be writing when the run ends: retry instead of failing the hook.
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined))); // best effort: a temp directory left behind must not fail the run
});

/** A fresh temporary directory, removed when the test run ends. */
export async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "chattree-")));
  dirs.push(d);
  return d;
}

export const identity = { name: "Test User", email: "test@example.com" };

let template: Promise<string> | undefined;

/** A repository with the test identity set, made once per process and copied: starting git three times per test is slow, copying a directory is not. */
function repoTemplate(): Promise<string> {
  template ??= (async () => {
    const git = await Git.init(nodeHost(), join(await tempDir(), "template"), {});
    await git.setConfig("user.name", identity.name);
    await git.setConfig("user.email", identity.email);
    return git.cwd;
  })();
  return template;
}

/** A fresh repository with a fixed identity configured locally. */
export async function newRepo(): Promise<Git> {
  const dir = join(await tempDir(), "repo");
  await cp(await repoTemplate(), dir, { recursive: true });
  return Git.open(nodeHost(), { cwd: dir });
}
