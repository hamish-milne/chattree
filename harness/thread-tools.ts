import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import type { Tool, ToolOutput } from "./tools.ts";

/**
 * The `thread_read` and `thread_send` tools (docs/tools.md, 4.3). A parent reads what a child has done and tells it something; a child
 * tells its parent something without ending. Who may talk is worked out from the history, never from what the model says: a thread
 * knows where it came from (the last `branch_start` in its own entries), so a parent is the thread that started this one, a child is a
 * thread this one started, and siblings share a parent. A message is a `user` entry on the receiver's branch (queued, with `from`), so it
 * is part of the receiver's own context and is paid for there; the pump wakes the receiver if it was waiting.
 */
export interface ThreadDeps {
  /** Any conversation of the project: used to look at other branches (the thread making a call comes from the call's context). */
  convo: Conversation;
  /** Siblings may talk (`threads.siblings`). */
  siblings?: boolean;
}

export type Relation = "parent" | "child" | "sibling";

const decoded = (rs: Awaited<ReturnType<Conversation["readEntriesAt"]>>): ChatEntry[] => rs.flatMap((e) => (e.ok ? [e.value] : []));

/** The entries on a branch. */
async function entriesOf(convo: Conversation, branch: string): Promise<ChatEntry[] | undefined> {
  if ((await convo.git.revParse(`refs/heads/${branch}`)) === undefined) return undefined;
  return decoded(await convo.readEntriesAt(`refs/heads/${branch}`));
}

/** Where a thread was started from (its own `branch_start` is the last one: what comes before it is the history it inherited). */
export function originOf(entries: readonly ChatEntry[]): string | undefined {
  const start = entries.findLast((e) => e.$tag === "branch_start");
  return start?.$tag === "branch_start" ? start.from.branch : undefined;
}

/** How `other` relates to `self`, from the two threads' histories; undefined when they are not kin. */
export function relation(self: string, selfEntries: readonly ChatEntry[], other: string, otherEntries: readonly ChatEntry[]): Relation | undefined {
  const mine = originOf(selfEntries);
  const theirs = originOf(otherEntries);
  if (other === self) return undefined;
  if (mine === other) return "parent";
  if (theirs === self) return "child";
  if (mine !== undefined && theirs === mine) return "sibling";
  return undefined;
}

const MAX_TOTAL = 16_000;
const SHORT = 300;
const LONG = 4000;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length - n} more characters)`);
const flat = (t: string | { bytes: number; sha256: string }): string => (typeof t === "string" ? t : `(${t.bytes} bytes, kept as blob:${t.sha256})`);

/** One entry as a line or two of text for the reader, or undefined for entries that say nothing about the work (setup, approvals). */
export function describe(e: ChatEntry, full: boolean): string | undefined {
  const n = full ? LONG : SHORT;
  switch (e.$tag) {
    case "user": {
      const text = e.content.map((p) => (p.$tag === "text" ? flat(p.text) : `[attachment ${p.name ?? ""}]`)).join(" ");
      return `user: ${clip(text, n)}`;
    }
    case "assistant": {
      const parts: string[] = [];
      for (const b of e.blocks) {
        if (b.$tag === "text") parts.push(clip(flat(b.text), n));
        else if (b.$tag === "tool_call") parts.push(`called ${b.name}(${clip(JSON.stringify(b.args ?? {}), full ? 1000 : 160)})`);
      }
      return parts.length === 0 ? undefined : `assistant: ${parts.join(" | ")}`;
    }
    case "tool_result":
      return `${e.is_error ? "error result" : "result"}: ${clip(flat(e.content), n)}`;
    case "subagent_result":
      return `subagent report: ${clip(flat(e.summary), n)}`;
    case "fork_merge":
      return `fork merged: ${clip(flat(e.summary), n)}`;
    case "job_event":
      return `job ${e.job} ${e.status}: ${clip(flat(e.summary), n)}`;
    case "interrupted":
      return `interrupted (${e.by})`;
    default:
      return undefined;
  }
}

/** What a thread has done: its own entries (those after it was started), numbered from 1, the newest `last` of them or those after `since`. */
export function transcript(entries: readonly ChatEntry[], opts: { last: number; since?: number; full: boolean }): string {
  const start = entries.findLastIndex((e) => e.$tag === "branch_start");
  const own = entries.slice(start + 1);
  const lines: { n: number; text: string }[] = [];
  own.forEach((e, i) => {
    const text = describe(e, opts.full);
    if (text !== undefined) lines.push({ n: i + 1, text });
  });
  const total = own.length;
  let shown = opts.since !== undefined ? lines.filter((l) => l.n > (opts.since as number)) : lines.slice(-opts.last);
  let dropped = 0;
  let size = shown.reduce((a, l) => a + l.text.length + 8, 0);
  while (size > MAX_TOTAL && shown.length > 1) {
    size -= (shown[0] as { text: string }).text.length + 8;
    shown = shown.slice(1);
    dropped++;
  }
  if (shown.length === 0) return `Nothing new: the thread has ${total} entries of its own${opts.since === undefined ? "" : `, and you have seen up to ${opts.since}`}.`;
  const first = (shown[0] as { n: number }).n;
  const last = (shown[shown.length - 1] as { n: number }).n;
  const head = `Entries ${first}-${last} of ${total} (the thread's own, counted from when it started).${dropped > 0 ? ` ${dropped} older entries were left out to keep this short.` : ""}`;
  return `${head}\n${shown.map((l) => `#${l.n} ${l.text}`).join("\n")}\n(To read what comes after, call again with since=${last}. Long results are cut: full=true shows more, and a blob can be read with the read tool.)`;
}

