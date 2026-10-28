import { parseArgs } from "node:util";
import type { Conversation } from "../../harness/conversation.ts";
import { ConversationError } from "../../harness/conversation.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import { formatEntry } from "../output.ts";
import { askModel } from "../oneshot.ts";
import { openThread, threadDir } from "../project.ts";
import { recentEntries } from "../recent.ts";
import { resolveEntry } from "../refs.ts";
import type { Command } from "../registry.ts";
import type { Ctx } from "../engine.ts";
import type { Output } from "../output.ts";
import { failure } from "../turn.ts";

const entriesOf = async (c: Conversation): Promise<ChatEntry[]> => (await c.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

/** Point the session at a thread it has a handle for, and show where things stand there. */
async function* moveTo(ctx: Ctx, convo: Conversation, thread: string, why: string): AsyncGenerator<Output, void> {
  const old = ctx.engine.convo;
  ctx.engine.rebind({ convo, thread, ...(ctx.engine.degraded === undefined ? {} : { degraded: ctx.engine.degraded }) });
  await old.close().catch(() => undefined);
  yield { type: "notice", message: why };
  const recent = await recentEntries(ctx.engine);
  if (recent.length > 0) yield { type: "text", text: recent.join("\n") };
}

/** The smallest unused `fork/<n>` (archived threads count, so a number is never reused). `skip` leaves out that many candidates, for a retry after a race. */
export async function nextForkName(convo: Conversation, skip = 1): Promise<string> {
  const used = new Set((await convo.listBranches()).map((b) => b.name));
  let n = 0;
  for (let found = 0; found < skip; ) {
    n++;
    if (!used.has(`fork/${n}`)) found++;
  }
  return `fork/${n}`;
}

const thread: Command = {
  name: "thread",
  summary: "show or change the thread this session is on; start, archive or unarchive threads",
  usage: "/thread  |  /thread <name>  |  /thread new <name> [--from <entry>]  |  /thread archive [name]  |  /thread unarchive [name]",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    if (previous.length === 0) return ["new", "archive", "unarchive", ...(await ctx.convo.listBranches()).filter((b) => !b.archived).map((b) => b.name)].filter((n) => n.startsWith(partial));
    if (previous[0] === "archive") return (await ctx.convo.listBranches()).filter((b) => !b.archived).map((b) => b.name).filter((n) => n.startsWith(partial));
    if (previous[0] === "unarchive") return (await ctx.convo.listBranches()).filter((b) => b.archived).map((b) => b.name).filter((n) => n.startsWith(partial));
    return [];
  },
  async *run(ctx, args) {
    const { engine } = ctx;
    const sub = args[0];
    try {
      if (sub === undefined) {
        const count = engine.sessions === undefined ? undefined : (await engine.sessions.list()).filter((s) => s.thread === engine.thread).length;
        yield { type: "text", text: `thread: ${engine.thread}\nworktree: ${ctx.convo.dir}${count === undefined ? "" : `\nsessions on it: ${count}`}` };
        return;
      }
      if (sub === "archive" || sub === "unarchive") {
        const name = args[1] ?? engine.thread;
        const changed = sub === "archive" ? await ctx.convo.archive(name) : await ctx.convo.unarchive(name);
        yield { type: "notice", message: changed ? `${name} is ${sub === "archive" ? "archived: /threads hides it unless asked (/threads archived)" : "no longer archived"}` : `${name} was already ${sub === "archive" ? "archived" : "not archived"}` };
        return;
      }
      if (sub === "new") {
        const parsed = parseArgs({ args: args.slice(1), allowPositionals: true, options: { from: { type: "string" } } });
        const name = parsed.positionals[0];
        if (name === undefined || parsed.positionals.length !== 1) {
          yield { type: "error", message: "give the new thread's name", hint: "/thread new <name> [--from <entry>]" };
          return;
        }
        const dir = await threadDir(ctx.io, engine.project, name);
        await ctx.io.host.fs.mkdir(ctx.io.host.path.dirname(dir));
        let convo: Conversation;
        if (parsed.values.from === undefined) convo = await ctx.convo.newThread(name, { worktree: dir, inheritSetup: true });
        else {
          const at = resolveEntry(await entriesOf(ctx.convo), parsed.values.from);
          if (at === undefined) {
            yield { type: "error", message: `no entry matches ${parsed.values.from}` };
            return;
          }
          const r = await ctx.convo.fork(at.id, { name, worktree: dir });
          if (r.conversation === undefined) throw new ConversationError("the new thread has no worktree");
          convo = r.conversation;
        }
        yield* moveTo(ctx, convo, name, `started thread ${name}${parsed.values.from === undefined ? " (an empty conversation with this thread's model and instructions)" : ` from entry ${parsed.values.from}`}`);
        return;
      }
      if (args.length > 1) {
        yield { type: "error", message: "give one thread name", hint: "/thread <name>" };
        return;
      }
      if (sub === engine.thread) {
        yield { type: "notice", message: `already on ${sub}` };
        return;
      }
      const opened = await openThread(ctx.io, engine.project, sub, { providers: "optional" });
      yield* moveTo(ctx, opened.convo, opened.thread, `now on thread ${opened.thread}`);
    } catch (e) {
      yield failure(e);
    }
  },
};

