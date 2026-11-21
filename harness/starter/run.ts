/**
 * `run` and `script`, the two tools that start programs in the workspace. `run` takes one command line in a small bash-like
 * syntax that `command.ts` parses (no shell is involved), so what the user approves is the parsed programs and arguments.
 * `script` is the escape hatch: a string for POSIX `sh -c`, which always needs approval. Both use the host's `run` and are
 * refused on a host that cannot run commands.
 */
import type { RunOutcome, RunSpec } from "../../src/host.ts";
import { JobLog } from "../job-log.ts";
import { CommandSyntax, parseCommand, type ParsedCommand } from "./command.ts";
import { GlobError, expandGlob } from "./glob.ts";
import { NotAvailable, portableStage, shellStage } from "./portable.ts";
import { PathRefused, display, resolveInWorkspace } from "./workspace.ts";
import { isStarted, type Tool, type ToolContext, type ToolOutput } from "../tools.ts";
import { batchProblem, batchStage, findProgram, isBatch, localAllowed } from "./batch.ts";
import { runAllowKeys, runCovers, validateRunKey } from "./run-keys.ts";
import { optNumberArg, stringArg } from "../tool-args.ts";
import { isJson } from "../../src/json.ts";
import { nth } from "../../src/nth.ts";

export interface RunToolOptions {
  /** Which environment variables `$VAR` may read, and their values. Default: none. `"*"` allows every name in `values`. */
  env?: { allow: readonly string[] | "*"; values: Readonly<Record<string, string | undefined>> };
  /** Environment variable names to hide from commands, besides anything that looks like a secret. */
  secretEnv?: readonly string[];
  /** `mm_read` is offered: the refusals of binary data say to use it. */
  mmRead?: boolean;
  /**
   * Windows: allow `.cmd` and `.bat` programs (`tools.run.batch`). Default false: they are refused with a message that
   * says what to set.
   */
  batch?: boolean;
  /** Windows: globs (relative to the workspace) of batch files inside the workspace that may be started (`tools.run.local`). */
  batchLocal?: readonly string[];
  /** The host's own environment (`PATH`, `ComSpec`), for finding programs. Not what commands may read: that is `env`. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Command prefixes known to be read-only (`tools.run.safe` in harness.yml): a grant for one is offered as
   * `<prefix> **`. Default: none.
   */
  safe?: readonly string[];
  /**
   * Allow `git` (`tools.run.git`). Default false: a thread's working directory is a repository that chattree keeps, and a
   * model that commits to it, or reads its log, is working against the harness.
   */
  git?: boolean;
  /** Default timeout for a command (seconds). Default 120. */
  timeoutSeconds?: number;
  /** Path to busybox.exe, which stands in for common utilities (cat, ls, grep, ...) on Windows. */
  busybox?: string | undefined;
}

const MAX_TIMEOUT = 3600;
/** Names that look like credentials are not passed to commands. */
export const SECRET_ENV_PATTERN = "(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY)($|_)";
// Bounds the workspace file read as `<` input and the output captured for `>`; larger files are refused, not truncated.
const MAX_REDIRECT_BYTES = 64 * 1024 * 1024;
const dec = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const isUtf8 = (b: Uint8Array): boolean => {
  try {
    strict.decode(b);
    return true;
  } catch {
    return false;
  }
};

class RunRefused extends Error {}

const GIT_REFUSED =
  "git is not used here: the working directory is a repository that stores a log of this conversation and the changes to its files, and your changes are saved automatically (the user can allow git with tools.run.git: true in harness.yml)";

/** Replace `$VAR` and `${VAR}` in one argument, only for allowed names. */
export function expandEnv(arg: string, opts: RunToolOptions["env"]): string {
  return arg.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = a ?? b ?? "";
    const allowed = opts !== undefined && (opts.allow === "*" || opts.allow.includes(name));
    if (!allowed)
      throw new RunRefused(
        `$${name} is not an allowed environment variable (names are listed under tools.env in harness.yml); for a literal $ use the script tool`,
      );
    const v = opts?.values[name];
    if (v === undefined) throw new RunRefused(`$${name} is not set`);
    return v;
  });
}

