/**
 * Attached repositories that are not children of the conversation's project (ADR 38): the code stays where it is, and the project
 * folder has a link with a name of its own that points at it. The link is this machine's business, so it is kept out of git
 * (`info/exclude`) and listed in the repository's own configuration (`chattree.external`); what is tracked is `attached.yml`, which
 * records the state of the code under that name exactly as it does for a submodule.
 *
 * A link that is gone or points somewhere else is made again by `relinkExternal`, which is how a code repository that was moved or
 * renamed is found: whoever knows where it is now says so.
 */
import type { Host } from "../src/index.ts";
import { Git } from "../src/index.ts";
import { AttachedError, EXTERNAL_KEY, externalAttached } from "./attached.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function excludeFile(host: Host, git: Git): Promise<string> {
  return host.path.join(await git.commonDir(), "info", "exclude");
}

async function editExclude(host: Host, git: Git, name: string, present: boolean): Promise<void> {
  const file = await excludeFile(host, git);
  const text = (await host.fs.stat(file)) === undefined ? "" : new TextDecoder().decode(await host.fs.read(file));
  const lines = text.split("\n");
  const entry = `/${name}`;
  const has = lines.includes(entry);
  if (present === has) return;
  const next = present ? [...lines.filter((l, i) => l !== "" || i < lines.length - 1), entry] : lines.filter((l) => l !== entry);
  await host.fs.writeAtomic(file, new TextEncoder().encode(`${next.join("\n").replace(/\n+$/, "")}\n`));
}

/** Where the code repository is: the top level of a git repository with at least one commit. Throws what is wrong. */
async function codeRoot(host: Host, target: string): Promise<string> {
  const probe = await Git.open(host, { cwd: target }).catch(() => undefined);
  const top = await probe?.run(["rev-parse", "--show-toplevel"], { ok: [128], readOnly: true });
  if (probe === undefined || top === undefined || top.exitCode !== 0) throw new AttachedError(`${target} is not in a git repository`);
  const root = probe.hostPath(new TextDecoder().decode(top.stdout).trim());
  if ((await probe.withCwd(root).revParse("HEAD")) === undefined)
    throw new AttachedError(`${root} has no commits yet: make a first commit there (git commit --allow-empty -m start), then attach it`);
  return root;
}

const same = async (host: Host, a: string, b: string): Promise<boolean> => {
  const [x, y] = await Promise.all([host.fs.realpath(a), host.fs.realpath(b)]);
  return x !== undefined && x === y;
};

/**
 * Make `name` in the project folder a link to the code repository at `target` and list it, so every later snapshot, merge and thread
 * folder treats it as attached. Makes it again when it points elsewhere. Does not record anything in the transcript: the next entry does.
 */
export async function relinkExternal(host: Host, git: Git, name: string, target: string): Promise<void> {
  if (!NAME.test(name))
    throw new AttachedError(`${JSON.stringify(name)} is not a name a link can have: use letters, digits, '.', '_' and '-'`);
  if (host.fs.link === undefined) throw new AttachedError("this host cannot make links to a folder");
  const root = await codeRoot(host, target);
  const link = host.path.join(git.cwd, name);
  if (await same(host, link, root)) {
    // Right already; make sure it is listed and kept out of git.
  } else {
    // Only a link is replaced: a real directory (a submodule, or anything of the person's) is theirs, and `remove` refuses it.
    const removed = await host.fs.remove(link).then(
      () => true,
      () => false,
    );
    if (!removed && (await host.fs.stat(link)) !== undefined)
      throw new AttachedError(`${link} is in the way and is not a link: move it aside, then attach again`);
    await host.fs.link(root, link);
  }
  await editExclude(host, git, name, true);
  if (!(await externalAttached(git)).includes(name)) await git.run(["config", "--local", "--add", EXTERNAL_KEY, name]);
}

/** Stop treating `name` as attached: the link, its entry in the list and its line in `info/exclude` go; the code is not touched. */
export async function detachExternal(host: Host, git: Git, name: string): Promise<void> {
  await host.fs.remove(host.path.join(git.cwd, name)).catch(() => false);
  await editExclude(host, git, name, false);
  await git.run(["config", "--local", "--unset-all", EXTERNAL_KEY, `^${name.replace(/[.]/g, "\\.")}$`], { ok: [5] });
}

/** Where the link `name` points now (undefined if there is no link or its target has gone). */
export async function externalTarget(host: Host, git: Git, name: string): Promise<string | undefined> {
  return host.fs.realpath(host.path.join(git.cwd, name));
}
