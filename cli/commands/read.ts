import type { ChatEntry } from "../../harness/entries.ts";
import { formatEntry, type Thinking } from "../output.ts";
import { verifyHistory } from "../../harness/verify.ts";
import type { Command } from "../registry.ts";
import type { Ctx } from "../engine.ts";

const entriesOf = async (ctx: Ctx): Promise<ChatEntry[]> => (await ctx.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));

export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const history: Command = {
  name: "history",
  aliases: ["log"],
  summary: "print the last entries of the thread",
  usage: "/history [n]  (default 10)",
  busy: "allowed",
  async *run(ctx, args) {
    const n = args[0] === undefined ? 10 : Number(args[0]);
    if (!Number.isInteger(n) || n < 1) {
      yield { type: "error", message: `${args[0]} is not a number of entries` };
      return;
    }
    const shown = (await entriesOf(ctx)).filter((e) => e.$tag !== "header").slice(-n);
    for (const value of shown) yield { type: "entry", value };
  },
};

const show: Command = {
  name: "show",
  summary: "one entry in full",
  usage: "/show [n | id]  (n counts back from the last entry, default 1)",
  busy: "allowed",
  async *run(ctx, args) {
    const all = (await entriesOf(ctx)).filter((e) => e.$tag !== "header");
    const want = args[0] ?? "1";
    let entry: ChatEntry | undefined;
    if (/^\d+$/.test(want) && Number(want) <= all.length) entry = all[all.length - Number(want)];
    else entry = all.find((e) => "id" in e && e.id.startsWith(want));
    if (entry === undefined) {
      yield { type: "error", message: `no entry matches ${want}` };
      return;
    }
    const text = await formatEntry(ctx.convo, entry, { thinking: "on" });
    const extra = entry.$tag === "assistant" ? `\nstop: ${entry.stop_reason}${entry.usage === undefined ? "" : `  usage: ${JSON.stringify(entry.usage)}`}` : entry.$tag === "interrupted" && entry.usage !== undefined ? `\nusage: ${JSON.stringify(entry.usage)}` : "";
    yield { type: "text", text: `${"id" in entry ? `id ${entry.id}\n` : ""}${text ?? ""}${extra}` };
  },
};

const thinking: Command = {
  name: "thinking",
  summary: "whether the model's reasoning is shown",
  usage: "/thinking [on | brief | off]",
  busy: "allowed",
  async *run(ctx, args) {
    const v = args[0];
    if (v === undefined) {
      yield { type: "text", text: `thinking is ${ctx.state.thinking}` };
      return;
    }
    if (v !== "on" && v !== "off" && v !== "brief") {
      yield { type: "error", message: `${v} is not on, brief or off` };
      return;
    }
    ctx.state.thinking = v as Thinking;
    yield { type: "notice", message: `thinking is ${v}` };
  },
};

const usage: Command = {
  name: "usage",
  summary: "what this thread has cost",
  usage: "/usage",
  busy: "allowed",
  async *run(ctx) {
    const l = await ctx.convo.ledger();
    const usd = (n: number): string => `$${n.toFixed(4)}`;
    const lines = [
      `this turn:   ${usd(l.turn.usd)} in ${l.turn.requests} request${l.turn.requests === 1 ? "" : "s"}${l.turn.unpriced > 0 ? ` (${l.turn.unpriced} without a known price)` : ""}`,
      `this thread: ${usd(l.conversation.usd)} in ${l.conversation.requests} request${l.conversation.requests === 1 ? "" : "s"}${l.conversation.unpriced > 0 ? ` (${l.conversation.unpriced} without a known price, so this is a floor)` : ""}`,
    ];
    for (const [model, v] of Object.entries(l.byModel)) lines.push(`  ${model}: ${usd(v.usd)} in ${v.requests}`);
    yield { type: "text", text: lines.join("\n") };
  },
};