/** Environment lookup for the command parser: allowed names only. */
const envLookup =
  (opts: RunToolOptions["env"]) =>
  (name: string): string =>
    expandEnv(`$${name}`, opts);

async function prepare(
  parsed: ParsedCommand,
  ctx: ToolContext,
  opts: RunToolOptions,
): Promise<{ stages: string[][]; verbatim: boolean[] }> {
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
    if (opts.git !== true && /^git(\.exe)?$/i.test(words[0] ?? "")) throw new RunRefused(GIT_REFUSED);
    const mapped = portableStage(words, ctx.host.platform, opts.busybox);
    if (ctx.host.platform === "windows" && mapped[0] === words[0]) {
      const found = await findProgram(ctx.host, ctx.workspace, nth(words, 0), opts.hostEnv ?? {});
      if (found !== undefined && isBatch(found.path)) {
        if (opts.batch !== true)
          throw new RunRefused(
            `${words[0]} is a batch program (${found.path}), which run does not start by default because cmd.exe re-interprets its arguments; the user can allow it with tools.run.batch: true in harness.yml`,
          );
        if (found.local !== undefined && !localAllowed(found.local, opts.batchLocal ?? []))
          throw new RunRefused(
            `${words[0]} resolves to ${found.local}, a batch file inside the workspace, and tools.run.local in harness.yml does not list it (for example ./node_modules/.bin/*.cmd)`,
          );
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

function report(outcome: RunOutcome, timeoutSeconds: number, extra: string[], mm = false): ToolOutput {
  const lines = [`exit ${outcome.exitCode}${outcome.stageCodes.length > 1 ? ` (stages: ${outcome.stageCodes.join(", ")})` : ""}`];
  if (outcome.timedOut) lines.push(`timed out after ${timeoutSeconds} seconds and was killed`);
  if (outcome.aborted && !outcome.timedOut) lines.push("stopped before it finished");
  const binary =
    outcome.output.subarray(0, 8000).includes(0) ||
    !isUtf8(outcome.dropped > 0 ? outcome.output.subarray(0, Math.max(0, outcome.output.length - 3)) : outcome.output);
  if (binary)
    lines.push(
      `(the output is binary data, not text, so it is not shown; write it to a file with > ${mm ? "and look at it with mm_read if it is a picture or sound" : "and use a tool that reads that format"})`,
    );
  else {
    const text = dec.decode(outcome.output);
    lines.push(text === "" ? "(no output)" : text.replace(/\n$/, ""));
  }
  if (outcome.dropped > 0) lines.push(`(${outcome.dropped} more bytes of output were discarded)`);
  lines.push(...extra);
  return { content: lines.join("\n"), is_error: outcome.exitCode !== 0 || outcome.timedOut || outcome.aborted };
}

const timeoutProp = {
  type: "integer",
  minimum: 0,
  maximum: MAX_TIMEOUT,
  description: `Seconds before the command is killed. Default 120 (3600 with background), at most ${MAX_TIMEOUT}. With background, 0 means no limit, for a server or watcher that runs until it is stopped.`,
};

const nameProp = {
  type: "string",
  description: 'With background: a short name for the job ("dev server", "unit tests"), shown to the user in place of the command.',
};

/** What a command is told so that it prints plain text: no colour, no pager, no cursor control. */
const PLAIN_ENV: Readonly<Record<string, string>> = { NO_COLOR: "1", CLICOLOR: "0", FORCE_COLOR: "0", TERM: "dumb", PAGER: "cat" };

/** Forward a command's output to the job's log as it arrives, if there is one. */
function streamTo(ctx: ToolContext): Pick<RunSpec, "onOutput"> | Record<string, never> {
  const output = ctx.output;
  if (output === undefined) return {};
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  return { onOutput: (channel, chunk) => output(channel, decoders[channel].decode(chunk, { stream: true })) };
}

const backgroundProp = {
  type: "boolean",
  description:
    "Start it as a background job and return at once, for something long (a build, a server, a test run). You are told when it ends; the jobs, job_output and job_stop tools manage it. Default false.",
};

/**
 * Let a tool be started as a background job (`background: true`): the same execution, not tied to the turn, with a long
 * default timeout.
 */
function backgroundable(tool: Tool, label: (args: Record<string, unknown>) => string, defaultSeconds: number | undefined): Tool {
  const inner = tool.execute;
  const schema = tool.definition.input_schema;
  const properties: Record<string, unknown> = isJson(schema["properties"]) ? schema["properties"] : {};
  return {
    ...tool,
    background: true,
    // Started in the background the call returns at once; otherwise it is as long as the command's own timeout.
    timeout: (args) =>
      args["background"] === true ? 60 : Math.min(optNumberArg(args, "timeout_seconds") ?? defaultSeconds ?? 120, MAX_TIMEOUT),
    definition: {
      ...tool.definition,
      input_schema: { ...schema, properties: { ...properties, background: backgroundProp, name: nameProp } },
    },
    async execute(args, ctx) {
      const { background: _b, name: rawName, ...rest } = args;
      if (args["background"] !== true) {
        if (optNumberArg(args, "timeout_seconds") === 0)
          return { content: "timeout_seconds 0 (no limit) is only for a job started with background: true", is_error: true };
        return inner(rest, ctx);
      }
      const stop = new AbortController();
      const log = new JobLog();
      const name = typeof rawName === "string" && rawName.trim() !== "" ? oneLine(rawName, 60) : undefined;
      // A background job runs for up to an hour unless the caller asks for less (or for no limit with 0); it is not bound to the foreground timeout.
      const done = inner({ timeout_seconds: 3600, ...rest }, { ...ctx, signal: stop.signal, output: (c, t) => log.append(c, t) }).then(
        (r): ToolOutput => (isStarted(r) ? { content: "nested background job", is_error: true } : r),
        (e: unknown): ToolOutput => ({ content: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true }),
      );
      const asked = optNumberArg(args, "timeout_seconds");
      return {
        started: {
          ...(asked === 0 ? {} : { lease: { seconds: Math.min(asked ?? 3600, MAX_TIMEOUT) } }),
          ...(name === undefined ? {} : { name }),
          log,
          summary: label(args),
          done,
          stop: () => stop.abort(),
        },
      };
    },
  };
}

const oneLine = (s: string, max = 80): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

export function runTool(opts: RunToolOptions = {}): Tool {
  return backgroundable(plainRunTool(opts), (a) => `run: ${oneLine(stringArg(a, "command"))}`, opts.timeoutSeconds);
}

export function scriptTool(opts: RunToolOptions = {}): Tool {
  return backgroundable(
    plainScriptTool(opts),
    (a) => `script: ${oneLine(stringArg(a, "script").split("\n")[0] ?? "")}`,
    opts.timeoutSeconds,
  );
}

function plainRunTool(opts: RunToolOptions): Tool {
  return {
    definition: {
      name: "run",
      description:
        "Run a command in the workspace, written in a cross-platform bash-like syntax with common shell utilities (cat, ls, grep, sed, sort, wc, ...), as well as programs available to the host (node, ...). It is not a real shell: the supported syntax is quotes, `|` pipes, `<` `>` `>>` with workspace files, `*` `?` `[...]` `{a,b}` globs, `2>&1`, and `$NAME` for environment variables the user has allowed. Not supported: `;` `&&` `||` `&` (to start something that keeps running, such as a server, a watcher or a long build, set `background: true`: it returns a job at once, and you read its output and stop it with the job tools), loops and conditions (`for`, `while`, `if`), `$(...)`, backticks, subshells, heredocs, `VAR=x cmd` and `~` (use the script tool for those, which needs the user's approval). Returns the exit code, then stdout and stderr in the order they were produced.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "One command or pipeline on a single line, for example: grep -n TODO src/*.ts | sort | head -20",
          },
          timeout_seconds: timeoutProp,
        },
      },
    },
    allowKeys: (args, ctx) => runAllowKeys(stringArg(args, "command"), { ...ctx, expand: envLookup(opts.env), safe: opts.safe ?? [] }),
    covers: (keys, args, ctx) =>
      runCovers(keys, stringArg(args, "command"), { ...ctx, expand: envLookup(opts.env), safe: opts.safe ?? [] }),
    validateKey: validateRunKey,
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      if (host.run === undefined) return { content: "this host cannot run commands", is_error: true };
      const asked = optNumberArg(args, "timeout_seconds");
      const timeout = Math.min(asked ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      try {
        const parsed = parseCommand(stringArg(args, "command"), envLookup(opts.env));
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
        ctx.output?.("stdin", `$ ${stringArg(args, "command")}\n`);
        const outcome = await host.run({
          stages,
          ...(verbatim.some((v) => v) ? { verbatim } : {}),
          cwd: workspace,
          env: PLAIN_ENV,
          ...streamTo(ctx),
          ...(stdin === undefined ? {} : { stdin }),
          ...(out === undefined ? {} : { captureStdout: true, maxOutput: MAX_REDIRECT_BYTES }),
          unsetEnv: opts.secretEnv ?? [],
          unsetEnvPattern: SECRET_ENV_PATTERN,
          ...(asked === 0 ? {} : { timeoutMs: timeout * 1000 }),
          signal: ctx.signal,
        });
        const extra: string[] = [];
        if (target !== undefined && outcome.stdout !== undefined) {
          if (out?.append === true) await host.fs.append(target, outcome.stdout);
          // `>` replaces the file in one step, so a failed write does not leave it half written.
          else await host.fs.writeAtomic(target, outcome.stdout, { keepMode: true });
          extra.push(
            `stdout ${out?.append === true ? "appended to" : "written to"} ${display(host, workspace, target)} (${outcome.stdout.length} bytes)`,
          );
        }
        return report(outcome, timeout, extra, opts.mmRead === true);
      } catch (e) {
        if (
          e instanceof RunRefused ||
          e instanceof CommandSyntax ||
          e instanceof NotAvailable ||
          e instanceof GlobError ||
          e instanceof PathRefused
        )
          return { content: e.message, is_error: true };
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
        "Run a POSIX sh script (`sh -c`; on Windows busybox's ash) in the workspace. Plain POSIX only: no bash extras such as `{1..3}`, `[[ ]]` or arrays (write `for i in 1 2 3` or use `seq`). Use it for shell syntax (&&, ;, loops, $(...), redirecting stderr, $variables) that the run tool does not do. A trailing `&` does not start a background job here: set `background: true` for that. It always needs the user's approval, so prefer run for a single command. Other languages (bash, python, powershell) are started with run when the host has them. Returns the exit code, then stdout and stderr in the order they were produced.",
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
      const asked = optNumberArg(args, "timeout_seconds");
      const timeout = Math.min(asked ?? opts.timeoutSeconds ?? 120, MAX_TIMEOUT);
      let stage: string[];
      try {
        stage = shellStage(stringArg(args, "script"), ctx.host.platform, opts.busybox);
      } catch (e) {
        if (e instanceof NotAvailable) return { content: e.message, is_error: true };
        throw e;
      }
      ctx.output?.("stdin", `${stringArg(args, "script").replace(/\n$/, "")}\n`);
      const outcome = await ctx.host.run({
        stages: [stage],
        cwd: ctx.workspace,
        env: PLAIN_ENV,
        ...streamTo(ctx),
        unsetEnv: opts.secretEnv ?? [],
        unsetEnvPattern: SECRET_ENV_PATTERN,
        ...(asked === 0 ? {} : { timeoutMs: timeout * 1000 }),
        signal: ctx.signal,
      });
      return report(outcome, timeout, [], opts.mmRead === true);
    },
  };
}
