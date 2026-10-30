import type { Conversation } from "./conversation.ts";
import { ALL, FOREVER } from "./approvals.ts";
import { syncTools, type GrantStore } from "./loop.ts";
import { ToolRegistry, type StartedJob, type Tool, type ToolOutput } from "./tools.ts";
import { toolConventionProblems } from "./loop.ts";
import { globRegex } from "./starter/run-keys.ts";
import { approvalKey, childModel, describeModels, modelProperties, type ChildModel, type SubagentModel } from "./subagent-models.ts";
import type { ModelSetup } from "./setup.ts";
import type { ChatEntry } from "./entries.ts";
import { inlineBlobs } from "./context-builder.ts";

/**
 * The `subagent` tool (docs/tools.md, section 4.2). It hands a self-contained task to a fresh-context child on its own branch and
 * worktree. The tool starts nothing: it makes the branch and, for a call that waits (the default), returns `waiting`, which ends the
 * caller's loop cleanly (a context switch: nothing is held while the child works). Whoever pumps threads (`pump.ts`) runs the child's loop,
 * asks its questions through the same queue as any thread's, and, when the child has handed back, runs the caller's loop again; the tool
 * is called again (`resumable`), finds the child done and merges it (the trunk wins), and the merge entry answers the call.
 *
 * The child ends its work by calling its `merge` tool with a report. That ends its loop without another request, and the report is read
 * back from the child's transcript, so nothing about a child is kept in memory: a host that dies and starts again finds the same state.
 * With `background: true` the call is answered at once (`started subagent <branch>`); the report arrives later as a `subagent_result`
 * entry that the pump (or the caller's next request) delivers.
 */
