import type { Conversation } from "./conversation.ts";
import { syncTools } from "./loop.ts";
import type { StartedJob, Tool, ToolOutput, ToolRegistry } from "./tools.ts";

/**
 * The `fork` and `merge` tools (docs/tools.md, section 4.2). `fork` is for work to be picked up later with everything the model
 * already knows: it makes a branch from here and returns at once. `merge` brings a fork back (the trunk wins) and its summary is
 * what the model sees from then on.
 */
export interface ForkDeps {
  /** The thread that makes the calls. */
  convo: Conversation;
  /** Make a fork of `convo` (the host decides where its worktree goes). */
  createFork(name?: string): Promise<{ branch: string; conversation: Conversation }>;
  /** `message` was given: the host keeps it as the first message of the fork, for the user to send there. */
  onDraft?(branch: string, message: string): void;
  /**
   * With this, `fork` can take `auto_run: true`: `message` is put in the fork as a user message, and whoever pumps threads (`pump.ts`) runs
   * it like any thread that has been spoken to. The fork's tools are pinned to `childRegistry` (the leaf tools: one level of nesting).
   * Its end is reported to the caller by `deliverForks`.
   */
  auto?: { childRegistry: ToolRegistry };
}

/** The result of an `auto_run` fork call; delivery finds the forks to report on by it. */
export const FORK_STARTED = "started fork";
const FORK_STARTED_RE = /^started fork (\S+?)\./;

/**
 * Report on forks the thread started with `auto_run`: one whose first run has ended (the model answered with text, or the run was cut
 * off) becomes a `job_event` for the caller, once. Returns how many were reported.
 */
export async function deliverForks(convo: Conversation): Promise<number> {
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const done = new Set(entries.flatMap((e) => (e.$tag === "job_event" ? [e.call_id] : [])));
  let delivered = 0;
  for (const e of entries) {
    if (e.$tag !== "tool_result" || typeof e.content !== "string" || done.has(e.call_id)) continue;
    const m = FORK_STARTED_RE.exec(e.content);
    if (m === null) continue;
    const name = m[1] as string;
    if ((await convo.git.revParse(`refs/heads/${name}`)) === undefined) continue;
    const theirs = (await convo.readEntriesAt(`refs/heads/${name}`)).flatMap((x) => (x.ok ? [x.value] : []));
    const last = [...theirs].reverse().find((x) => x.$tag !== "agent_setup" && x.$tag !== "approval");
    if (last?.$tag === "assistant" && !last.blocks.some((b) => b.$tag === "tool_call")) {
      const text = last.blocks.flatMap((b) => (b.$tag === "text" && typeof b.text === "string" ? [b.text] : [])).join("").trim();
      await convo.append({ $tag: "job_event", job: name, call_id: e.call_id, status: "completed", summary: `${name} finished its first run`, ...(text === "" ? {} : { output: text }) });
      delivered++;
    } else if (last?.$tag === "interrupted") {
      await convo.append({ $tag: "job_event", job: name, call_id: e.call_id, status: "failed", summary: `${name} stopped (${last.by === "user" ? "stopped by the user" : "an error"}); its work is on branch ${name}` });
      delivered++;
    }
  }
  return delivered;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,60}$/;

export function forkTool(deps: ForkDeps): Tool {
  return {
    definition: {
      name: "fork",
      description:
        "Start a side conversation: a copy of this conversation, with everything said so far and the files as they are now, on its own branch. Use it for work that should be picked up in its own thread with all the context you have, for example one thread per item of a list you just made. The call returns at once with the branch name; nothing runs in the fork. The user moves there with /thread and the fork is brought back with `merge`. If you give `message`, it is kept as the first message to send in the fork (the user can edit it).",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "A short branch name (letters, digits, - _ /). Optional: forks are numbered fork/1, fork/2 ..." },
          message: { type: "string", description: "What the fork should do first, written for the model that will read it there. Optional." },
          ...(deps.auto === undefined ? {} : { auto_run: { type: "boolean", description: "Send `message` in the fork at once and let it work by itself in the background; you are told when it stops. Needs `message`. Default false: the message waits there for the user to send it." } }),
        },
      },
    },
    allowKeys: () => ["all"],
    execute: async (args, ctx): Promise<ToolOutput | StartedJob> => {
      const name = args["name"] as string | undefined;
      const message = args["message"] as string | undefined;
      const autoRun = args["auto_run"] === true;
      if (autoRun && (deps.auto === undefined || message === undefined || message.trim() === "")) return { content: "auto_run needs a message to send", is_error: true };
      if (name !== undefined && !SAFE_NAME.test(name)) return { content: "name must be letters, digits, - _ and / (at most 61 characters)", is_error: true };
      const made = await deps.createFork(name);
      // In the fork this call has no answer yet: say there what happened, so the model there knows where it is.
      await made.conversation.append({
        $tag: "tool_result",
        call_id: ctx.callId,
        is_error: false,
        content: `You are now in the fork ${made.branch}, a side conversation started from the thread above. Carry on from here; your work is brought back with the merge tool, not before.`,
      });
      if (autoRun && deps.auto !== undefined && message !== undefined) {
        // Tools first, so the message is not split from the reply by a setup entry; then the message is the request that makes the thread run.
        await syncTools(made.conversation, deps.auto.childRegistry);
        await made.conversation.append({ $tag: "user", content: [{ $tag: "text", text: message.trim() }] });
        return { content: `${FORK_STARTED} ${made.branch}. It is working on your message; you will be told when it stops. Merge it with the merge tool when you want its work here.` };
      }
      if (message !== undefined && message.trim() !== "") deps.onDraft?.(made.branch, message.trim());
      return { content: `Forked ${made.branch}. ${message === undefined ? "" : "Your message is waiting there for the user to send. "}The user moves there with /thread ${made.branch}; bring it back with merge.` };
    },
  };
}

export function mergeTool(deps: Pick<ForkDeps, "convo">): Tool {
  return {
    definition: {
      name: "merge",
      description:
        "Bring a fork back into this conversation. Its file changes are merged in (where both changed the same file, this thread's version is kept) and `summary` is added to this conversation as what the fork settled; the fork's own messages stay on its branch. Write the summary for yourself: what was decided and found there, and what the files now contain. Each merge reports only what is new since the last. The user is asked first.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["branch", "summary"],
        properties: {
          branch: { type: "string", description: "The fork's branch name, for example fork/1." },
          summary: { type: "string", description: "What the fork discussed, decided and changed." },
        },
      },
    },
    execute: async (args, ctx) => {
      const branch = args["branch"] as string;
      const summary = (args["summary"] as string).trim();
      if (summary === "") return { content: "summary must say what the fork settled", is_error: true };
      try {
        await deps.convo.assertMergeable(branch);
        const out = await deps.convo.mergeFork(branch, { summary, callId: ctx.callId });
        const r = out.report;
        return {
          content: `Merged ${branch}: ${r.changed.length} changed, ${r.added.length} added, ${r.discarded.length} dropped (this thread's version won), ${r.conflicts.length} conflict${r.conflicts.length === 1 ? "" : "s"}.`,
          recorded: true,
        };
      } catch (e) {
        return { content: `Not merged: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  };
}
