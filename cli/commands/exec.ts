import { shellStage } from "../../harness/starter/portable.ts";
import type { Command } from "../registry.ts";
import { busyboxFor } from "../toolset.ts";
import { failure } from "../turn.ts";

/**
 * `/exec`: run a command in the thread's worktree, as the user: no approval, nothing added to the transcript, the terminal handed
 * to it (so `/exec sh`, an editor or a test watcher work). The line goes to POSIX `sh -c`, which on Windows is busybox's, so pipes,
 * `&&` and redirects mean the same everywhere. Without a command it starts a shell.
 */
const exec: Command = {
  name: "exec",
  summary: "run a command in this thread's worktree (no command: a shell); the model is not told",
  usage: "/exec [command line]   (POSIX sh syntax, also on Windows)",
  busy: "blocked",
  async *run(ctx, _args, rest) {
    try {
      const line = rest.trim();
      const stage = shellStage(line === "" ? "exec sh" : line, ctx.io.host.platform, await busyboxFor(ctx.io, ctx.convo));
      const code = await ctx.engine.exec(stage, ctx.convo.dir);
      if (code !== 0) yield { type: "notice", message: `exit ${code}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

export const execCommands: Command[] = [exec];