const fork: Command = {
  name: "fork",
  summary: "start a side conversation from this thread (or from an earlier entry) and move to it",
  usage: "/fork [<entry>] [name]   (an entry is a number counting back from the last, or the start of its id)",
  busy: "blocked",
  async *run(ctx, args) {
    const { engine } = ctx;
    try {
      const entries = await entriesOf(ctx.convo);
      let at: string | undefined;
      let name: string | undefined;
      if (args.length > 2) {
        yield { type: "error", message: "too many arguments", hint: "/fork [<entry>] [name]" };
        return;
      }
      if (args.length === 2) {
        const e = resolveEntry(entries, args[0] as string);
        if (e === undefined) {
          yield { type: "error", message: `no entry matches ${args[0]}` };
          return;
        }
        [at, name] = [e.id, args[1]];
      } else if (args.length === 1) {
        const e = /^\d+$/.test(args[0] as string) || /^[0-9A-Za-z]{8,26}$/.test(args[0] as string) ? resolveEntry(entries, args[0] as string) : undefined;
        if (e !== undefined) at = e.id;
        else name = args[0];
      }
      const from = engine.thread;
      // Unnamed forks are fork/1, fork/2 ...: short enough to type. A second session taking the number first is retried with the next.
      let branch = name ?? (await nextForkName(ctx.convo));
      let r: Awaited<ReturnType<Conversation["fork"]>> | undefined;
      for (let attempt = 0; r === undefined; attempt++) {
        const dir = await threadDir(ctx.io, engine.project, branch);
        await ctx.io.host.fs.mkdir(ctx.io.host.path.dirname(dir));
        try {
          r = await ctx.convo.fork(at, { name: branch, worktree: dir });
        } catch (e) {
          if (name !== undefined || attempt >= 5 || !(e instanceof ConversationError) || !/already exists/.test(e.message)) throw e;
          branch = await nextForkName(ctx.convo, attempt + 2);
        }
      }
      if (r.conversation === undefined) throw new ConversationError("the fork has no worktree");
      yield* moveTo(ctx, r.conversation, r.branch, `forked ${r.branch} from ${from}${at === undefined ? "" : ` at an earlier entry`}; go back with /thread ${from}, and bring it home with /merge ${r.branch}`);
    } catch (e) {
      yield failure(e);
    }
  },
};

/**
 * What a fork wrote of its own, as text for a summary: its entries after it branched off, and after the last time it was merged
 * into `parent` (a second merge reports only what is new, as the files do). Undefined when there is nothing.
 */
async function forkTranscript(ctx: Ctx, parent: Conversation, name: string): Promise<string[]> {
  const entries = (await ctx.convo.readEntriesAt(`refs/heads/${name}`)).flatMap((e) => (e.ok ? [e.value] : []));
  let from = entries.map((e) => e.$tag).lastIndexOf("branch_start") + 1;
  const merges = (await entriesOf(parent)).flatMap((e) => (e.$tag === "fork_merge" && e.branch === name ? [e.tip] : []));
  const last = merges.at(-1);
  if (last !== undefined) from = Math.max(from, (await ctx.convo.readEntriesAt(last)).length);
  const lines: string[] = [];
  for (const e of entries.slice(from)) {
    const t = await formatEntry(ctx.convo, e, { thinking: "off", max: 2000 });
    if (t !== undefined) lines.push(t);
  }
  return lines;
}

