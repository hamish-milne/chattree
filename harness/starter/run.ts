import type { RunOutcome } from "../../src/host.ts";
import { GlobError, expandGlob, hasGlob } from "./glob.ts";
import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import type { Tool, ToolContext, ToolOutput } from "../tools.ts";

/**
 * `run` and `script` (docs/tools.md, 4.1). `run` starts programs directly from an argument list, with pipes and
 * redirects as structure, so what the user approves is programs and arguments and not a string to parse. `script`
 * is the escape hatch: a string for `bash -c`.
 */

export interface RunToolOptions {
  /** Which environment variables `$VAR` may read, and their values. Default: none. `"*"` allows every name in `values`. */
  env?: { allow: readonly string[] | "*"; values: Readonly<Record<string, string | undefined>> };
  /** Environment variable names to hide from commands, besides anything that looks like a secret. */
  secretEnv?: readonly string[];
  /** Default timeout for a command (seconds). Default 120. */
  timeoutSeconds?: number;
}

const MAX_TIMEOUT = 600;
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

async function prepare(stages: readonly (readonly string[])[], ctx: ToolContext, opts: RunToolOptions, glob: boolean): Promise<string[][]> {
  const out: string[][] = [];
  for (const stage of stages) {
    const [program, ...args] = stage as readonly [string, ...string[]];
    const expanded: string[] = [];
    for (const raw of args) {
      const arg = expandEnv(raw, opts.env);
      if (glob && hasGlob(arg)) {
        const hits = await expandGlob(ctx.host, ctx.workspace, arg);
        if (hits.length === 0) throw new RunRefused(`${arg}: no file matches`);
        expanded.push(...hits);
      } else expanded.push(arg);
    }
    out.push([expandEnv(program, opts.env), ...expanded]);
  }
  return out;
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

const timeoutProp = { type: "integer", minimum: 1, maximum: MAX_TIMEOUT, description: `Seconds before the command is killed. Default 120, at most ${MAX_TIMEOUT}.` };

export function runTool(opts: RunToolOptions = {}): Tool {
  return {
    definition: {
      name: "run",
      description:
        "Run a program in the workspace, started directly with no shell: `argv` is the program followed by its arguments, so quotes, `|`, `>`, `$` and `*` in an argument are passed through literally. To pipe, give the later commands in `pipe_to`, each reading the previous one's output. `stdin` and `stdout` name workspace files to read from and write to (`append` adds to the file). `$NAME` in an argument is replaced only for environment variables the user has allowed, and `glob: true` expands arguments containing * ? [ or { to the matching files. Returns the exit code, then stdout and stderr in the order they were produced. For shell syntax (&&, loops, redirecting stderr) use the script tool.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["argv"],
        properties: {
          argv: { type: "array", minItems: 1, items: { type: "string" }, description: "The program, then its arguments." },
          pipe_to: { type: "array", description: "Further commands, each fed the previous command's stdout.", items: { type: "array", minItems: 1, items: { type: "string" } } },
          stdin: { type: "string", description: "A workspace file to use as the first command's input." },
          stdout: { type: "string", description: "A workspace file to receive the last command's stdout instead of returning it." },
          append: { type: "boolean", description: "With stdout, append instead of replacing the file." },
          glob: { type: "boolean", description: "Expand arguments that contain * ? [ or { to matching workspace files." },
          timeout_seconds: timeoutProp,
        },
      },
    },
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      if (host.run === undefined) return { content: "this host cannot run commands", is_error: true };
      const argv = args["argv"] as string[];
      const pipes = (args["pipe_to"] as string[][] | undefined) ?? [];
      const timeout = Math.min((args["timeout_seconds"] as number | undefined) ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      try {
        const stages = await prepare([argv, ...pipes], ctx, opts, args["glob"] === true);
        let stdin: Uint8Array | undefined;
        if (typeof args["stdin"] === "string") {
          const abs = await resolveInWorkspace(host, workspace, args["stdin"], "read");
          const st = await host.fs.stat(abs);
          if (st === undefined || !st.isFile) throw new RunRefused(`${args["stdin"]}: no such file`);
          if (st.size > MAX_REDIRECT_BYTES) throw new RunRefused(`${args["stdin"]} is too large to use as input`);
          stdin = await host.fs.read(abs);
        }
        let target: string | undefined;
        if (typeof args["stdout"] === "string") {
          target = await resolveInWorkspace(host, workspace, args["stdout"], "write");
          if ((await host.fs.stat(target))?.isDirectory === true) throw new RunRefused(`${args["stdout"]} is a directory`);
        }
        const outcome = await host.run({
          stages,
          cwd: workspace,
          ...(stdin === undefined ? {} : { stdin }),
          ...(target === undefined ? {} : { captureStdout: true, maxOutput: MAX_REDIRECT_BYTES }),
          unsetEnv: opts.secretEnv ?? [],
          unsetEnvPattern: SECRET_ENV_PATTERN,
          timeoutMs: timeout * 1000,
          signal: ctx.signal,
        });
        const extra: string[] = [];
        if (target !== undefined && outcome.stdout !== undefined) {
          if (args["append"] === true) await host.fs.append(target, outcome.stdout);
          else await host.fs.writeAtomic(target, outcome.stdout, { keepMode: true });
          extra.push(`stdout ${args["append"] === true ? "appended to" : "written to"} ${display(host, workspace, target)} (${outcome.stdout.length} bytes)`);
        }
        return report(outcome, timeout, extra);
      } catch (e) {
        if (e instanceof RunRefused || e instanceof GlobError || e instanceof PathRefused) return { content: e.message, is_error: true };
        throw e;
      }
    },
  };
}

export function scriptTool(opts: RunToolOptions = {}): Tool {
  return {
    definition: {
      name: "script",
      description:
        "Run a shell script with bash in the workspace: use it for shell syntax (&&, loops, redirecting stderr, $variables) that the run tool does not do. It always needs the user's approval, so prefer run for a single program. Returns the exit code, then stdout and stderr in the order they were produced.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["script"],
        properties: {
          script: { type: "string", description: "The script text, passed to bash -c." },
          timeout_seconds: timeoutProp,
        },
      },
    },
    async execute(args, ctx) {
      if (ctx.host.run === undefined) return { content: "this host cannot run commands", is_error: true };
      const timeout = Math.min((args["timeout_seconds"] as number | undefined) ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      const outcome = await ctx.host.run({
        stages: [["bash", "-c", args["script"] as string]],
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
