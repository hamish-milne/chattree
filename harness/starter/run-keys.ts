import type { ApprovalContext } from "../tools.ts";
import { CommandSyntax, parseCommand, type Word } from "./command.ts";
import { expandGlob } from "./glob.ts";
import { PathRefused, resolveInWorkspace } from "./workspace.ts";

/**
 * Approval keys for `run` (docs/tools.md, section 5). A key is one pipeline stage written as a command line with
 * patterns, optionally with redirects: `grep **`, `git status **`, `node ./tools/*.ts`, `grep ** > ./**`.
 *
 * - `*` as a whole word is any one argument; `**` as the last word is any number of arguments (including none).
 * - Any other word is a glob (`*` and `?` stay inside one path segment, `**` crosses them, `[...]` is a class) and a
 *   candidate is covered when it matches, so `./**` is any file in the workspace. A candidate that is itself a glob is
 *   expanded against the workspace first, so what is compared is the files it names.
 * - A redirect in a key (`< pattern`, `> pattern`, `>> pattern`) allows that redirect to targets matching the pattern; a call
 *   with a redirect no key mentions is not covered. `>` also covers `>>`. `/dev/null` needs no key.
 * - A pipeline is covered when every stage is covered by some key, not necessarily the same one.
 * - Nothing that resolves outside the workspace is ever covered: such a call is asked every time.
 * - A key with a wildcard never covers a program that runs other programs (`xargs`, `env`, `sh`...), nor an argument that
 *   writes (`sed -i`, `sort -o`, `find -delete`, `--output`...). A key with no wildcard is exactly what the user saw.
 */

/** Programs that run other programs or write files whatever their arguments: never grantable with a wildcard. */
export const RUNNERS = new Set(["xargs", "env", "sh", "bash", "dash", "ash", "zsh", "busybox", "tee", "nohup", "nice", "time", "timeout", "watch", "exec", "sudo", "doas", "su", "eval", "command", "script"]);

