import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodeText, attachmentKind } from "../../harness/attachments.ts";
import type { NewEntry } from "../../harness/conversation.ts";
import { ConversationError } from "../../harness/conversation.ts";
import type { Command } from "../registry.ts";
import type { Ctx, StagedAttachment } from "../engine.ts";
import { detectMime } from "../mime.ts";
import type { Output } from "../output.ts";
import { failure, runTurn } from "../turn.ts";

const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

/** Read the staged files again and turn them into attachment parts; stop with the reason if one changed or is gone. */
async function materialize(ctx: Ctx): Promise<Extract<NewEntry, { $tag: "user" }>["content"]> {
  const parts: Extract<NewEntry, { $tag: "user" }>["content"] = [];
  for (const a of ctx.state.attachments) {
    const st = await ctx.io.host.fs.stat(a.path);
    if (st === undefined) throw new ConversationError(`${a.name} is gone (${a.path}); /detach it or put it back`);
    if (st.size !== a.size || st.mtimeMs !== a.mtimeMs) throw new ConversationError(`${a.name} changed since it was staged; /attach it again to send the new version, or /detach it`);
    const bytes = await ctx.io.host.fs.read(a.path);
    parts.push(await ctx.convo.attach(bytes, { mime: a.mime, name: a.name, ...(a.charset === undefined ? {} : { charset: a.charset }) }));
  }
  return parts;
}

/**
 * Append a user message (the text and the staged files) and run the request. `sent` runs once the message is in the transcript,
 * so whatever it came from (the prompt draft, a named draft) is cleared only when nothing can be lost.
 */
export async function* sendMessage(ctx: Ctx, text: string, sent: () => void): AsyncGenerator<Output, void> {
  if (text === "" && ctx.state.attachments.length === 0) {
    yield { type: "error", message: "there is nothing to send", hint: "type a message, or /attach a file" };
    return;
  }
  if ((await ctx.convo.activity()).state === "request") {
    const r = await ctx.convo.recoverRequest();
    if (r !== undefined) yield { type: "notice", message: `recovered a request that was cut off (${r.outcome})` };
  }
  ctx.engine.sending = true;
  try {
    await ctx.engine.prepareTools();
    const files = await materialize(ctx);
    const content = [...(text === "" ? [] : [{ $tag: "text" as const, text }]), ...files];
    await ctx.convo.append({ $tag: "user", content });
  } catch (e) {
    ctx.engine.sending = false;
    yield failure(e);
    return;
  }
  ctx.state.attachments = [];
  sent();
  const turn = runTurn(ctx);
  // The turn marks itself running as soon as it starts; only then is the pump's own look at the thread safe to ignore.
  try {
    const first = await turn.next();
    ctx.engine.sending = false;
    if (first.done === true) return;
    yield first.value;
    yield* turn;
  } finally {
    ctx.engine.sending = false;
  }
}

/**
 * A message sent while the model is working: it goes into the transcript at once, marked `queued`, and the model is shown it in its next
 * request, after the results of the tool calls in progress. Nothing is started: the running turn picks it up (or, if that turn is
 * already ending, the thread asks for a request when it has ended).
 */
async function* queueMessage(ctx: Ctx, text: string, sent: () => void): AsyncGenerator<Output, void> {
  if (text === "" && ctx.state.attachments.length === 0) {
    yield { type: "error", message: "there is nothing to send", hint: "type a message, or /attach a file" };
    return;
  }
  try {
    const files = await materialize(ctx);
    await ctx.convo.append({ $tag: "user", queued: true, content: [...(text === "" ? [] : [{ $tag: "text" as const, text }]), ...files] });
  } catch (e) {
    yield failure(e);
    return;
  }
  ctx.state.attachments = [];
  sent();
  yield { type: "notice", message: "queued: the model sees it with its next request" };
}

