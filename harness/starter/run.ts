import type { RunOutcome } from "../../src/host.ts";
import { CommandSyntax, parseCommand, type ParsedCommand } from "./command.ts";
import { GlobError, expandGlob } from "./glob.ts";
import { NotAvailable, portableStage, shellStage } from "./portable.ts";
import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import { isStarted, type Tool, type ToolContext, type ToolOutput } from "../tools.ts";
import { batchProblem, batchStage, findProgram, isBatch, localAllowed } from "./batch.ts";
import { runAllowKeys, runCovers, validateRunKey } from "./run-keys.ts";

/**
 * `run` and `script` (docs/tools.md, 4.1). `run` takes one command line in a small bash-like syntax that `command.ts`
 * parses (no shell is involved), so what the user approves is the parsed programs and arguments. `script` is the
 * escape hatch: a string for POSIX `sh -c`.
 */

export interface RunToolOptions {
  /** Which environment variables `$VAR` may read, and their values. Default: none. `"*"` allows every name in `values`. */
  env?: { allow: readonly string[] | "*"; values: Readonly<Record<string, string | undefined>> };
  /** Environment variable names to hide from commands, besides anything that looks like a secret. */
  secretEnv?: readonly string[];
  /** Windows: allow `.cmd` and `.bat` programs (`tools.run.batch`). Default false: they are refused with a message that says what to set. */
  batch?: boolean;
  /** Windows: globs (relative to the workspace) of batch files inside the workspace that may be started (`tools.run.local`). */
  batchLocal?: readonly string[];
  /** The host's own environment (`PATH`, `ComSpec`), for finding programs. Not what commands may read: that is `env`. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Command prefixes known to be read-only (`tools.run.safe` in harness.yml): a grant for one is offered as `<prefix> **`. Default: none. */
  safe?: readonly string[];
  /** Default timeout for a command (seconds). Default 120. */
  timeoutSeconds?: number;
  /** Path to busybox.exe, which stands in for common utilities (cat, ls, grep, ...) on Windows. */
  busybox?: string | undefined;
}

const MAX_TIMEOUT = 3600;
/** Names that look like credentials are not passed to commands. */
export const SECRET_ENV_PATTERN = "(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY)($|_)";
const MAX_REDIRECT_BYTES = 64 * 1024 * 1024;
const dec = new TextDecoder();

class RunRefused extends Error {}

/** Replace `$VAR` and `${VAR}` in one argument, only for allowed names. */
export function expandEnv(arg: string, opts: RunToolOptions["env"]): string {
  return arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b) as string;
    const allowed = opts !== undefined && (opts.allow === "*" || opts.allow.includes(name));
    if (!allowed) throw new RunRefused(`$${name} is not an allowed environment variable (names are listed under tools.env in harness.yml); for a literal $ use the script tool`);
    const v = opts?.values[name];
    if (v === undefined) throw new RunRefused(`$${name} is not set`);
    return v;
  });
}

/** Environment lookup for the command parser: allowed names only. */
const envLookup = (opts: RunToolOptions["env"]) => (name: string): string => expandEnv(`$${name}`, opts);

async function prepare(parsed: ParsedCommand, ctx: ToolContext, opts: RunToolOptions): Promise<{ stages: string[][]; verbatim: boolean[] }> {
  const out: string[][] = [];
  const verbatim: boolean[] = [];
  for (const stage of parsed.stages) {
    const words: string[] = [];
    for (const [k, w] of stage.entries()) {
      if (w.glob && k > 0) {
        const hits = await expandGlob(ctx.host, ctx.workspace, w.text);
        if (hits.length === 0) throw new RunRefused(`${w.text}: no file matches`);
        words.push(...hits);
      } else words.push(w.text);
    }
    const mapped = portableStage(words, ctx.host.platform, opts.busybox);
    if (ctx.host.platform === "windows" && mapped[0] === words[0]) {
      const found = await findProgram(ctx.host, ctx.workspace, words[0] as string, opts.hostEnv ?? {});
      if (found !== undefined && isBatch(found.path)) {
        if (opts.batch !== true) throw new RunRefused(`${words[0]} is a batch program (${found.path}), which run does not start by default because cmd.exe re-interprets its arguments; the user can allow it with tools.run.batch: true in harness.yml`);
        if (found.local !== undefined && !localAllowed(found.local, opts.batchLocal ?? [])) throw new RunRefused(`${words[0]} resolves to ${found.local}, a batch file inside the workspace, and tools.run.local in harness.yml does not list it (for example ./node_modules/.bin/*.cmd)`);
        const problem = batchProblem(found.path, words.slice(1));
        if (problem !== undefined) throw new RunRefused(`${words[0]}: ${problem}`);
        out.push(batchStage(opts.hostEnv?.["ComSpec"] ?? opts.hostEnv?.["COMSPEC"] ?? "cmd.exe", found.path, words.slice(1)));
        verbatim.push(true);
        continue;
      }
    }
    out.push(mapped);
    verbatim.push(false);
  }
  return { stages: out, verbatim };
}

