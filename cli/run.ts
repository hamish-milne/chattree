import { Engine } from "./engine.ts";
import { CliError, type Io } from "./io.ts";
import { findProject, openThread } from "./project.ts";
import { describeCall } from "./tool-lines.ts";

export interface RunOptions {
  /** The thread whose tools and settings the runner uses (default: the working tree's). Every thread of the project is looked at. */
  thread?: string | undefined;
  /** Do what can be done now and leave (the exit status says whether questions are waiting). Default: keep watching until stopped. */
  once?: boolean;
  /** Stops a watching runner (tests; the process's own signals do it otherwise). */
  stop?: AbortSignal;
  /** How often the project is looked at while watching. */
  pollMs?: number;
}

/**
 * `chattree run`: the pump with no screen (docs/tools.md, 5.4). It runs every thread that can go on without a person (a message
 * nobody has answered, a decided call, a subagent that handed back) and leaves the questions in the transcripts, where any session
 * can answer them; the runner then notices the answer and goes on. Exit status with `--once`: 0 nothing is waiting, 3 questions are.
 */
export async function runRunner(io: Io, start: string, o: RunOptions): Promise<number> {
  const project = await findProject(io, start);
  const opened = await openThread(io, project, o.thread, { providers: "required" });
  const engine = new Engine({ io, project, opened, tools: true, headless: true, confirm: async () => false });
  engine.ask = undefined;
  engine.childLine = (text) => io.err(text);
  const pump = engine.pump();
  if (pump === undefined) throw new CliError("this runner has no tools", "the project's harness.yml lists none");
  const told = new Set<string>();
  const tell = (): void => {
    for (const q of engine.questions()) {
      if (told.has(`${q.branch}\0${q.callId}`)) continue;
      told.add(`${q.branch}\0${q.callId}`);
      io.err(`waiting on ${q.branch}: allow ${describeCall(q.name, q.args).split("\n")[0]}? (chattree chat -t ${q.branch})\n`);
    }
  };
  engine.onQuestion = tell;
  try {
    if (o.once === true) {
      await pump.settle();
      tell();
      for (const [branch, why] of pump.held()) io.err(`${branch}: ${why}\n`);
      return pump.held().size > 0 ? 1 : engine.questions().length > 0 ? 3 : 0;
    }
    await pump.tick();
    const off = pump.watch(o.pollMs ?? 1000);
    let release: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (release = resolve));
    const stopSignal = io.onSignal?.(() => release());
    o.stop?.addEventListener("abort", () => release(), { once: true });
    if (o.stop?.aborted === true) release();
    await stopped;
    stopSignal?.();
    off();
    return 0;
  } finally {
    await engine.stopJobs();
  }
}