const say: Command = {
  name: "say",
  summary: "send a message (bare text does this); while the model is working it is queued for its next request",
  usage: "/say [text]  (no text sends the draft)",
  busy: "allowed",
  async *run(ctx, _args, rest) {
    const fromDraft = rest.trim() === "";
    // Another session working on the thread counts too: the message is queued in the transcript for whoever is running it.
    if ((await ctx.engine.busyReason()) !== undefined) {
      yield* queueMessage(ctx, fromDraft ? ctx.state.draft.trim() : rest, () => {
        if (fromDraft) ctx.state.draft = "";
      });
      return;
    }
    yield* sendMessage(ctx, fromDraft ? ctx.state.draft.trim() : rest, () => {
      if (fromDraft) ctx.state.draft = "";
    });
  },
};

const retry: Command = {
  name: "retry",
  summary: "ask again when the last message, tool result or tool call got no answer",
  usage: "/retry",
  busy: "blocked",
  async *run(ctx) {
    const entries = (await ctx.convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
    const last = [...entries].reverse().find((e) => e.$tag !== "agent_setup" && e.$tag !== "approval");
    // Where the model is owed a reply: a user message, a tool result (or a job's event after one), or an assistant turn that
    // ended on tool calls nothing has answered (the loop answers those "did not run" and asks again; it never re-runs a call).
    const owed = last?.$tag === "user" || last?.$tag === "tool_result" || last?.$tag === "job_event" || (last?.$tag === "assistant" && last.blocks.some((b) => b.$tag === "tool_call"));
    if (!owed) {
      yield { type: "error", message: `there is nothing to retry: the last entry is ${last === undefined ? "missing" : `a ${last.$tag}`}`, ...(last?.$tag === "interrupted" ? { hint: "/continue asks the model to carry on from where it stopped" } : {}) };
      return;
    }
    yield* runTurn(ctx);
  },
};

const cont: Command = {
  name: "continue",
  summary: "after an interrupted reply, ask the model to carry on",
  usage: "/continue [instruction]",
  busy: "blocked",
  async *run(ctx, _args, rest) {
    ctx.engine.sending = true;
    try {
      try {
        await ctx.convo.continueInterrupted(rest.trim() === "" ? {} : { instruction: rest.trim() });
      } catch (e) {
        yield failure(e);
        return;
      }
      yield* runTurn(ctx);
    } finally {
      ctx.engine.sending = false;
    }
  },
};

const abort: Command = {
  name: "abort",
  summary: "stop the request that is running",
  usage: "/abort",
  busy: "allowed",
  async *run(ctx) {
    if (ctx.engine.abort !== undefined) {
      ctx.engine.abort.abort();
      yield { type: "notice", message: "stopping the request" };
      return;
    }
    const r = await ctx.convo.requestAbort();
    if (r === "requested") yield { type: "notice", message: "asked the session that owns the request to stop it" };
    else if (r === "stale") {
      const rec = await ctx.convo.recoverRequest();
      yield { type: "notice", message: `the request's process is gone; recorded what it had received (${rec?.outcome ?? "nothing to record"})` };
    } else yield { type: "notice", message: "nothing is running on this thread" };
  },
};

const attach: Command = {
  name: "attach",
  summary: "stage a file for the next message",
  usage: "/attach <path> [--mime type/subtype] [--charset label] [--name name]",
  busy: "allowed",
  stages: { show: "attachments", clear: "detach" },
  async complete(ctx, _previous, partial) {
    if (partial.startsWith("-")) return ["--mime", "--charset", "--name"].filter((o) => o.startsWith(partial));
    const slash = partial.lastIndexOf("/");
    const typedDir = slash < 0 ? "" : partial.slice(0, slash + 1);
    const base = partial.slice(slash + 1);
    const dir = resolve(ctx.io.cwd, typedDir === "" ? "." : typedDir);
    const names = await ctx.io.host.fs.readdir(dir).catch(() => [] as string[]);
    const out: string[] = [];
    for (const n of names.sort()) {
      if (!n.startsWith(base) || (n.startsWith(".") && !base.startsWith("."))) continue;
      const st = await ctx.io.host.fs.stat(resolve(dir, n));
      out.push(`${typedDir}${n}${st?.isDirectory === true ? "/" : ""}`);
    }
    return out;
  },
  async *run(ctx, args) {
    let parsed;
    try {
      parsed = parseArgs({ args, allowPositionals: true, options: { mime: { type: "string" }, charset: { type: "string" }, name: { type: "string" } } });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e), hint: "usage: /attach <path> [--mime T] [--charset C] [--name N]" };
      return;
    }
    if (parsed.positionals.length !== 1) {
      yield { type: "error", message: "give the path of one file", hint: "/attach <path> [--mime T] [--charset C] [--name N]" };
      return;
    }
    const path = resolve(ctx.io.cwd, parsed.positionals[0] as string);
    const st = await ctx.io.host.fs.stat(path);
    if (st === undefined || st.isDirectory) {
      yield { type: "error", message: `${path} is not a file` };
      return;
    }
    const name = parsed.values.name ?? basename(path);
    try {
      const bytes = await ctx.io.host.fs.read(path);
      const found = detectMime(name, bytes, { ...(parsed.values.mime === undefined ? {} : { mime: parsed.values.mime }), ...(parsed.values.charset === undefined ? {} : { charset: parsed.values.charset }) });
      if (attachmentKind(found.mime) === undefined) throw new Error(`${found.mime} files cannot be given to a model (images: png, jpeg, gif, webp; PDFs; text)`);
      if (attachmentKind(found.mime) === "text") decodeText(bytes, found.charset);
      const staged: StagedAttachment = { path, name, mime: found.mime, ...(found.charset === undefined ? {} : { charset: found.charset }), size: bytes.length, mtimeMs: st.mtimeMs ?? 0 };
      ctx.state.attachments = [...ctx.state.attachments.filter((a) => a.path !== path), staged];
      yield { type: "notice", message: `staged ${name} (${found.mime}${found.charset === undefined ? "" : `, ${found.charset}`}, ${kb(bytes.length)}); it is sent with your next message` };
    } catch (e) {
      yield failure(e);
    }
  },
};