/** `parent` names the thread this one was started from. */
const resolveName = (name: string, selfEntries: readonly ChatEntry[]): string | undefined => (name === "parent" ? originOf(selfEntries) : name);

async function resolve(deps: ThreadDeps, self: string | undefined, name: string): Promise<{ branch: string; entries: ChatEntry[]; relation: Relation } | { error: string }> {
  if (self === undefined) return { error: "this call has no thread to speak from" };
  const mine = await entriesOf(deps.convo, self);
  if (mine === undefined) return { error: `thread ${self} is not a branch of this conversation` };
  const branch = resolveName(name, mine);
  if (branch === undefined) return { error: "this thread has no parent: it was not started from another thread" };
  if (branch === self) return { error: "that is this thread" };
  const theirs = await entriesOf(deps.convo, branch);
  if (theirs === undefined) return { error: `there is no thread ${branch}` };
  const rel = relation(self, mine, branch, theirs);
  if (rel === undefined) return { error: `${branch} is not your parent or a thread you started${deps.siblings === true ? ", or a sibling" : ""}: only those may be read or sent to` };
  if (rel === "sibling" && deps.siblings !== true) return { error: `${branch} is a sibling; threads may talk to siblings only when harness.yml sets threads.siblings: true` };
  return { branch, entries: theirs, relation: rel };
}

export function threadTools(deps: ThreadDeps): Tool[] {
  const read: Tool = {
    definition: {
      name: "thread_read",
      description:
        "Read what another thread has done: its messages, the calls it made and their results, as text. You may read the thread you were started from (use \"parent\") and the threads you started (a subagent or a fork). Only the thread's own entries are shown, not the history it inherited from you. By default the newest 20; use `since` to read on from where you stopped.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["thread"],
        properties: {
          thread: { type: "string", description: "The thread's branch name, or \"parent\"." },
          last: { type: "integer", minimum: 1, maximum: 200, description: "How many of the newest entries to show. Default 20." },
          since: { type: "integer", minimum: 0, description: "Show the entries after this number (from an earlier read), instead of the newest." },
          full: { type: "boolean", description: "Show long messages and results at more length. Default false." },
        },
      },
    },
    allowKeys: () => ["all"],
    execute: async (args, ctx): Promise<ToolOutput> => {
      const r = await resolve(deps, ctx.thread, args["thread"] as string);
      if ("error" in r) return { content: r.error, is_error: true };
      const since = args["since"] as number | undefined;
      return { content: `${r.branch} (your ${r.relation}). ${transcript(r.entries, { last: (args["last"] as number | undefined) ?? 20, ...(since === undefined ? {} : { since }), full: args["full"] === true })}` };
    },
  };

  const send: Tool = {
    definition: {
      name: "thread_send",
      description:
        "Send a message to another thread: the thread you were started from (use \"parent\") or one you started. It arrives as a message from you in that thread; if that thread is working, it sees the message with its next request, and if it was waiting, the message starts it again. Use it to give a running subagent or fork more to do, or to tell the one who started you something (a finding, a question that does not block you) without ending your work. Your own work goes on: nothing is waited for. To hand your work back, use merge.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["thread", "message"],
        properties: {
          thread: { type: "string", description: "The thread's branch name, or \"parent\"." },
          message: { type: "string", description: "What to tell it, written for the one who reads it there." },
        },
      },
    },
    allowKeys: () => ["all"],
    execute: async (args, ctx): Promise<ToolOutput> => {
      const message = (args["message"] as string).trim();
      if (message === "") return { content: "message must not be empty", is_error: true };
      const r = await resolve(deps, ctx.thread, args["thread"] as string);
      if ("error" in r) return { content: r.error, is_error: true };
      const there = await deps.convo.openBranch(r.branch);
      try {
        await there.append({ $tag: "user", queued: true, from: ctx.thread as string, content: [{ $tag: "text", text: `[Message from thread ${ctx.thread as string}]\n${message}` }] });
      } finally {
        await there.close();
      }
      return { content: `Sent to ${r.branch}. It will see it with its next request; you do not get an answer unless it writes back.` };
    },
  };

  return [read, send];
}
