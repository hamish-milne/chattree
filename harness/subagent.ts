import type { Conversation } from "./conversation.ts";
import { runLoop, syncTools, type LoopEvent, type LoopOptions, type LoopResult } from "./loop.ts";
import { ALL } from "./approvals.ts";
import type { Tool, ToolRegistry } from "./tools.ts";

/**
 * The `subagent` tool (docs/tools.md, section 4.2). It hands a self-contained task to a fresh-context child on its own branch and
 * worktree, runs the child's loop to the end, and, when the child finished, merges its work back (the trunk wins) and answers the
 * call with the `subagent_result` entry the merge writes. The child gets the registry it is given (no meta tools: depth one).
 */
export interface SubagentDeps {
  /** The thread that makes the calls. */
  convo: Conversation;
  /** The tools the child works with. */
  childRegistry: ToolRegistry;
  /** How the child's loop is run: system prompt, approvals (labelled by `name`), owner and so on. The tool sets the rest. */
  loopOptions(child: Conversation, name: string): Omit<LoopOptions, "registry" | "signal" | "jobs">;
  /** Every event of the child's loop, for a host that shows what the child does. */
  onEvent?(name: string, event: LoopEvent): void;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/;

const finalText = (r: LoopResult): string => {
  if (r.last?.status !== "completed") return "";
  return r.last.completed.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
};

export function subagentTool(deps: SubagentDeps): Tool {
  return {
    definition: {
      name: "subagent",
      description:
        "Hand a self-contained task to a subagent: a fresh assistant that has the file tools but none of this conversation, works on its own copy of the workspace, and reports back. Its file changes are merged into yours when it finishes (where both changed the same file, yours is kept). Put everything it needs in `brief`: it knows nothing else. Good for work that is large, or independent of what you are doing, or that would fill this conversation with detail you do not need. The call returns the subagent's final message and the files that changed.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["brief"],
        properties: {
          brief: { type: "string", description: "The task, complete in itself: the goal, the files and constraints that matter, and what to report back." },
          name: { type: "string", description: "A short label for the subagent's branch (letters, digits, - and _). Optional." },
        },
      },
    },
    allowKeys: () => [ALL],
    execute: async (args, ctx) => {
      const brief = args["brief"] as string;
      const label = args["name"] as string | undefined;
      if (label !== undefined && !SAFE_NAME.test(label)) return { content: "name must be letters, digits, - and _ (at most 31 characters)", is_error: true };
      const spawned = await deps.convo.spawnSubagent({ brief, callId: ctx.callId, ...(label === undefined ? {} : { name: `sub/${label}` }) });
      const child = spawned.conversation;
      if (child === undefined) return { content: "the subagent's workspace could not be created", is_error: true };
      const name = spawned.branch;
      let result: LoopResult;
      try {
        await deps.convo.copySetupTo(child, "subagent");
        await syncTools(child, deps.childRegistry);
        const loop = runLoop(child, { grants: child.grantStore(), ...deps.loopOptions(child, name), registry: deps.childRegistry, signal: ctx.signal });
        for (;;) {
          const n = await loop.next();
          if (n.done) {
            result = n.value;
            break;
          }
          deps.onEvent?.(name, n.value);
        }
      } catch (e) {
        return { content: `The subagent stopped with an error and nothing was merged: ${e instanceof Error ? e.message : String(e)}. Its work is on branch ${name}.`, is_error: true };
      }
      if (result.status !== "completed") {
        return { content: `The subagent did not finish (${result.status}), so nothing was merged. Its work so far is on branch ${name}.`, is_error: true };
      }
      const summary = finalText(result);
      const outcome = await deps.convo.finishSubagent(child, { summary: summary === "" ? "(the subagent ended without a final message)" : summary, callId: ctx.callId });
      const dropped = outcome.report.discarded;
      return {
        content: `Subagent ${name} finished. ${outcome.report.changed.length + outcome.report.added.length} file(s) merged${dropped.length > 0 ? `; kept your version of ${dropped.join(", ")}` : ""}.\n${summary}`,
        recorded: true,
      };
    },
  };
}