const attachments: Command = {
  name: "attachments",
  summary: "list the files staged for the next message",
  usage: "/attachments",
  busy: "allowed",
  async *run(ctx) {
    if (ctx.state.attachments.length === 0) yield { type: "text", text: "nothing is staged" };
    else yield { type: "text", text: ctx.state.attachments.map((a, i) => `${i + 1}. ${a.name}  ${a.mime}${a.charset === undefined ? "" : ` (${a.charset})`}  ${kb(a.size)}  ${a.path}`).join("\n") };
  },
};

const detach: Command = {
  name: "detach",
  summary: "unstage a file (by number or name) or all of them",
  usage: "/detach <n|name|all>",
  busy: "allowed",
  async complete(ctx, _previous, partial) {
    return ["all", ...ctx.state.attachments.map((a) => a.name)].filter((n) => n.startsWith(partial));
  },
  async *run(ctx, args) {
    const which = args[0];
    if (which === undefined) {
      yield { type: "error", message: "say which: a number from /attachments, a name, or all" };
      return;
    }
    const before = ctx.state.attachments.length;
    if (which === "all") ctx.state.attachments = [];
    else ctx.state.attachments = ctx.state.attachments.filter((a, i) => !(String(i + 1) === which || a.name === which));
    const removed = before - ctx.state.attachments.length;
    yield removed === 0 ? { type: "error", message: `nothing staged matches ${which}` } : { type: "notice", message: `unstaged ${removed} file${removed === 1 ? "" : "s"}` };
  },
};

export const chatCommands: Command[] = [say, retry, cont, abort, attach, attachments, detach];
export type { Output };
