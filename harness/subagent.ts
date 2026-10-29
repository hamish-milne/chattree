import type { Conversation } from "./conversation.ts";
import { ALL } from "./approvals.ts";
import { syncTools, type Approval, type ApprovalRequest, type LoopEvent, type LoopOptions } from "./loop.ts";
import type { Run, ThreadRuns } from "./runs.ts";
import { ToolRegistry, type StartedJob, type Tool, type ToolOutput } from "./tools.ts";

/**
 * The `subagent` tool (docs/tools.md, section 4.2). It hands a self-contained task to a fresh-context child on its own branch and
 * worktree and runs the child's loop as a run of the run manager. The child ends its work by calling its `merge` tool with a report: that
 * ends its loop without another request, the tool merges the child's branch into the caller's (the trunk wins) and the merge entry answers
 * the call. Because the end is a call and not the end of a turn, the user can stop the child, talk to it and let it carry on, and the call
 * stays open until the child reports (or the run is closed).
 *
 * Recoverable: the child's branch is named from the call id, so a call that was running when the process died is run again by the loop
 * (`resumable`) and finds its branch: one that is merged already is returned, one that is not is carried on.
 */
export interface SubagentDeps {
  /** The thread that makes the calls. */
  convo: Conversation;
  /** The tools the child works with (its `merge` tool is added). */
  childRegistry: ToolRegistry;
  runs: ThreadRuns;
  /** How the child's loop is run: system prompt, approvals (labelled by `name`), owner and so on. The tool sets the rest. */
  loopOptions(child: Conversation, name: string): Omit<LoopOptions, "registry" | "signal" | "jobs">;
  /** `review`: the user is asked before the child's `merge` runs (the report is in the question). Default `auto`. */
  merge?: "auto" | "review";
  /** Every event of the child's loop, for a host that shows what the child does. */
  onEvent?(name: string, event: LoopEvent): void;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/;

/** A short stable hash of the call id: the same call always finds the same branch. */
export function callHash(callId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < callId.length; i++) {
    h ^= callId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(-6);
}

export const subagentBranch = (label: string | undefined, callId: string): string => `sub/${label ?? "task"}-${callHash(callId)}`;

/** Added to every brief, so the child knows how its work is handed back. */
export const HAND_BACK = "When your task is done, call the merge tool with a summary of what you did and found. That is how your work is handed back; do not end with a plain reply.";

export const NUDGE =
  "You stopped without reporting. When your task is done, call the merge tool with a summary of what you did and found: that is how your work is handed back. Replying with text does not end the task.";

/** What a child's `merge` tool takes and what it does: nothing but carry the report, the caller does the merging. */
function reportTool(report: { summary?: string }): Tool {
  return {
    definition: {
      name: "merge",
      description:
        "Hand your work back. Call this when your task is done (or cannot be done), instead of replying with text: `summary` is what the one who gave you the task will read, so say what you did, what you found and what to do next. Your file changes are merged into theirs.",
      input_schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", description: "Your report: what you did, what you found, anything left." } } },
    },
    execute: (args) => {
      const summary = (args["summary"] as string).trim();
      if (summary === "") return Promise.resolve({ content: "summary must not be empty: say what you did and found", is_error: true });
      report.summary = summary;
      return Promise.resolve({ content: "Handed back. Your work is finished.", finish: true });
    },
  };
}

type Driven = { ok: true; summary: string; child: Conversation; run: Run } | { ok: false; content: string };

export function subagentTool(deps: SubagentDeps): Tool {
  const review = deps.merge === "review";

  const drive = async (brief: string, label: string | undefined, callId: string, signal: AbortSignal): Promise<Driven> => {
    const name = subagentBranch(label, callId);
    const branches = await deps.convo.listBranches();
    let child: Conversation;
    if (branches.some((b) => b.name === name)) {
      child = await deps.convo.openBranch(name);
      // A crash between making the branch and giving it its setup leaves it without a model.
      if ((await child.setup()).model === undefined) await deps.convo.copySetupTo(child, "subagent");
    } else {
      const spawned = await deps.convo.spawnSubagent({ brief: `${brief}\n\n${HAND_BACK}`, callId, name });
      if (spawned.conversation === undefined) return { ok: false, content: "the subagent's workspace could not be created" };
      child = spawned.conversation;
      await deps.convo.copySetupTo(child, "subagent");
    }
    const report: { summary?: string } = {};
    const registry = new ToolRegistry([...deps.childRegistry.names().map((n) => deps.childRegistry.get(n) as Tool), reportTool(report)]);
    await syncTools(child, registry);
    const base = deps.loopOptions(child, name);
    const inner = base.approve;
    // In `auto` mode handing the work back needs no question; everything else asks as the host decides, and without a host it is declined.
    const approve = (req: ApprovalRequest): Promise<Approval> => (req.name === "merge" && !review ? Promise.resolve({ allow: true }) : inner === undefined ? Promise.resolve({ allow: false }) : inner(req));
    const opts = { grants: child.grantStore(), ...base, approve, registry };
    const existing = deps.runs.get(name);
    const run = existing ?? deps.runs.start(child, opts, { kind: "subagent", label: name });
    if (deps.onEvent !== undefined) run.subscribe((e) => deps.onEvent?.(name, e), { replay: true });
    const stop = (): void => run.close();
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      let nudged = false;
      let first = true;
      for (;;) {
        const end = await run.cycleEnd({ next: !first });
        first = false;
        if (end === undefined) return { ok: false, content: `The subagent was stopped before it finished, so nothing was merged. Its work so far is on branch ${name}.` };
        if ("error" in end) {
          run.close();
          return { ok: false, content: `The subagent stopped with an error and nothing was merged: ${end.error instanceof Error ? end.error.message : (end.error instanceof Error ? end.error.stack : String(end.error))}. Its work is on branch ${name}.` };
        }
        const result = end.result as NonNullable<typeof end.result>;
        const status = result.status;
        if (status === "finished" && report.summary !== undefined) return { ok: true, summary: report.summary, child, run };
        // Has the user spoken in the child's branch? Only the entries since its own start count (the history before it is the parent's).
        const own = (await child.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
        const start = own.findLastIndex((e) => e.$tag === "branch_start" && e.context === "fresh");
        const nudgeText = (e: (typeof own)[number]): boolean => e.$tag === "user" && JSON.stringify(e.content).includes(NUDGE.slice(0, 40));
        const spoke = own.slice(start + 1).some((e) => e.$tag === "user" && !nudgeText(e));
        const interrupted = status === "stopped" || status === "cancelled" || (status === "interrupted" && result.last?.status === "interrupted" && result.last.by === "user");
        if (status === "completed" && !spoke && !interrupted) {
          if (nudged) {
            run.close();
            return { ok: false, content: `The subagent ended without handing its work back, so nothing was merged. Its work is on branch ${name}.` };
          }
          nudged = true;
          await child.append({ $tag: "user", content: [{ $tag: "text", text: NUDGE }] });
          run.resume();
          continue;
        }
        if (!spoke && !interrupted) {
          run.close();
          return { ok: false, content: `The subagent did not finish (${status}), so nothing was merged. Its work so far is on branch ${name}.` };
        }
        // The user stopped it or has been talking to it: the call stays open until it hands its work back or the run is closed.
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };

  const merged = async (d: Extract<Driven, { ok: true }>, callId: string): Promise<string> => {
    const outcome = await deps.convo.finishSubagent(d.child, { summary: d.summary, callId });
    d.run.close();
    const dropped = outcome.report.discarded;
    return `Subagent ${d.child.branch} finished. ${outcome.report.changed.length + outcome.report.added.length} file(s) merged${dropped.length > 0 ? `; kept your version of ${dropped.join(", ")}` : ""}.\n${d.summary}`;
  };

  return {
    resumable: true,
    background: true,
    definition: {
      name: "subagent",
      description:
        "Hand a self-contained task to a subagent: a fresh assistant that has the file tools but none of this conversation, works on its own copy of the workspace, and reports back. Its file changes are merged into yours when it finishes (where both changed the same file, yours is kept). Put everything it needs in `brief`: it knows nothing else. Good for work that is large, or independent of what you are doing, or that would fill this conversation with detail you do not need. The call returns the subagent's report and the files that changed. With `background: true` it returns at once and you are told when the subagent is done.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["brief"],
        properties: {
          brief: { type: "string", description: "The task, complete in itself: the goal, the files and constraints that matter, and what to report back." },
          name: { type: "string", description: "A short label for the subagent's branch (letters, digits, - and _). Optional." },
          background: { type: "boolean", description: "Return at once and carry on while the subagent works; you are told when it is done. Default false." },
        },
      },
    },
    allowKeys: () => [ALL],
    execute: async (args, ctx): Promise<ToolOutput | StartedJob> => {
      const brief = args["brief"] as string;
      const label = args["name"] as string | undefined;
      if (label !== undefined && !SAFE_NAME.test(label)) return { content: "name must be letters, digits, - and _ (at most 31 characters)", is_error: true };
      if (args["background"] !== true) {
        const d = await drive(brief, label, ctx.callId, ctx.signal);
        if (!d.ok) return { content: d.content, is_error: true };
        return { content: await merged(d, ctx.callId), recorded: true };
      }
      // A background subagent is not tied to the turn that started it: its own abort controller, stopped by the job's stop.
      const ac = new AbortController();
      let driven: Driven | undefined;
      const done = drive(brief, label, ctx.callId, ac.signal).then((d): ToolOutput => {
        driven = d;
        return d.ok ? { content: d.summary } : { content: d.content, is_error: true };
      });
      return {
        started: {
          summary: `subagent ${subagentBranch(label, ctx.callId)}`,
          done,
          stop: () => ac.abort(),
          // At the moment the job's event would be committed, merge and let that entry report the job.
          settle: async () => {
            if (driven === undefined || !driven.ok) return;
            await merged(driven, ctx.callId);
            return { recorded: true };
          },
        },
      };
    },
  };
}
