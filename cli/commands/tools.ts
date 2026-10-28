import { keyProblem, liveKeys, untilAfter } from "../../harness/approvals.ts";
import type { ChatEntry } from "../../harness/entries.ts";
import type { Ctx } from "../engine.ts";
import type { Command } from "../registry.ts";

const entriesOf = async (ctx: Ctx): Promise<ChatEntry[]> => (await ctx.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

/** `5m`, `2h`, `1d`, `90s` or `forever`, in seconds (forever is infinite). */
export function parseDuration(text: string): number | undefined {
  if (text === "forever") return Infinity;
  const m = /^(\d+)\s*([smhd])$/.exec(text);
  if (m === null) return undefined;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[m[2] as "s" | "m" | "h" | "d"];
}

const tools: Command = {
  name: "tools",
  summary: "the model's tools and what is allowed without asking; /tools <name> allow|revoke",
  usage: "/tools   |   /tools <name> allow [key] [5m|1h|forever]   |   /tools <name> revoke [key]",
  busy: "allowed",
  async *run(ctx, args) {
    const set = await ctx.engine.toolset();
    if (set === undefined) {
      yield { type: "notice", message: "this session gives the model no tools (`chattree chat` does)" };
      return;
    }
    const store = ctx.convo.grantStore();
    const now = ctx.convo.now();
    if (args.length === 0) {
      const lines: string[] = [];
      for (const name of set.registry.names()) {
        const map = await store.allow(name);
        const live = liveKeys(map, now);
        const keys = live.length === 0 ? "asks every time" : live.map((k) => `${k === "all" ? "everything" : k} until ${map?.[k]}`).join("; ");
        lines.push(`${name.padEnd(11)} ${keys}`);
      }
      yield { type: "text", text: lines.join("\n") };
      return;
    }
    const [name, verb, ...more] = args;
    const tool = set.registry.get(name as string);
    if (tool === undefined) {
      yield { type: "error", message: `there is no tool ${name}`, hint: `tools: ${set.registry.names().join(", ")}` };
      return;
    }
    if (verb === "allow") {
      const last = more.at(-1);
      const durationText = last !== undefined && parseDuration(last) !== undefined ? last : "forever";
      const key = more[0] !== undefined && more[0] !== durationText ? more[0] : "all";
      const seconds = parseDuration(durationText);
      if (seconds === undefined) {
        yield { type: "error", message: `${durationText} is not a duration`, hint: "use 5m, 1h, 1d or forever" };
        return;
      }
      const problem = keyProblem(tool, key);
      if (problem !== undefined) {
        yield { type: "error", message: problem };
        return;
      }
      const until = untilAfter(now, seconds);
      await store.grant(name as string, [key], until, { commit: !Number.isFinite(seconds) });
      yield { type: "notice", message: `${name}: ${key === "all" ? "everything" : key} allowed until ${until}` };
      return;
    }
    if (verb === "revoke") {
      await ctx.convo.revokeGrant(name as string, more[0]);
      yield { type: "notice", message: `${name}: ${more[0] === undefined ? "every grant removed" : `${more[0]} removed`}` };
      return;
    }
    yield { type: "error", message: `/tools ${name} needs allow or revoke`, hint: "/tools <name> allow [key] [5m|1h|forever]   or   /tools <name> revoke [key]" };
  },
  async complete(ctx, previous, partial) {
    const set = await ctx.engine.toolset();
    if (set === undefined) return [];
    if (previous.length === 0) return set.registry.names().filter((n) => n.startsWith(partial));
    if (previous.length === 1) return ["allow", "revoke"].filter((v) => v.startsWith(partial));
    return [];
  },
};

const jobs: Command = {
  name: "jobs",
  summary: "background jobs the model started; /jobs stop <id> stops one",
  usage: "/jobs   |   /jobs stop <id>",
  busy: "allowed",
  async *run(ctx, args) {
    const set = await ctx.engine.toolset();
    if (set === undefined) {
      yield { type: "notice", message: "this session gives the model no tools" };
      return;
    }
    if (args[0] === "stop") {
      const id = args[1];
      if (id === undefined) yield { type: "error", message: "which job?", hint: "/jobs stop <id>" };
      else yield set.jobs.stop(id) ? { type: "notice", message: `asked ${id} to stop` } : { type: "error", message: `${id} is not a running job` };
      return;
    }
    const list = set.jobs.list();
    yield { type: "text", text: list.length === 0 ? "no background jobs in this session" : list.map((j) => `${j.id}  ${j.status.padEnd(9)} ${j.label}`).join("\n") };
  },
};

const expand: Command = {
  name: "expand",
  summary: "show the whole of a tool result (the last one, or the nth counting back)",
  usage: "/expand [n]",
  busy: "allowed",
  async *run(ctx, args) {
    const n = args[0] === undefined ? 1 : Number(args[0]);
    if (!Number.isInteger(n) || n < 1) {
      yield { type: "error", message: `${args[0]} is not a number counting back from the last tool result` };
      return;
    }
    const results = (await entriesOf(ctx)).filter((e): e is Extract<ChatEntry, { $tag: "tool_result" }> => e.$tag === "tool_result");
    const e = results.at(-n);
    if (e === undefined) {
      yield { type: "error", message: results.length === 0 ? "there are no tool results yet" : `there are only ${results.length} tool results` };
      return;
    }
    const ref = e.full ?? (typeof e.content === "string" ? undefined : e.content);
    const text = ref === undefined ? (e.content as string) : new TextDecoder().decode(await ctx.convo.store.get(ref.sha256));
    yield { type: "text", text: `${e.is_error ? "[error] " : ""}${text}` };
  },
};

const more: Command = {
  name: "more",
  summary: "the next page of output that did not fit the screen",
  usage: "/more",
  busy: "allowed",
  async *run(ctx) {
    const rest = ctx.engine.more;
    ctx.engine.more = "";
    yield rest === "" ? { type: "notice", message: "there is nothing more to show" } : { type: "text", text: rest };
  },
};

export const toolCommands: Command[] = [tools, jobs, expand, more];