const status: Command = {
  name: "status",
  summary: "thread, model, spend and what is staged",
  usage: "/status",
  busy: "allowed",
  async *run(ctx) {
    const { engine, convo } = ctx;
    const setup = await convo.setup();
    const act = await convo.activity();
    const l = await convo.ledger().catch(() => undefined);
    const lines = [
      `thread:      ${engine.thread}  (${convo.dir})`,
      `model:       ${setup.model === undefined ? "(none set)" : `${setup.model.provider}/${setup.model.resolved ?? setup.model.id}`}${setup.model?.settings === undefined ? "" : `  ${JSON.stringify(setup.model.settings)}`}`,
      `prices:      ${setup.pricing === undefined ? "not pinned (costs are unknown until /pricing pin)" : `pinned ${setup.pricing.table.slice(0, 12)}`}`,
      `spend:       ${l === undefined ? "unknown" : `$${l.conversation.usd.toFixed(4)}${l.conversation.unpriced > 0 ? "+" : ""} this thread, $${l.turn.usd.toFixed(4)} this turn`}`,
      `activity:    ${act.state === "idle" ? "idle" : act.live ? `a request to ${act.model} is running${act.owner?.pid === undefined ? "" : ` (process ${act.owner.pid})`}` : `a request to ${act.model} died; it is recorded when the thread is next used`}`,
      `session:     ${engine.sessionId ?? "(none: one-shot)"}`,
      `staged:      ${engine.state.attachments.length} file${engine.state.attachments.length === 1 ? "" : "s"}, draft ${engine.state.draft.length} characters, thinking ${engine.state.thinking}`,
    ];
    if (engine.degraded !== undefined) lines.push(`providers:   unavailable (${engine.degraded})`);
    if (setup.unacknowledged.length > 0) lines.push(`attention:   the provider changed the agent; /accept it to carry on`);
    yield { type: "text", text: lines.join("\n") };
  },
};

const threads: Command = {
  name: "threads",
  summary: "list threads",
  usage: "/threads [archived | merged | running | idle | all]  (default: everything not archived)",
  busy: "allowed",
  async *run(ctx, args) {
    const filter = args[0] ?? "";
    if (!["", "archived", "merged", "running", "idle", "all"].includes(filter)) {
      yield { type: "error", message: `${filter} is not archived, merged, running, idle or all` };
      return;
    }
    const branches = await ctx.convo.listBranches();
    const info = await ctx.convo.git.objectInfo(branches.map((b) => `${b.tip}:chat.yml`));
    const merged = filter === "merged" || filter === "all" ? await ctx.convo.mergedBranches() : new Set<string>();
    const rows = branches
      .filter((_, i) => info[i] !== undefined)
      .filter((b) => (filter === "" ? !b.archived : filter === "all" ? true : filter === "archived" ? b.archived : filter === "merged" ? merged.has(b.name) : filter === "running" ? b.running : !b.running));
    if (rows.length === 0) {
      yield { type: "text", text: "(no threads match)" };
      return;
    }
    const width = Math.max(...rows.map((r) => r.name.length));
    const now = ctx.io.now();
    yield {
      type: "text",
      text: rows
        .map((b) => `${b.name === ctx.engine.thread ? "*" : " "} ${b.name.padEnd(width)}  ${ago(b.lastActivity, now).padEnd(8)}${[b.running ? "running" : "", b.archived ? "archived" : "", merged.has(b.name) ? "merged" : ""].filter((x) => x !== "").join(" ")}`.trimEnd())
        .join("\n"),
    };
  },
};

const verify: Command = {
  name: "verify",
  summary: "check the thread's history",
  usage: "/verify",
  busy: "allowed",
  async *run(ctx) {
    const problems = await verifyHistory(ctx.convo);
    yield { type: "text", text: problems.length === 0 ? "the history is consistent" : problems.map((p) => `${p.severity}: ${p.code}: ${p.message}`).join("\n") };
  },
};

const maintain: Command = {
  name: "maintain",
  summary: "pack the repository's loose objects now",
  usage: "/maintain",
  busy: "allowed",
  async *run(ctx) {
    const r = await ctx.convo.maintain();
    yield { type: "text", text: `${r.action}: ${r.before.looseObjects} loose objects and ${r.before.packs} packs before, ${r.after.looseObjects} and ${r.after.packs} after` };
  },
};

export const readCommands: Command[] = [history, show, thinking, usage, status, threads, verify, maintain];
