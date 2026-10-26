import { parseArgs } from "node:util";
import { runInit } from "./init.ts";
import { CliError, type Io } from "./io.ts";
import { Engine } from "./engine.ts";
import { defaultCommands } from "./commands/index.ts";
import { PlainRenderer, type Thinking } from "./output.ts";
import { findProject, openThread } from "./project.ts";
import { SessionStore } from "./session.ts";
import { Registry } from "./registry.ts";

const OPTIONS = {
  C: { type: "string", short: "C" },
  thread: { type: "string", short: "t" },
  plain: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  thinking: { type: "string" },
  attach: { type: "string", multiple: true },
  mime: { type: "string" },
  provider: { type: "string" },
  "base-url": { type: "string" },
  model: { type: "string" },
  "max-output": { type: "string" },
  "key-env": { type: "string" },
  name: { type: "string" },
  adopt: { type: "boolean" },
  force: { type: "boolean" },
} as const;

const HELP = `chattree: conversations with models, kept in git

usage: chattree [-C dir] [-t thread] <verb> [arguments]

  init [dir]         start a conversation (--provider anthropic|openai|compatible, --model, --base-url,
                     --key-env, --name <first thread>, --adopt for an existing repository, --force for a nested one)
  chat [thread]      the interactive session
  say <text>         send a message and print the reply ("-" reads standard input; --attach <file> may repeat)

Any session command works as a verb too (chattree status, chattree history 20, chattree threads archived,
chattree usage, chattree verify ...). Inside a session they are /status, /history 20, and so on; /help lists them.

options: -C <dir> run as if started there    -t <thread> the thread to use (default: the working tree's branch)
         -y answer yes to questions          --plain no styling or spinner    --thinking on|brief|off
`;

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run the CLI. Resolves to the exit status: 0 done, 1 something failed, 2 it was used wrongly. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [verb, ...args] = positionals;
  if (values.help === true || verb === undefined || verb === "help") {
    io.out(HELP);
    return verb === undefined && values.help !== true ? 2 : 0;
  }
  const start = values.C === undefined ? io.cwd : (await import("node:path")).resolve(io.cwd, values.C);
  const where: Io = { ...io, cwd: start };
  try {
    if (verb === "init") {
      const r = await runInit(where, {
        dir: args[0],
        provider: values.provider,
        baseUrl: values["base-url"],
        model: values.model,
        ...(values["max-output"] === undefined ? {} : { maxOutput: Number(values["max-output"]) }),
        keyEnv: values["key-env"],
        branch: values.name,
        adopt: values.adopt,
        force: values.force,
        yes: values.yes,
      });
      io.out(`started a conversation in ${r.root}\n  thread: ${r.branch}\n  model:  ${r.provider}/${r.model}${r.pinned ? "  (prices pinned)" : ""}\n`);
      for (const n of r.notes) io.err(`note: ${n}\n`);
      io.out(`next: cd ${r.root} && chattree chat\n`);
      return 0;
    }
    const registry = new Registry(defaultCommands());
    if (verb === "chat") {
      io.err("error: the interactive session is not built yet in this version; use `chattree say <text>` and the other verbs\n");
      return 2;
    }
    if (registry.find(verb) === undefined) {
      io.err(`error: ${verb} is not a verb\n${HELP}`);
      return 2;
    }
    const needsProviders = ["say", "retry", "continue"].includes(verb);
    const project = await findProject(where, start);
    const opened = await openThread(where, project, values.thread, { providers: needsProviders ? "required" : "optional" });
    const sessions = await SessionStore.open(where, project.git);
    const engine = new Engine({ io: where, project, opened, sessions, confirm: async () => values.yes === true });
    if (values.thinking !== undefined) {
      if (!["on", "off", "brief"].includes(values.thinking)) throw new CliError(`--thinking takes on, brief or off, not ${values.thinking}`);
      engine.state.thinking = values.thinking as Thinking;
    }

    let line: string;
    if (verb === "say") {
      for (const f of values.attach ?? []) {
        const staged = await drain(engine, `/attach ${quote(f)}${values.mime === undefined ? "" : ` --mime ${quote(values.mime)}`}`, io);
        if (staged !== 0) return staged;
      }
      let text = args.join(" ");
      if (text === "-" || (text === "" && !io.interactive && (values.attach ?? []).length === 0)) text = new TextDecoder().decode(await io.readStdin());
      line = text.trim() === "" ? "/say" : `/say ${text}`;
    } else line = `/${verb}${args.map((a) => ` ${quote(a)}`).join("")}`;
    return await drain(engine, line, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error: ${e.message}\n${e.hint === undefined ? "" : `  ${e.hint}\n`}`);
      return 1;
    }
    throw e;
  }
}

/** Run one line through the engine, rendering plain output. 1 if it reported an error or the request did not complete. */
async function drain(engine: Engine, line: string, io: Io): Promise<number> {
  const render = new PlainRenderer(io, () => engine.convo, engine.state.thinking);
  let failed = false;
  for await (const o of engine.submit(line)) {
    if (o.type === "error" || (o.type === "request_end" && o.status !== "completed")) failed = true;
    await render.render(o);
  }
  return failed ? 1 : 0;
}