export interface SubagentDeps {
  /** The thread that makes the calls. */
  convo: Conversation;
  /** The tools the child works with (its `merge` tool is added: `subagentChildRegistry`). */
  childRegistry: ToolRegistry;
  /** `review`: the user is asked before the child's `merge` runs (the report is in the question). Default `auto`. */
  merge?: "auto" | "review";
  /** The models the parent may choose for a child (`subagent.models`, resolved). None: the child uses the parent's model and the tool has no `model` argument. */
  models?: readonly SubagentModel[];
  /** The adapter's own check of a model settings object for a provider: the problems, or none. Without it settings are not checked here. */
  validateSettings?(provider: string, settings: unknown): Promise<string[]>;
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

/** What a child's `merge` tool takes and what it does: nothing but end the child's loop; the report is read from the call. */
function reportTool(): Tool {
  return {
    definition: {
      name: "merge",
      description:
        "Hand your work back. Call this when your task is done (or cannot be done), instead of replying with text: `summary` is what the one who gave you the task will read, so say what you did, what you found and what to do next. Your file changes are merged into theirs.",
      input_schema: { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string", description: "Your report: what you did, what you found, anything left." } } },
    },
    allowKeys: () => null,
    execute: (args) => {
      const summary = (args["summary"] as string).trim();
      if (summary === "") return Promise.resolve({ content: "summary must not be empty: say what you did and found", is_error: true });
      return Promise.resolve({ content: "Handed back. Your work is finished.", finish: true });
    },
  };
}

/** The registry a child works with: the leaf tools it was given, and the `merge` tool that hands its work back. */
export function subagentChildRegistry(base: ToolRegistry): ToolRegistry {
  return new ToolRegistry([...base.names().map((n) => base.get(n) as Tool), reportTool()]);
}

/**
 * The child's grants as its loop sees them: those of `harness.yml`, and, unless the user is to review reports (`merge: review`), a standing
 * yes for handing back, which needs no question.
 */
export function subagentGrants(base: GrantStore, mode: "auto" | "review" | undefined): GrantStore {
  if (mode === "review") return base;
  return {
    allow: async (tool) => (tool === "merge" ? { all: FOREVER, ...((await base.allow(tool)) ?? {}) } : base.allow(tool)),
    grant: (...a) => base.grant(...a),
  };
}

const dec = new TextDecoder();

/** What a child's transcript says about its work: handed back (with the report), given up on, or still going (or waiting for someone). */
export type ChildState =
  | { state: "handed_back"; summary: string }
  | { state: "gave_up"; why: string }
  /** It stopped with text and nobody has spoken to it: it is told once to hand its work back. */
  | { state: "needs_nudge" }
  | { state: "working" };

export const NUDGE =
  "You stopped without reporting. When your task is done, call the merge tool with a summary of what you did and found: that is how your work is handed back. Replying with text does not end the task.";
const isNudge = (e: ChatEntry): boolean => e.$tag === "user" && JSON.stringify(e.content).includes(NUDGE.slice(0, 40));

/** Read a child's state from its entries (all of them: the history before its own start is the parent's and is skipped). */
export async function childState(child: Conversation, entries: readonly ChatEntry[]): Promise<ChildState> {
  const start = entries.findLastIndex((e) => e.$tag === "branch_start" && e.context === "fresh");
  const own = entries.slice(start + 1);
  // Handed back: the last assistant entry called merge and the call has a result that is not an error.
  for (let i = own.length - 1; i >= 0; i--) {
    const e = own[i] as ChatEntry;
    if (e.$tag !== "assistant") continue;
    const call = e.blocks.find((b) => b.$tag === "tool_call" && b.name === "merge");
    if (call?.$tag === "tool_call") {
      const result = own.slice(i + 1).find((x) => x.$tag === "tool_result" && x.call_id === call.call_id);
      if (result?.$tag === "tool_result" && !result.is_error) {
        const args = (await inlineBlobs(call.args, async (ref) => dec.decode((await child.store.get(ref.sha256)) ?? new Uint8Array()))) as { summary?: unknown };
        return { state: "handed_back", summary: typeof args.summary === "string" ? args.summary.trim() : "" };
      }
    }
    break;
  }
  const last = [...own].reverse().find((e) => e.$tag !== "agent_setup" && e.$tag !== "approval");
  const spoke = own.some((e) => e.$tag === "user" && !isNudge(e));
  if (last?.$tag === "interrupted") return last.by === "user" ? { state: "working" } : { state: "gave_up", why: `it stopped with an error${last.error === undefined ? "" : `: ${last.error}`}` };
  if (last?.$tag === "assistant" && !last.blocks.some((b) => b.$tag === "tool_call") && !spoke) {
    return own.some(isNudge) ? { state: "gave_up", why: "it ended without handing its work back" } : { state: "needs_nudge" };
  }
  return { state: "working" };
}

type ChildFound = { found: false } | ({ found: true; child: string } & ChildState);

/** Where a child stands, by its branch name: not made yet, or its state. */
async function lookChild(convo: Conversation, name: string): Promise<ChildFound> {
  if ((await convo.git.revParse(`refs/heads/${name}`)) === undefined) return { found: false };
  const entries = (await convo.readEntriesAt(`refs/heads/${name}`)).flatMap((e) => (e.ok ? [e.value] : []));
  const probe = await convo.openBranch(name).catch(() => undefined);
  if (probe === undefined) return { found: true, child: name, state: "working" };
  try {
    return { found: true, child: name, ...(await childState(probe, entries)) };
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** The call result that tells the caller a background child has started; delivery finds children by it. */
export const SUBAGENT_STARTED = /^started subagent (\S+)/;

/**
 * Deliver the reports of background subagents that have finished: for each `started subagent` call of this thread that no merge has
 * answered yet, a child that handed back is merged (a `subagent_result` entry, shown to the model as a message), and one that gave up is
 * reported as a failed `job_event`. Returns how many were delivered. Safe to call at any time the thread is between requests.
 */
export async function deliverSubagents(convo: Conversation, opts: { review?: boolean } = {}): Promise<number> {
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const done = new Set<string>();
  for (const e of entries) {
    if (e.$tag === "subagent_result") done.add(e.call_id);
    else if (e.$tag === "job_event") done.add(e.call_id);
  }
  let delivered = 0;
  for (const e of entries) {
    if (e.$tag !== "tool_result" || typeof e.content !== "string" || done.has(e.call_id)) continue;
    const m = SUBAGENT_STARTED.exec(e.content);
    if (m === null) continue;
    const name = (m[1] as string).replace(/[:.]$/, "");
    const st = await lookChild(convo, name);
    if (!st.found) continue;
    if (st.state === "handed_back") {
      await convo.finishSubagent(name, { summary: st.summary, callId: e.call_id });
      delivered++;
    } else if (st.state === "gave_up") {
      await convo.append({ $tag: "job_event", job: name, call_id: e.call_id, status: "failed", summary: `subagent ${name} ${st.why}, so nothing was merged. Its work is on branch ${name}.` });
      delivered++;
    }
  }
  void opts;
  return delivered;
}

export function subagentTool(deps: SubagentDeps): Tool {
  /** The child starts with the parent's setup, except for the model when the call chose one (and then its provider's prices are pinned). */
  const setupChild = async (child: Conversation, model: ModelSetup | undefined): Promise<void> => {
    await deps.convo.copySetupTo(child, "subagent", model === undefined ? {} : { model });
    if (model !== undefined && model.provider !== (await deps.convo.setup()).model?.provider) await child.pinPricing(model.provider);
  };

  /** Make the child's branch (or find the one an earlier execution of this call made) and pin its tools; false when the workspace could not be made. */
  const prepare = async (brief: string, name: string, callId: string, model: ModelSetup | undefined): Promise<boolean> => {
    const branches = await deps.convo.listBranches();
    let child: Conversation;
    if (branches.some((b) => b.name === name)) {
      child = await deps.convo.openBranch(name);
      // A crash between making the branch and giving it its setup leaves it without a model.
      if ((await child.setup()).model === undefined) await setupChild(child, model);
    } else {
      const spawned = await deps.convo.spawnSubagent({ brief: `${brief}\n\n${HAND_BACK}`, callId, name });
      if (spawned.conversation === undefined) return false;
      child = spawned.conversation;
      await setupChild(child, model);
    }
    try {
      await syncTools(child, subagentChildRegistry(deps.childRegistry));
    } finally {
      await child.close().catch(() => undefined);
    }
    return true;
  };

  const models = deps.models ?? [];

  /** What the call asks for, and the child's model setting that follows from it, checked against the parent and the adapter. */
  const choose = async (args: Record<string, unknown>): Promise<ChildModel> => {
    const parent = (await deps.convo.setup()).model;
    const info = parent === undefined ? undefined : deps.convo.modelInfo(parent.provider, parent.id);
    return childModel({ model: args["model"] as string | undefined, reasoning: args["reasoning"] as string | undefined }, models, parent, info);
  };

  return {
    resumable: true,
    background: true,
    // The call only makes the branch and either merges a finished child or says it waits: it does not last as long as the child's work.
    timeout: () => 120,
    definition: {
      name: "subagent",
      description:
        "Hand a self-contained task to a subagent: a fresh assistant that has the file tools but none of this conversation, works on its own copy of the workspace, and reports back. Its file changes are merged into yours when it finishes (where both changed the same file, yours is kept). Put everything it needs in `brief`: it knows nothing else. Good for work that is large, or independent of what you are doing, or that would fill this conversation with detail you do not need. The call returns the subagent's report and the files that changed. With `background: true` it returns at once and you are told when the subagent is done." + describeModels(models),
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["brief"],
        properties: {
          brief: { type: "string", description: "The task, complete in itself: the goal, the files and constraints that matter, and what to report back." },
          name: { type: "string", description: "A short label for the subagent's branch (letters, digits, - and _). Optional." },
          ...modelProperties(models),
          background: { type: "boolean", description: "Return at once and carry on while the subagent works; you are told when it is done. Default false." },
        },
      },
    },
    // Approvals: with no choice of model there is one question (all). With one, the key says which model at which level, `inherit` for the
    // parent's own, and a stored key may be a glob (`anthropic/claude-haiku-*@*`) so a cheap model can be allowed without a dear one.
    allowKeys: async (args) => {
      if (models.length === 0) return [ALL];
      const c = await choose(args);
      return c.ok ? [approvalKey(c)] : null;
    },
    covers: async (keys, args) => {
      if (models.length === 0) return undefined;
      const c = await choose(args);
      if (!c.ok) return undefined;
      const want = approvalKey(c);
      const hit = keys.find((k) => k === want || (want !== "inherit" && k !== "inherit" && globRegex(k).test(want)));
      return hit === undefined ? undefined : [hit];
    },
    validateKey: (key) => (key === "inherit" || /^[^\s@]+\/[^\s@]*@[^\s@]+$/.test(key) ? undefined : "write it as provider/model@level (globs allowed, for example anthropic/claude-haiku-*@*), or inherit"),
    waitingOn: async (args, callId) => {
      const name = subagentBranch(args["name"] as string | undefined, callId);
      if (args["background"] === true) return undefined;
      const st = await lookChild(deps.convo, name);
      return st.found && (st.state === "working" || st.state === "needs_nudge") ? name : undefined;
    },
    execute: async (args, ctx): Promise<ToolOutput | StartedJob> => {
      const brief = args["brief"] as string;
      const label = args["name"] as string | undefined;
      if (label !== undefined && !SAFE_NAME.test(label)) return { content: "name must be letters, digits, - and _ (at most 31 characters)", is_error: true };
      const choice = await choose(args);
      if (!choice.ok) return { content: choice.message, is_error: true };
      // Everything that can be refused is refused before the branch is made, so a bad choice leaves nothing behind.
      if (choice.model !== undefined) {
        const issues = (await deps.validateSettings?.(choice.model.provider, choice.model.settings)) ?? [];
        if (issues.length > 0) return { content: `the settings for ${choice.key} are not valid: ${issues.join("; ")}`, is_error: true };
        const unsupported = toolConventionProblems(deps.convo, deps.childRegistry, choice.model);
        if (unsupported.tools.length > 0) return { content: `${choice.key} cannot be given the subagent's tools (its tool convention is ${unsupported.convention}: ${unsupported.tools.map((t) => `${t.name}: ${t.why.join(", ")}`).join("; ")})`, is_error: true };
      }
      const name = subagentBranch(label, ctx.callId);
      if (!(await prepare(brief, name, ctx.callId, choice.model))) return { content: "the subagent's workspace could not be made", is_error: true };
      if (args["background"] === true) return { content: `started subagent ${name}. You will be told when it is done.` };
      const st = await lookChild(deps.convo, name);
      if (!st.found || st.state === "working" || st.state === "needs_nudge") {
        // The child is somebody else's turn now: this thread lets go, and runs again when the child has handed back.
        return { content: "", waiting: name };
      }
      if (st.state === "gave_up") return { content: `subagent ${name} ${st.why}, so nothing was merged. Its work is on branch ${name}.`, is_error: true };
      await deps.convo.finishSubagent(name, { summary: st.summary, callId: ctx.callId });
      return { content: st.summary, recorded: true };
    },
  };
}

/** For `PumpHooks.idle` on a subagent's thread: the message that tells a child that stopped without reporting to hand its work back (once). */
export async function subagentNudge(child: Conversation, entries: readonly ChatEntry[]): Promise<string | undefined> {
  const st = await childState(child, entries);
  return st.state === "needs_nudge" ? NUDGE : undefined;
}