/** Arguments that make an otherwise read-only program write or execute, by program (`*` for every program). */
const WRITING_ARGS: Record<string, RegExp[]> = {
  "*": [/^--output(=|$)/, /^--in-place(=|$)/, /^--exec/],
  sed: [/^-[a-zA-Z]*i/], // a script that writes (`w file`, `s///w`, `e`) cannot be told from text: keep sed out of `safe` unless you accept that
  sort: [/^-[a-zA-Z]*o/],
  find: [/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/],
  awk: [/system\s*\(/, /print[^;}]*>/, /\|\s*getline/, /"\s*\|/],
  git: [/^-c$/, /^--ext-diff$/, /^--textconv$/],
};

export interface RunKeyContext extends ApprovalContext {
  /** `$NAME` expansion for the command parser (throws for a name that is not allowed). */
  expand: (name: string) => string;
  /** `tools.run.safe` from harness.yml: command prefixes known to be read-only, grantable as `<prefix> **`. */
  safe: readonly string[];
}

interface Redirect {
  target: string;
  append: boolean;
}
interface KeyPattern {
  words: string[];
  stdin?: string;
  stdout?: Redirect;
}

const hasWildcard = (w: string): boolean => /[*?[]/.test(w);
const quote = (w: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) || (/[*?]/.test(w) && !/[\s'"\\]/.test(w)) ? w : `'${w.replaceAll("'", "'\\''")}'`);
const slash = (s: string): string => s.replaceAll("\\", "/");

/** Parse a key, or say why it is not one. */
export function parseKey(key: string): KeyPattern | string {
  let parsed;
  try {
    parsed = parseCommand(key, () => {
      throw new CommandSyntax("$ is not allowed in a key");
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (parsed.stages.length !== 1) return "a key is one command, not a pipeline: grant each stage on its own";
  const words = (parsed.stages[0] as Word[]).map((w) => w.text);
  const program = words[0] as string;
  if (hasWildcard(program)) return "the program in a key must be written out, without wildcards";
  const middle = words.slice(1, -1).indexOf("**");
  if (middle >= 0) return `** can only be the last word (it is word ${middle + 2})`;
  const out: KeyPattern = { words };
  if (parsed.stdin !== undefined) out.stdin = parsed.stdin.text;
  if (parsed.stdout !== undefined) {
    if (parsed.stdout.target === "discard") return "/dev/null needs no key";
    out.stdout = { target: parsed.stdout.target.text, append: parsed.stdout.append };
  }
  if (words.some(hasWildcard) || out.stdin !== undefined || out.stdout !== undefined) {
    if (RUNNERS.has(program)) return `${program} runs other programs, so it cannot be granted with a pattern; allow it once, or write the exact command`;
  }
  return out;
}

/** Why a key is not usable for `run`, or undefined. */
export function validateRunKey(key: string): string | undefined {
  try {
    const k = parseKey(key);
    return typeof k === "string" ? k : undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A glob as a regular expression over a whole string: `*` and `?` stop at `/`, `**` does not. */
export function globRegex(pat: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i] as string;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
        if (pat[i + 1] === "/") re = re.slice(0, -2) + "(?:.*/)?", i++; // `a/**/b` also matches `a/b`
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = pat.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        const body = pat.slice(i + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\");
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** Candidate paths are compared as `./relative` against patterns that start with `./`, so `./**` is any file in the workspace. */
function normalise(ctx: ApprovalContext, pattern: string, candidate: string): string {
  if (!pattern.startsWith("./") && pattern !== ".") return candidate;
  if (candidate.startsWith("-") || candidate.includes("\0")) return candidate;
  const abs = ctx.host.path.resolve(ctx.workspace, candidate);
  const rel = slash(ctx.host.path.relative(ctx.workspace, abs));
  if (rel === ".." || rel.startsWith("../") || ctx.host.path.isAbsolute(rel)) return candidate;
  return rel === "" ? "." : `./${rel}`;
}

const wordMatches = (ctx: ApprovalContext, pattern: string, candidate: string): boolean => globRegex(pattern).test(normalise(ctx, pattern, candidate));

/** Does the argument list match the key's words (`*` one argument, a last `**` the rest)? */
function argvMatches(ctx: ApprovalContext, key: readonly string[], groups: readonly (readonly string[])[]): boolean {
  const last = key[key.length - 1] === "**";
  const fixed = last ? key.slice(0, -1) : key;
  if (last ? groups.length < fixed.length : groups.length !== fixed.length) return false;
  return fixed.every((p, i) => (i === 0 ? p === groups[0]?.[0] : p === "*" || (groups[i] as readonly string[]).every((c) => wordMatches(ctx, p, c))));
}

function writesOrRuns(argv: readonly string[]): boolean {
  const program = argv[0] as string;
  if (RUNNERS.has(program)) return true;
  const rules = [...(WRITING_ARGS["*"] ?? []), ...(WRITING_ARGS[program] ?? [])];
  return argv.slice(1).some((a) => rules.some((r) => r.test(a)));
}

/** One stage of a call, with its globs expanded and its program and arguments as plain strings. */
interface Stage {
  /** As written (variables expanded, globs not). */
  written: string[];
  /** As the program will see them. */
  argv: string[];
  /** The same, grouped by the written word each came from (a glob word is several arguments). */
  groups: string[][];
}
interface Plan {
  stages: Stage[];
  stdin?: string;
  stdout?: Redirect;
}

/** Parse and expand a call's command; undefined when it will not run anyway (a syntax error, a glob that matches nothing). */
async function plan(command: string, ctx: RunKeyContext): Promise<Plan | undefined> {
  try {
    const parsed = parseCommand(command, ctx.expand);
    const stages: Stage[] = [];
    for (const words of parsed.stages) {
      const groups: string[][] = [];
      for (const [k, w] of words.entries()) {
        if (w.glob && k > 0) {
          const hits = await expandGlob(ctx.host, ctx.workspace, w.text);
          if (hits.length === 0) return undefined;
          groups.push(hits);
        } else groups.push([w.text]);
      }
      stages.push({ written: words.map((w) => w.text), argv: groups.flat(), groups });
    }
    const out: Plan = { stages };
    if (parsed.stdin !== undefined) out.stdin = parsed.stdin.text;
    if (parsed.stdout !== undefined && parsed.stdout.target !== "discard") out.stdout = { target: parsed.stdout.target.text, append: parsed.stdout.append };
    return out;
  } catch {
    return undefined;
  }
}

/** Every argument and redirect that names something must stay inside the workspace (symbolic links followed). */
async function inside(ctx: ApprovalContext, p: Plan): Promise<boolean> {
  const check = async (arg: string, mode: "read" | "write"): Promise<boolean> => {
    if (arg === "" || arg.includes("\0")) return true;
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg.startsWith("-") ? "" : arg;
    if (value === "") return true;
    try {
      await resolveInWorkspace(ctx.host, ctx.workspace, value, mode);
      return true;
    } catch (e) {
      if (e instanceof PathRefused) return false;
      throw e;
    }
  };
  for (const s of p.stages) for (const a of s.argv.slice(1)) if (!(await check(a, "read"))) return false;
  if (p.stdin !== undefined && !(await check(p.stdin, "read"))) return false;
  if (p.stdout !== undefined && !(await check(p.stdout.target, "write"))) return false;
  return true;
}

const redirectCovered = (ctx: ApprovalContext, key: Redirect | string | undefined, call: Redirect | string, kind: "in" | "out"): boolean => {
  if (key === undefined) return false;
  const kt = typeof key === "string" ? key : key.target;
  const ct = typeof call === "string" ? call : call.target;
  if (kind === "out" && typeof call !== "string" && typeof key !== "string" && call.append === false && key.append === true) return false; // `>>` does not allow `>`
  return wordMatches(ctx, kt, ct);
};

/** The keys, among `keys`, that together cover the call; undefined if they do not. */
export async function runCovers(keys: readonly string[], command: string, ctx: RunKeyContext): Promise<string[] | undefined> {
  const p = await plan(command, ctx);
  if (p === undefined || !(await inside(ctx, p))) return undefined;
  const parsedKeys = keys.flatMap((k) => {
    const pk = parseKey(k);
    return typeof pk === "string" ? [] : [{ key: k, pk }];
  });
  const used = new Set<string>();
  for (const [i, stage] of p.stages.entries()) {
    const wantIn = i === 0 ? p.stdin : undefined;
    const wantOut = i === p.stages.length - 1 ? p.stdout : undefined;
    const hit = parsedKeys.find(({ pk }) => {
      if (!argvMatches(ctx, pk.words, stage.groups)) return false;
      const wildcard = pk.words.some(hasWildcard) || pk.stdin !== undefined || pk.stdout !== undefined;
      if (wildcard && writesOrRuns(stage.argv)) return false;
      if (wantIn !== undefined && !redirectCovered(ctx, pk.stdin, wantIn, "in")) return false;
      if (wantOut !== undefined && !redirectCovered(ctx, pk.stdout, wantOut, "out")) return false;
      return true;
    });
    if (hit === undefined) return undefined;
    used.add(hit.key);
  }
  return [...used];
}

/** The keys a grant for this call would add: one per stage, or null when the call can only be allowed once. */
export async function runAllowKeys(command: string, ctx: RunKeyContext): Promise<string[] | null> {
  const p = await plan(command, ctx);
  if (p === undefined || !(await inside(ctx, p))) return null;
  const keys = new Set<string>();
  for (const [i, stage] of p.stages.entries()) {
    const wantIn = i === 0 ? p.stdin : undefined;
    const wantOut = i === p.stages.length - 1 ? p.stdout : undefined;
    const program = stage.argv[0] as string;
    const safe = ctx.safe.map((s) => s.trim().split(/\s+/)).find((prefix) => prefix.length <= stage.argv.length && prefix.every((w, k) => w === stage.argv[k]) && !RUNNERS.has(prefix[0] as string));
    let parts: string[];
    if (safe !== undefined && !writesOrRuns(stage.argv)) {
      parts = [...safe.map(quote), "**"];
      if (wantIn !== undefined) parts.push("<", "./**");
      if (wantOut !== undefined) parts.push(wantOut.append ? ">>" : ">", "./**");
    } else {
      const words = stage.written; // not a command the user listed as safe: exactly what they saw, so what they allow is what they read
      parts = words.map(quote);
      if (wantIn !== undefined) parts.push("<", quote(wantIn));
      if (wantOut !== undefined) parts.push(wantOut.append ? ">>" : ">", quote(wantOut.target));
    }
    const key = parts.join(" ");
    if (validateRunKey(key) !== undefined) return null; // for example a runner written out: allowed once only
    keys.add(key);
  }
  return [...keys];
}
