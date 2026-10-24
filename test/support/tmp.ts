import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Git } from "../../src/index.ts";
import { nodeHost } from "../../hosts/node.ts";

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A fresh temporary directory, removed when the test run ends. */
export async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), "chattree-")));
  dirs.push(d);
  return d;
}

export const identity = { name: "Test User", email: "test@example.com" };

/** A fresh repository with a fixed identity configured locally. */
export async function newRepo(): Promise<Git> {
  const host = nodeHost();
  const git = await Git.init(host, join(await tempDir(), "repo"), {});
  await git.setConfig("user.name", identity.name);
  await git.setConfig("user.email", identity.email);
  return git;
}
