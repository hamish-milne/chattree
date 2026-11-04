import { configHash } from "../../harness/trust.ts";
import type { Ctx } from "../engine.ts";
import type { Output } from "../output.ts";
import { openThread } from "../project.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";

const dec = new TextDecoder();
const MAX_LINES = 120;

/**
 * What changed in harness.yml, as far as git can say: against the version that was approved (found in the file's history by its hash), or the
 * uncommitted edit, or else the commit that last touched it; and, when there is nothing to compare, the file itself.
 */
async function describeFile(ctx: Ctx, approved: string | undefined): Promise<string> {
  const git = ctx.engine.project.git.withCwd(ctx.convo.dir);
  const out = async (args: string[], ok: number[] = [0]): Promise<string> => dec.decode((await git.run(args, { ok, readOnly: true })).stdout).trim();
  if (approved !== undefined) {
    for (const commit of (await out(["log", "-n", "100", "--format=%h", "--", "harness.yml"], [0, 128])).split("\n").filter((c) => c !== "")) {
      const then = await git.readFileAt(commit, "harness.yml");
      if (then !== undefined && configHash(then) === approved) {
        const diff = await out(["diff", commit, "--", "harness.yml"], [0, 1, 128]);
        return `changes since the version you approved (commit ${commit}):\n${diff === "" ? "(none that git shows)" : diff}`;
      }
    }
  }
  const parts: string[] = [];
  const diff = await out(["diff", "HEAD", "--", "harness.yml"], [0, 1, 128]);
  if (diff !== "") parts.push(`edited since the last commit:\n${diff}`);
  else {
    const last = await out(["log", "-1", "--format=%h  %an, %ad: %s", "--date=short", "--", "harness.yml"], [0, 128]);
    parts.push(last === "" ? "not committed yet" : `last changed by commit ${last}`);
    const lines = dec.decode(await ctx.io.host.fs.read(ctx.io.host.path.join(ctx.convo.dir, "harness.yml"))).split("\n");
    parts.push(`${lines.slice(0, MAX_LINES).join("\n")}${lines.length > MAX_LINES ? `\n… ${lines.length - MAX_LINES} more lines (/trust show prints all)` : ""}`);
  }
  return parts.join("\n\n");
}

const trust: Command = {
  name: "trust",
  summary: "check that harness.yml is the file you approved for this thread, or review and approve it",
  usage: "/trust [show]",
  busy: "blocked",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["show"].filter((s) => s.startsWith(partial)) : [];
  },
  async *run(ctx, args): AsyncGenerator<Output, void> {
    try {
      const path = ctx.io.host.path.join(ctx.convo.dir, "harness.yml");
      if (args[0] === "show") {
        if ((await ctx.io.host.fs.stat(path)) === undefined) yield { type: "error", message: "this thread has no harness.yml" };
        else yield { type: "text", text: dec.decode(await ctx.io.host.fs.read(path)) };
        return;
      }
      if (args.length > 0) {
        yield { type: "error", message: `unknown option ${args[0]}`, hint: "/trust [show]" };
        return;
      }
      const t = await ctx.convo.configTrust();
      if (t.state === "trusted") {
        yield { type: "notice", message: t.hash === "none" ? "this thread has no harness.yml, so there is nothing to approve" : `harness.yml is the file you approved for thread ${ctx.convo.branch}` };
        return;
      }
      yield {
        type: "warning",
        message:
          t.state === "unknown"
            ? `harness.yml has never been approved for thread ${ctx.convo.branch}. It decides which providers get your keys, what runs without asking, and which programs start; until you approve it none of that is used.`
            : `harness.yml has changed outside chattree since you approved it for thread ${ctx.convo.branch}. Until you approve it again none of it is used.`,
      };
      yield { type: "text", text: await describeFile(ctx, t.approved) };
      if (!(await ctx.confirm(`Approve this harness.yml for thread ${ctx.convo.branch}?`))) {
        yield { type: "notice", message: "not approved; the thread stays without providers and tools" };
        return;
      }
      await ctx.convo.approveConfig();
      // Providers are built when a thread is opened, so it is opened again.
      const opened = await openThread(ctx.io, ctx.engine.project, ctx.engine.thread, { providers: "optional" });
      const old = ctx.engine.convo;
      ctx.engine.rebind(opened);
      await old.close().catch(() => undefined);
      yield { type: "notice", message: `approved harness.yml for thread ${ctx.convo.branch}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

export const trustCommands: Command[] = [trust];
