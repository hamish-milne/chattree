import { Engine, hasPendingState } from "./engine.ts";
import { CliError, type Io } from "./io.ts";
import { ansiStyle, PlainRenderer, plainStyle, type Thinking, type ToolView } from "./output.ts";
import { findProject, openThread } from "./project.ts";
import { SessionStore, type Session } from "./session.ts";
import { Terminal } from "./terminal.ts";
import { recentEntries } from "./recent.ts";

export interface ChatOptions {
  /** The thread to chat on; default: the one the working directory is on. */
  thread?: string | undefined;
  /** Resume this session (id or unique prefix). */
  session?: string | undefined;
  /** Do not resume; start a new session. */
  newSession?: boolean;
  /** Line-oriented mode for scripts: no editor, spinner or colour. Default: when there is no terminal. */
  plain?: boolean;
  thinking?: Thinking | undefined;
  tools?: ToolView | undefined;
  /** Answer "yes" to the questions a change or a price drift raises (`-y`). */
  yes?: boolean;
  /** Terminal tuning, for tests. */
  spinnerMs?: number;
  watchMs?: number;
  exitWindowMs?: number;
}

async function statusLine(engine: Engine, resumed: boolean): Promise<string> {
  const setup = await engine.convo.setup();
  const l = await engine.convo.ledger().catch(() => undefined);
  const model = setup.model === undefined ? "no model set" : `${setup.model.provider}/${setup.model.resolved ?? setup.model.id}`;
  const spend = l === undefined ? "" : ` · $${l.conversation.usd.toFixed(4)}${l.conversation.unpriced > 0 ? "+" : ""} spent`;
  const s = engine.session;
  const draftLines = engine.state.draft === "" ? 0 : engine.state.draft.split("\n").length;
  const back = resumed && s !== undefined && hasPendingState(engine.state) ? ` (resumed: ${[draftLines > 0 ? `${draftLines} line${draftLines === 1 ? "" : "s"} of draft` : "", engine.state.attachments.length > 0 ? `${engine.state.attachments.length} staged file${engine.state.attachments.length === 1 ? "" : "s"}` : ""].filter((x) => x !== "").join(", ")})` : "";
  return `thread ${engine.thread} · ${model}${spend} · session ${s?.id.slice(0, 8) ?? "-"}${back}`;
}

/** `chattree chat`: open (or resume) a session on a thread and run it until the user leaves. Returns the exit status. */
/**
 * Yes/no questions from commands (`/undo`, a changed price table). In a terminal they go through the engine's own prompt, the one
 * that owns the keyboard: a second `readline` on the same input would take it over and leave the session unresponsive.
 */
function confirmWith(engine: () => Engine, io: Io, yes: boolean): (q: string) => Promise<boolean> {
  if (yes) return async () => true;
  return async (q) => {
    const ask = engine().ask ?? io.ask?.bind(io);
    return ask === undefined ? false : /^y(es)?$/i.test(await ask(q, "n", [{ key: "y", label: "yes" }, { key: "n", label: "no" }]));
  };
}

export async function runChat(io: Io, start: string, o: ChatOptions): Promise<number> {
  const project = await findProject(io, start);
  const sessions = await SessionStore.open(io, project.git);
  const interactive = io.interactive && io.tty !== undefined && o.plain !== true;

  let session: Session;
  let resumed: boolean;
  let skipped: string[];
  let opened;
  if (o.session !== undefined) {
    const r = await sessions.open({ thread: "", id: o.session });
    ({ session, resumed, skipped } = r);
    try {
      opened = await openThread(io, project, session.thread, { providers: "optional" });
    } catch (e) {
      await session.close();
      throw new CliError(`session ${session.id} points at thread ${session.thread}, which cannot be opened: ${e instanceof Error ? e.message : String(e)}`, "start another session with --new-session");
    }
  } else {
    opened = await openThread(io, project, o.thread, { providers: "optional" });
    const r = await sessions.open({ thread: opened.thread, ...(o.newSession === true ? { fresh: true } : {}) });
    ({ session, resumed, skipped } = r);
  }

  const engine = new Engine({ io, project, opened, session, sessions, tools: true, confirm: confirmWith(() => engine, io, o.yes === true) });
  if (o.thinking !== undefined) engine.state.thinking = o.thinking;
  if (o.tools !== undefined) engine.state.tools = o.tools;
  if (!interactive) engine.ask = undefined; // lines of a script are not answers: calls no grant covers are declined

  const stop = io.onSignal?.(() => {
    void shutdown().then(() => process.exit(130));
  });
  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stop?.();
    await engine.stopJobs();
    await session.close();
  };

  try {
    for (const s of skipped) io.err(`note: ${s}\n`);
    if (engine.degraded !== undefined) io.err(`warning: providers are unavailable (${engine.degraded}); you can read the thread but not send\n`);
    const style = interactive && io.env.NO_COLOR === undefined && io.env.TERM !== "dumb" ? ansiStyle : plainStyle;
    engine.style = style;
    for (const t of await recentEntries(engine)) io.out(`${t}\n`);
    io.out(`${style.dim(await statusLine(engine, resumed))}\n`);
    const act = await engine.convo.activity();
    if (act.state === "request" && act.live) io.err(`note: a request to ${act.model} is running on this thread${act.owner?.pid === undefined ? "" : ` (process ${act.owner.pid})`}\n`);
    if (interactive) {
      io.out(`${style.dim("type a message and finish it with a blank line · /help lists commands · Ctrl-D leaves")}\n`);
      const term = new Terminal({
        engine,
        tty: io.tty as NonNullable<Io["tty"]>,
        color: style === ansiStyle,
        ...(o.spinnerMs === undefined ? {} : { spinnerMs: o.spinnerMs }),
        ...(o.watchMs === undefined ? {} : { watchMs: o.watchMs }),
        ...(o.exitWindowMs === undefined ? {} : { exitWindowMs: o.exitWindowMs }),
      });
      await term.run();
      return 0;
    }
    return await runPlain(engine, io);
  } finally {
    await shutdown();
  }
}

/** Line-oriented chat for pipes: every line is a command or a message (a trailing `\\` continues it), output as the plain verbs print it. */
async function runPlain(engine: Engine, io: Io): Promise<number> {
  const text = new TextDecoder().decode(await io.readStdin());
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let failed = false;
  let pending: string | undefined;
  const submit = async (line: string): Promise<void> => {
    const render = new PlainRenderer(io, () => engine.convo, engine.state.thinking, undefined, engine.state.tools);
    for await (const o of engine.submit(line)) {
      if (o.type === "error" || (o.type === "request_end" && o.status !== "completed")) failed = true;
      await render.render(o);
    }
    for (const n of engine.notices.splice(0)) io.err(`[${n}]\n`);
  };
  for (const raw of lines) {
    if (pending !== undefined || raw.endsWith("\\")) {
      pending = `${pending === undefined ? "" : `${pending}\n`}${raw.endsWith("\\") ? raw.slice(0, -1) : raw}`;
      if (raw.endsWith("\\")) continue;
      const msg = pending;
      pending = undefined;
      await submit(msg.startsWith("/") && !msg.startsWith("//") ? `/${msg.slice(1)}` : msg);
    } else if (raw.trim() !== "") await submit(raw);
    if (engine.quit) break;
  }
  if (pending !== undefined) await submit(pending);
  return failed ? 1 : 0;
}
