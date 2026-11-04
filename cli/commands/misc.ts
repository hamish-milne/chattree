import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { trimRuleOf } from "../../harness/auto-trim.ts";
import { planTrim } from "../../harness/trim.ts";
import { readCommitGraph } from "../../harness/graph.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import type { Ctx } from "../engine.ts";
import { exportMarkdown } from "../export.ts";
import { askModel } from "../oneshot.ts";
import { formatTranscript } from "../output.ts";
import { resolveEntry } from "../refs.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";

const entriesOf = async (ctx: Ctx): Promise<ChatEntry[]> => (await ctx.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

const compact: Command = {
  name: "compact",
  summary: "replace a range of earlier entries, in what the model sees, with a summary (nothing is deleted)",
  usage: "/compact <from> <to> [summary text]   (entries are numbers counting back from the last, or the start of an id; without a summary the model writes one for you to confirm)\n/compact trim [keep]   (leave old tool output, long tool arguments and reasoning out of what the model sees, keeping the last [keep] entries whole; no model is asked)",
  busy: "blocked",
  async *run(ctx, args, rest) {
    if (args[0] === "trim") {
      try {
        const given = args[1] === undefined ? undefined : Number(args[1]);
        if (args.length > 2 || (given !== undefined && !(Number.isInteger(given) && given >= 0))) {
          yield { type: "error", message: "give how many recent entries to keep whole, as a number", hint: "/compact trim [keep]" };
          return;
        }
        const { rule, keepRecent } = await trimRuleOf(ctx.convo);
        const keep = given ?? keepRecent;
        const plan = planTrim(await entriesOf(ctx), keep, rule);
        if (plan === undefined) {
          yield { type: "notice", message: `nothing to trim before the last ${keep} entries` };
          return;
        }
        await ctx.convo.trim({ upto: plan.upto, rule, by: "user" });
        yield { type: "notice", message: `trimmed: about ${(plan.bytes / 1024).toFixed(1)} KB of old tool output, arguments and reasoning is left out of what the model sees (the last ${keep} entries are whole; the transcript keeps everything). The next request reads the context again at the full input price.` };
      } catch (e) {
        yield failure(e);
      }
      return;
    }
    if (args.length < 2) {
      yield { type: "error", message: "give the first and last entry to replace", hint: "/compact <from> <to> [summary text]; see /history and /show for entries" };
      return;
    }
    try {
      const entries = await entriesOf(ctx);
      const from = resolveEntry(entries, args[0] as string);
      const to = resolveEntry(entries, args[1] as string);
      if (from === undefined || to === undefined) {
        yield { type: "error", message: `no entry matches ${from === undefined ? args[0] : args[1]}` };
        return;
      }
      let summary = rest.replace(/^\s*\S+\s+\S+\s*/, "").trim();
      let model: string | undefined;
      if (summary === "") {
        const a = entries.indexOf(from);
        const b = entries.indexOf(to);
        if (a > b) {
          yield { type: "error", message: "the range runs backwards: give the earlier entry first", hint: "numbers count back from the last entry, so the earlier entry has the larger number" };
          return;
        }
        const lines = await formatTranscript(ctx.convo, entries.slice(a, b + 1).filter((e) => e.$tag !== "agent_setup"), { thinking: "off", tools: "brief", max: 4000 });
        const r = await askModel(ctx.convo, `Summarise this part of a conversation so that it can replace it in the model's context. Keep decisions, facts, names, numbers and open questions; drop pleasantries. Plain text.\n\n${lines.join("\n")}`);
        yield { type: "notice", message: `summary of ${b - a + 1} entries by ${r.model} (${r.usage.input} in, ${r.usage.output} out; not in the ledger):` };
        yield { type: "text", text: r.text };
        if (!(await ctx.confirm("Replace them with this summary?"))) {
          yield { type: "notice", message: "not compacted" };
          return;
        }
        summary = r.text;
        model = r.model;
      }
      await ctx.convo.compact({ from: from.id, to: to.id, summary, ...(model === undefined ? {} : { model }) });
      yield { type: "notice", message: "compacted: the model now sees the summary in place of that range; the entries stay in the transcript" };
    } catch (e) {
      yield failure(e);
    }
  },
};

const exportCmd: Command = {
  name: "export",
  summary: "the thread as Markdown, to a file or here",
  usage: "/export [file] [--thinking] [--force]",
  busy: "allowed",
  async *run(ctx, args) {
    try {
      const p = parseArgs({ args, allowPositionals: true, options: { thinking: { type: "boolean" }, force: { type: "boolean" } } });
      if (p.positionals.length > 1) {
        yield { type: "error", message: "give one file", hint: "/export [file] [--thinking] [--force]" };
        return;
      }
      const md = await exportMarkdown(ctx.convo, await entriesOf(ctx), { thread: ctx.engine.thread, thinking: p.values.thinking === true, now: new Date(ctx.io.now()) });
      const file = p.positionals[0];
      if (file === undefined) {
        yield { type: "text", text: md };
        return;
      }
      const path = resolve(ctx.io.cwd, file);
      if (p.values.force !== true && (await ctx.io.host.fs.stat(path)) !== undefined) {
        yield { type: "error", message: `${path} already exists`, hint: "--force overwrites it" };
        return;
      }
      await ctx.io.host.fs.writeAtomic(path, new TextEncoder().encode(md));
      yield { type: "notice", message: `wrote ${path}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

const log: Command = {
  name: "log",
  summary: "the thread's commits, newest first",
  usage: "/log [n]  (default 20)",
  busy: "allowed",
  async *run(ctx, args) {
    const n = args[0] === undefined ? 20 : Number(args[0]);
    if (!Number.isInteger(n) || n < 1) {
      yield { type: "error", message: `${args[0]} is not a number of commits` };
      return;
    }
    try {
      const g = await readCommitGraph(ctx.convo);
      const shown = g.commits.slice(-n).reverse();
      yield { type: "text", text: shown.map((c) => `${c.hash.slice(0, 8)}  ${c.branch}  ${c.kind}${c.recovered ? " (recovered)" : ""}  ${c.summary}${c.parents.length > 1 ? "  (merge)" : ""}`).join("\n") };
    } catch (e) {
      yield failure(e);
    }
  },
};

const clear: Command = {
  name: "clear",
  summary: "clear the screen",
  usage: "/clear",
  busy: "allowed",
  async *run() {
    yield { type: "clear" };
  },
};

/** Text through the user's editor: `initial` goes in, the saved text comes back (undefined if the editor failed). The scratch file is removed. */
export async function editText(ctx: Ctx, fileName: string, initial: string): Promise<string | undefined> {
  const file = ctx.io.host.path.join(ctx.engine.project.mainRoot, ".chattree", "tmp", fileName);
  await ctx.io.host.fs.writeAtomic(file, new TextEncoder().encode(initial));
  try {
    if (!(await ctx.engine.edit(file))) return undefined;
    return new TextDecoder().decode(await ctx.io.host.fs.read(file)).replace(/\s+$/, "");
  } finally {
    await ctx.io.host.fs.remove(file);
  }
}

/** The prompt draft in the user's editor: what is there now goes in, what is saved comes back as the draft. */
async function* editDraft(ctx: Ctx): AsyncGenerator<import("../output.ts").Output, void> {
  const text = await editText(ctx, "draft.md", ctx.state.draft);
  if (text === undefined) {
    yield { type: "error", message: "the editor did not exit cleanly; the draft is unchanged" };
    return;
  }
  ctx.state.draft = text;
  yield { type: "notice", message: ctx.state.draft === "" ? "the draft is empty" : "the draft is updated; a blank line sends it, or /say" };
}

const edit: Command = {
  name: "edit",
  summary: "write the draft in your editor",
  usage: "/edit  (same as /draft edit)",
  busy: "allowed",
  async *run(ctx) {
    try {
      yield* editDraft(ctx);
    } catch (e) {
      yield failure(e);
    }
  },
};

export const miscCommands: Command[] = [compact, exportCmd, log, clear, edit];
export { editDraft };