function report(outcome: RunOutcome, timeoutSeconds: number, extra: string[]): ToolOutput {
  const lines = [`exit ${outcome.exitCode}${outcome.stageCodes.length > 1 ? ` (stages: ${outcome.stageCodes.join(", ")})` : ""}`];
  if (outcome.timedOut) lines.push(`timed out after ${timeoutSeconds} seconds and was killed`);
  if (outcome.aborted && !outcome.timedOut) lines.push("stopped before it finished");
  const text = dec.decode(outcome.output);
  lines.push(text === "" ? "(no output)" : text.replace(/\n$/, ""));
  if (outcome.dropped > 0) lines.push(`(${outcome.dropped} more bytes of output were discarded)`);
  lines.push(...extra);
  return { content: lines.join("\n"), is_error: outcome.exitCode !== 0 || outcome.timedOut || outcome.aborted };
}

const timeoutProp = { type: "integer", minimum: 1, maximum: MAX_TIMEOUT, description: `Seconds before the command is killed. Default 120 (3600 with background), at most ${MAX_TIMEOUT}.` };

const backgroundProp = { type: "boolean", description: "Start it as a background job and return at once, for something long (a build, a server, a test run). You are told when it ends; the jobs, job_output and job_stop tools manage it. Default false." };

/** Let a tool be started as a background job (`background: true`): the same execution, not tied to the turn, with a long default timeout. */
function backgroundable(tool: Tool, label: (args: Record<string, unknown>) => string): Tool {
  const inner = tool.execute;
  const schema = tool.definition.input_schema as { properties: Record<string, unknown> };
  return {
    ...tool,
    background: true,
    definition: { ...tool.definition, input_schema: { ...schema, properties: { ...schema.properties, background: backgroundProp } } as never },
    async execute(args, ctx) {
      if (args["background"] !== true) return inner(args, ctx);
      const stop = new AbortController();
      const { background: _b, ...rest } = args;
      const done = inner({ timeout_seconds: 3600, ...rest }, { ...ctx, signal: stop.signal }).then(
        (r): ToolOutput => (isStarted(r) ? { content: "nested background job", is_error: true } : r),
        (e: unknown): ToolOutput => ({ content: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true }),
      );
      return { started: { summary: label(args), done, stop: () => stop.abort() } };
    },
  };
}

const oneLine = (s: string, max = 80): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export function runTool(opts: RunToolOptions = {}): Tool {
  return backgroundable(plainRunTool(opts), (a) => `run: ${oneLine(a["command"] as string)}`);
}

export function scriptTool(opts: RunToolOptions = {}): Tool {
  return backgroundable(plainScriptTool(opts), (a) => `script: ${oneLine((a["script"] as string).split("\n")[0] ?? "")}`);
}