const SUMMARY_PROMPT = (lines: string[], parent: string): string =>
  `Below is a side conversation that branched off from the thread "${parent}". Everything before it, in the main thread, is already known to the reader and is not shown.\n\n${lines.join("\n")}\n\nWrite a short summary (a few sentences) of what this side conversation discussed, decided and changed, for the main thread to carry on from. Describe only what happened in the side conversation above; do not restate background, and do not mention anything you cannot see here. Plain text only.`;

const merge: Command = {
  name: "merge",
  summary: "bring this fork back into the thread it came from (or a named fork into this thread), with a summary of what it settled",
  usage: "/merge [summary text]   merge this thread into its parent and move there\n/merge <thread> [summary text]   merge that fork into this thread\n(without a summary the model writes one for you to confirm)",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    return previous.length > 0 ? [] : (await ctx.convo.listBranches()).filter((b) => b.name !== ctx.engine.thread).map((b) => b.name).filter((n) => n.startsWith(partial));
  },
  async *run(ctx, args, rest) {
    const { engine } = ctx;
    try {
      const branches = new Set((await ctx.convo.listBranches()).map((b) => b.name));
      // `/merge <thread> ...` names a fork; anything else is the summary and the fork is this thread.
      const explicit = args[0] !== undefined && branches.has(args[0]) && args[0] !== engine.thread;
      // `/merge <this thread> ...` is the same as `/merge ...`.
      let summary = (explicit || args[0] === engine.thread ? rest.replace(/^\s*\S+\s*/, "") : rest).trim();
      let parent = ctx.convo;
      let childName = args[0] as string;
      let parentName = engine.thread;
      if (!explicit) {
        const start = (await entriesOf(ctx.convo)).filter((e) => e.$tag === "branch_start").at(-1);
        if (start === undefined || start.$tag !== "branch_start" || start.kind !== "fork") {
          yield { type: "error", message: `${args[0] !== undefined && !branches.has(args[0]) ? `there is no thread named ${args[0]}, and ` : ""}${engine.thread} is not a fork, so it has no thread to merge into`, hint: "/merge <thread> [summary text] brings a fork into this thread" };
          return;
        }
        childName = engine.thread;
        parentName = start.from.branch;
        await ctx.convo.snapshot();
        parent = (await openThread(ctx.io, engine.project, parentName, { providers: "optional" })).convo;
      } else if (args.length === 0) {
        yield { type: "error", message: "say which thread to merge", hint: "/merge [summary text]  |  /merge <thread> [summary text]" };
        return;
      }
      let moved = false;
      try {
        // Before spending a request on a summary, check the merge can happen at all.
        await parent.assertMergeable(childName);
        if (summary === "") {
          const lines = await forkTranscript(ctx, parent, childName);
          if (lines.length === 0) {
            yield { type: "error", message: `${childName} has nothing new of its own to summarise`, hint: "give the summary yourself: /merge [<thread>] <text>" };
            return;
          }
          const r = await askModel(ctx.convo, SUMMARY_PROMPT(lines, parentName));
          yield { type: "notice", message: `summary by ${r.model} (${r.usage.input} in, ${r.usage.output} out; not in the ledger):` };
          yield { type: "text", text: r.text };
          if (!(await ctx.confirm(`Merge ${childName} into ${parentName} with this summary?`))) {
            yield { type: "notice", message: "not merged" };
            return;
          }
          summary = r.text;
        }
        const out = await parent.mergeFork(explicit ? childName : ctx.convo, { summary });
        const rep = out.report;
        yield { type: "notice", message: `merged ${childName} into ${parentName}: ${rep.changed.length} changed, ${rep.added.length} added, ${rep.discarded.length} dropped (${parentName}'s version won), ${rep.conflicts.length} conflict${rep.conflicts.length === 1 ? "" : "s"}` };
        for (const c of rep.conflicts) yield { type: "warning", message: `conflict: ${JSON.stringify(c)}` };
        if (parent !== ctx.convo) {
          moved = true;
          yield* moveTo(ctx, parent, parentName, `now on ${parentName}; /thread ${childName} goes back to the fork`);
        }
      } finally {
        if (parent !== ctx.convo && !moved) await parent.close().catch(() => undefined);
      }
    } catch (e) {
      yield failure(e);
    }
  },
};

export const threadCommands: Command[] = [thread, fork, merge];
