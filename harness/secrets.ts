import { Git, type Host } from "../src/index.ts";

/**
 * Where secret values come from (docs/providers.md, P7). `harness.yml` holds only the *names* of environment
 * variables; the core never reads `process.env` itself. A `SecretSource` is injected: the Node entry point passes the
 * process environment to `repoSecretSource`, which adds a file that git cannot commit.
 */
export interface SecretSource {
  get(name: string): Promise<string | undefined>;
}

export class SecretFileError extends Error {
  override name = "SecretFileError";
}

/** Dotenv syntax: `NAME=value`, optional `export `, `#` comments, single or double quotes. No interpolation. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    let v = (m[2] as string).trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    out.set(m[1] as string, v);
  }
  return out;
}

export const envSource = (env: Record<string, string | undefined>): SecretSource => ({ get: async (name) => env[name] });

/** The first source that has a non-empty value wins. */
export function layered(...sources: readonly SecretSource[]): SecretSource {
  return {
    async get(name) {
      for (const s of sources) {
        const v = await s.get(name);
        if (v !== undefined && v !== "") return v;
      }
      return undefined;
    },
  };
}

/**
 * The environment first, then `<worktree>/.chattree/env`, then `<git-common-dir>/chattree/env`.
 *
 * The file inside `.git/` is shared by every worktree and cannot be committed by `git add` (even with `-f`). The
 * worktree file is read **only if git says it is ignored**; otherwise loading fails with an explanation, because
 * the next `git add -A` would commit the keys. Files are read when first needed.
 */
export function repoSecretSource(host: Host, dir: string, env: Record<string, string | undefined>): SecretSource {
  let files: Promise<SecretSource> | undefined;
  const load = async (): Promise<SecretSource> => {
    const git = await Git.open(host, { cwd: dir });
    const read = async (path: string): Promise<Map<string, string>> => ((await host.fs.stat(path)) === undefined ? new Map() : parseDotenv(new TextDecoder().decode(await host.fs.read(path))));
    const local = host.path.join(dir, ".chattree", "env");
    let worktree = new Map<string, string>();
    if ((await host.fs.stat(local)) !== undefined) {
      const ignored = (await git.run(["check-ignore", "-q", "--", ".chattree/env"], { ok: [1], readOnly: true })).exitCode === 0;
      if (!ignored) throw new SecretFileError(`${local} exists but git does not ignore it, so \`git add\` could commit your keys. Add "/.chattree/" to .gitignore, or move the keys to .git/chattree/env`);
      worktree = await read(local);
    }
    const shared = await read(host.path.join(await git.commonDir(), "chattree", "env"));
    return layered({ get: async (n) => worktree.get(n) }, { get: async (n) => shared.get(n) });
  };
  return layered(envSource(env), { get: async (n) => (await (files ??= load())).get(n) });
}

/** Patterns that remove the secrets from everything written to the transcript. Values shorter than 8 characters are skipped: they would mangle ordinary text. */
export function redactionPatterns(values: readonly string[]): RegExp[] {
  return [...new Set(values)].filter((v) => v.length >= 8).map((v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
}
