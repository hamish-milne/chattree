import type { Conversation } from "./conversation.ts";
import { syncTools } from "./loop.ts";
import type { StartedJob, Tool, ToolOutput, ToolRegistry } from "./tools.ts";
import { optStringArg, stringArg } from "./tool-args.ts";
import { unanswered } from "./tip.ts";

/**
 * The `fork` and `merge` tools. `fork` starts a side conversation with everything the model already knows: it
 * makes a branch from here and returns at once. `merge` brings a fork back (the trunk wins) and its summary is what the
 * model sees from then on.
 */
export interface ForkDeps {
  /** The thread that makes the calls. */
  convo: Conversation;
  /** Make a fork of `convo` (the host decides where its worktree goes). */
  createFork(name?: string): Promise<{ branch: string; conversation: Conversation }>;
  /**
   * With this the fork starts at once, as with the `fork` system call: the call returns in both threads. In the caller it says the fork is
   * under way; in the fork it says where the model is and carries `message`, and whoever pumps threads (`pump.ts`) runs the fork from
   * there. The fork's tools are pinned to `childRegistry` (the leaf tools: one level of nesting).
   */
  auto?: { childRegistry: ToolRegistry };
}

// Branch names a fork may be given: a conservative subset of git ref names, starting with a letter or digit.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_/-]{0,60}$/;

export function forkTool(deps: ForkDeps): Tool {
  return {
    definition: {
      name: "fork",
      description:
        "Start a side conversation with the user about one topic: a copy of this conversation, with everything said so far and the files as they are now, on its own branch. A fork is for the user to collaborate with you on that topic as a conversation, for example one thread per item of a list you just made. It shares all of your context, so do not repeat or summarize it; `message` needs only what is new there (the topic, the angle, the question to open with). If the work is autonomous and yours to own, use `subagent` instead. The call returns at once, in both threads, as the fork system call does: here with the branch name, and in the fork as the place you carry on from, with `message` as your brief there; you open the conversation in the fork yourself. The user moves there with /thread and the fork is brought back with `merge`.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "A short branch name (letters, digits, - _ /). Optional: forks are numbered fork/1, fork/2 ...",
          },
          message: {
            type: "string",
            description:
              "Only what is new in the fork: the topic or the opening question, which you will see there as your brief. The fork already has this whole conversation, so give no background and no full task brief. Optional.",
          },
        },
      },
    },
    allowKeys: () => ["all"],
    execute: async (args, ctx): Promise<ToolOutput | StartedJob> => {
      const name = optStringArg(args, "name");
      const message = optStringArg(args, "message");
      if (name !== undefined && !SAFE_NAME.test(name))
        return { content: "name must be letters, digits, - _ and / (at most 61 characters)", is_error: true };
      const made = await deps.createFork(name);
      const brief = message === undefined || message.trim() === "" ? undefined : message.trim();
      // In the fork this call has no answer yet: say there what happened, so the model there knows where it is.
      await made.conversation.append({
        $tag: "tool_result",
        call_id: ctx.callId,
        is_error: false,
        content:
          `You are now in the fork ${made.branch}, a side conversation with the user started from the thread above; the thread above carries on without you. ` +
          (deps.auto === undefined || brief === undefined ? "Carry on from here" : `Go ahead with your brief: ${brief}`) +
          `. Your work is brought back with the merge tool, not before.`,
      });
      // Other calls of the same turn were for the thread above to make; the fork has nothing to run for them.
      const forkEntries = (await made.conversation.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
      for (const id of unanswered(forkEntries))
        await made.conversation.append({
          $tag: "tool_result",
          call_id: id,
          is_error: false,
          content: "This call was made in the thread above, which carries it out there.",
        });
      if (deps.auto !== undefined) {
        // Tools pinned to the leaf tools so the pump can run the fork by itself; it goes on from the result above.
        await syncTools(made.conversation, deps.auto.childRegistry);
        return {
          content: `Forked ${made.branch}. It is under way there with your brief; the user carries on with it in that thread. Bring it back with merge when it has settled.`,
        };
      }
      return {
        content: `Forked ${made.branch}. Nothing runs there until the user moves there with /thread ${made.branch} and writes; bring it back with merge.`,
      };
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
      const branch = stringArg(args, "branch");
      const summary = stringArg(args, "summary").trim();
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