function plainRunTool(opts: RunToolOptions): Tool {
  return {
    definition: {
      name: "run",
      description:
        "Run a command in the workspace, written in a cross-platform bash-like syntax with common shell utilities (cat, ls, grep, sed, sort, wc, ...), as well as programs available to the host (git, node, ...). It is not a real shell: the supported syntax is quotes, `|` pipes, `<` `>` `>>` with workspace files, `*` `?` `[...]` `{a,b}` globs, `2>&1`, and `$NAME` for environment variables the user has allowed. Not supported: `;` `&&` `||` `&`, loops and conditions (`for`, `while`, `if`), `$(...)`, backticks, subshells, heredocs, `VAR=x cmd` and `~` (use the script tool for those, which needs the user's approval). Returns the exit code, then stdout and stderr in the order they were produced.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", description: "One command or pipeline on a single line, for example: grep -n TODO src/*.ts | sort | head -20" },
          timeout_seconds: timeoutProp,
        },
      },
    },
    allowKeys: (args, ctx) => runAllowKeys(args["command"] as string, { ...ctx, expand: envLookup(opts.env), safe: opts.safe ?? [] }),
    covers: (keys, args, ctx) => runCovers(keys, args["command"] as string, { ...ctx, expand: envLookup(opts.env), safe: opts.safe ?? [] }),
    validateKey: validateRunKey,
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      if (host.run === undefined) return { content: "this host cannot run commands", is_error: true };
      const timeout = Math.min((args["timeout_seconds"] as number | undefined) ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      try {
        const parsed = parseCommand(args["command"] as string, envLookup(opts.env));
        const { stages, verbatim } = await prepare(parsed, ctx, opts);
        let stdin: Uint8Array | undefined;
        if (parsed.stdin !== undefined) {
          const abs = await resolveInWorkspace(host, workspace, parsed.stdin.text, "read");
          const st = await host.fs.stat(abs);
          if (st === undefined || !st.isFile) throw new RunRefused(`${parsed.stdin.text}: no such file`);
          if (st.size > MAX_REDIRECT_BYTES) throw new RunRefused(`${parsed.stdin.text} is too large to use as input`);
          stdin = await host.fs.read(abs);
        }
        let target: string | undefined;
        const out = parsed.stdout;
        if (out !== undefined && out.target !== "discard") {
          target = await resolveInWorkspace(host, workspace, out.target.text, "write");
          if ((await host.fs.stat(target))?.isDirectory === true) throw new RunRefused(`${out.target.text} is a directory`);
        }
        const outcome = await host.run({
          stages,
          ...(verbatim.some((v) => v) ? { verbatim } : {}),
          cwd: workspace,
          ...(stdin === undefined ? {} : { stdin }),
          ...(out === undefined ? {} : { captureStdout: true, maxOutput: MAX_REDIRECT_BYTES }),
          unsetEnv: opts.secretEnv ?? [],
          unsetEnvPattern: SECRET_ENV_PATTERN,
          timeoutMs: timeout * 1000,
          signal: ctx.signal,
        });
        const extra: string[] = [];
        if (target !== undefined && outcome.stdout !== undefined) {
          if (out?.append === true) await host.fs.append(target, outcome.stdout);
          else await host.fs.writeAtomic(target, outcome.stdout, { keepMode: true });
          extra.push(`stdout ${out?.append === true ? "appended to" : "written to"} ${display(host, workspace, target)} (${outcome.stdout.length} bytes)`);
        }
        return report(outcome, timeout, extra);
      } catch (e) {
        if (e instanceof RunRefused || e instanceof CommandSyntax || e instanceof NotAvailable || e instanceof GlobError || e instanceof PathRefused) return { content: e.message, is_error: true };
        throw e;
      }
    },
  };
}

function plainScriptTool(opts: RunToolOptions): Tool {
  return {
    definition: {
      name: "script",
      description:
        "Run a POSIX sh script (`sh -c`; on Windows busybox's ash) in the workspace. Plain POSIX only: no bash extras such as `{1..3}`, `[[ ]]` or arrays (write `for i in 1 2 3` or use `seq`). Use it for shell syntax (&&, ;, loops, $(...), redirecting stderr, $variables) that the run tool does not do. It always needs the user's approval, so prefer run for a single command. Other languages (bash, python, powershell) are started with run when the host has them. Returns the exit code, then stdout and stderr in the order they were produced.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["script"],
        properties: {
          script: { type: "string", description: "The script text, passed to sh -c." },
          timeout_seconds: timeoutProp,
        },
      },
    },
    async execute(args, ctx) {
      if (ctx.host.run === undefined) return { content: "this host cannot run commands", is_error: true };
      const timeout = Math.min((args["timeout_seconds"] as number | undefined) ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      let stage: string[];
      try {
        stage = shellStage(args["script"] as string, ctx.host.platform, opts.busybox);
      } catch (e) {
        if (e instanceof NotAvailable) return { content: e.message, is_error: true };
        throw e;
      }
      const outcome = await ctx.host.run({
        stages: [stage],
        cwd: ctx.workspace,
        unsetEnv: opts.secretEnv ?? [],
        unsetEnvPattern: SECRET_ENV_PATTERN,
        timeoutMs: timeout * 1000,
        signal: ctx.signal,
      });
      return report(outcome, timeout, []);
    },
  };
}
