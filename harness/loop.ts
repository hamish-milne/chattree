import type { Conversation } from "./conversation.ts";
import type { ChatEntry } from "./entries.ts";
import { hashDefinition } from "./definitions.ts";
import { DEFAULT_RESULT_LIMIT, ToolRegistry, isStarted, shapeResult, type Tool, type ToolOutput } from "./tools.ts";
import { requestStream, type TurnOptions, type TurnResult } from "./turn.ts";
import type { StreamEvent } from "../providers/types.ts";
import type { Block } from "./context-builder.ts";
import type { ToolConvention } from "../providers/registry.ts";
import { servedModelId, type ModelSetup } from "./setup.ts";
import { flatProblems } from "./tool-schema.ts";
import type { JobRegistry, JobStatus } from "./jobs.ts";
import { keyProblem, permitted, untilAfter, type AllowMap } from "./approvals.ts";

/**
 * The tool loop (docs/tools.md, section 3): ask the model, run what it asked for, write the results, ask again, until
 * it answers without asking for a tool. Provider-neutral: it only sees `stop_reason: tool_use` and `tool_call` blocks.
 *
 * Every result is its own entry, committed as soon as its call finishes (an entry's commit also takes whatever the
 * tool changed in the workspace), so a crash after the second of three calls leaves two results and one unanswered call,
 * which the context builder already answers with a "did not run" error. The loop never re-runs a call that may have
 * half-finished: calls left unanswered by an earlier loop are answered "did not run" before the first request.
 */

export interface ApprovalRequest {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  tool: Tool;
  /**
   * What a grant would add to the tool's `allow` map (`Tool.allowKeys`), so the host can offer "allow all of these for
   * 5 minutes / 1 hour / forever". `null`: the call can only be allowed once, and the host should offer nothing longer.
   */
  keys: string[] | null;
}

/** A grant the user chose along with "yes": the request's keys, for `seconds` (`Infinity` is forever). */
export interface GrantChoice {
  seconds: number;
  /** Commit the change to harness.yml on its own. Default: only a forever grant. Otherwise it rides with the next commit. */
  commit?: boolean;
}

export type Approval = { allow: true; grant?: GrantChoice } | { allow: false; reason?: string };

/** Where grants live: the tool's `allow` map in harness.yml (`Conversation.grantStore`). */
export interface GrantStore {
  /** The tool's map as the file has it now, read fresh for each call so hand edits and `/tools` take effect at once. */
  allow(tool: string): Promise<AllowMap | undefined>;
  /** Add keys to the tool's map until `until`. */
  grant(tool: string, keys: readonly string[], until: string, opts: { commit: boolean }): Promise<void>;
}

export interface LoopOptions extends TurnOptions {
  registry: ToolRegistry;
  /**
   * Asked before a call that no live grant covers. Without `grants`: asked before every call, and with no `approve`
   * either, every call is allowed (the caller has auto-approved).
   */
  approve?: (request: ApprovalRequest) => Promise<Approval>;
  /**
   * Approvals the user has already given (docs/tools.md, section 5). When set, a call runs unasked only if a live key
   * covers it; otherwise `approve` is asked, and without `approve` the call is declined, never run.
   */
  grants?: GrantStore;
  /**
   * Where background jobs live. With it, a tool called with `background: true` starts a job; the loop commits the events of jobs
   * that ended before each request, and marks jobs lost in an earlier process. Without it such a call is refused.
   */
  jobs?: JobRegistry;
  /** The most bytes of a result the model is shown; the rest is kept as a blob. Default 30,000. */
  resultLimit?: number;
}

export type LoopEvent =
  | { type: "request.start"; n: number }
  /** A background job's event was committed; the next request shows it to the model. */
  | { type: "job.event"; job: string; status: JobStatus; summary: string }
  | { type: "stream"; event: StreamEvent }
  | { type: "request.end"; n: number; result: TurnResult }
  | { type: "tool.start"; callId: string; name: string; args: Record<string, unknown> }
  /** The answer to the approval question, when it was asked. */
  | { type: "tool.approval"; callId: string; name: string; allowed: boolean; reason?: string; via?: "allowlist" | "asked" | "headless"; keys?: string[]; granted?: { keys: string[]; until: string }; grantError?: string }
  /** `content` is what was recorded; `skipped` says why a call that did not run got an error result instead. */
  | { type: "tool.result"; callId: string; name: string; content: string; is_error: boolean; truncated: boolean; ms: number; skipped?: string };

export type LoopResult = {
  /**
   * `completed`: the model answered without asking for a tool (`last.completed.stop_reason` says how it ended).
   * `interrupted` / `cancelled`: the request was cut off or stopped (see `last`).
   * `stopped`: the user aborted while tools were running. `deadline`: the turn's time limit passed between or during calls.
   */
  status: "completed" | "interrupted" | "cancelled" | "stopped" | "deadline";
  /** Requests made by this run. */
  requests: number;
  last?: TurnResult;
};

export class ToolsOutOfSync extends Error {
  override name = "ToolsOutOfSync";
  readonly missing: string[];
  readonly changed: string[];
  readonly extra: string[];
  constructor(d: { missing: string[]; changed: string[]; extra: string[] }) {
    const parts = [
      d.missing.length > 0 ? `not yet pinned to the agent: ${d.missing.join(", ")}` : "",
      d.changed.length > 0 ? `definition changed: ${d.changed.join(", ")}` : "",
      d.extra.length > 0 ? `pinned but not registered: ${d.extra.join(", ")}` : "",
    ].filter((p) => p !== "");
    super(`the agent's tools do not match the host's (${parts.join("; ")}); syncTools pins the host's tools`);
    this.missing = d.missing;
    this.changed = d.changed;
    this.extra = d.extra;
  }
}

/** A tool the model's calling convention cannot show properly (docs/tools.md, 3.7). */
export class ToolsNotSupported extends Error {
  override name = "ToolsNotSupported";
  readonly convention: ToolConvention;
  readonly tools: { name: string; why: string[] }[];
  constructor(convention: ToolConvention, tools: { name: string; why: string[] }[]) {
    super(`the model's tool convention is ${convention}, which cannot show: ${tools.map((t) => `${t.name} (${t.why.join(", ")})`).join("; ")}; give these tools flat arguments, remove them, or set tool_convention for this model`);
    this.convention = convention;
    this.tools = tools;
  }
}

/** The tools in the registry that the agent's model cannot be given (none unless its convention is `flat`). */
export function toolConventionProblems(convo: Conversation, registry: ToolRegistry, model: ModelSetup | undefined): { convention: ToolConvention; tools: { name: string; why: string[] }[] } {
  const info = model === undefined ? undefined : convo.modelInfo(model.provider, servedModelId(model));
  const convention = info?.tool_convention ?? "full";
  if (convention === "full") return { convention, tools: [] };
  return { convention, tools: registry.definitions().flatMap((d) => { const why = flatProblems(d.input_schema); return why.length > 0 ? [{ name: d.name, why }] : []; }) };
}

/** How the agent's pinned tools differ from the registry. */
export async function toolDrift(convo: Conversation, registry: ToolRegistry): Promise<{ missing: string[]; changed: string[]; extra: string[] }> {
  const pinned = (await convo.setup()).tools;
  const missing: string[] = [];
  const changed: string[] = [];
  for (const def of registry.definitions()) {
    const pin = pinned[def.name];
    if (pin === undefined) missing.push(def.name);
    else if (pin.hash !== (await hashDefinition("tool", def))) changed.push(def.name);
  }
  return { missing, changed, extra: Object.keys(pinned).filter((n) => registry.get(n) === undefined).sort() };
}

/** Make the agent's pinned tools exactly the registry's (a `tools_changed` setup entry, only when something differs). */
export async function syncTools(convo: Conversation, registry: ToolRegistry) {
  const d = await toolDrift(convo, registry);
  if (d.missing.length + d.changed.length + d.extra.length === 0) return undefined;
  const pins = await registry.pin(convo.store);
  return convo.setupChange({ tools: { set: pins, remove: d.extra } }, { allow: ["tools_changed"] });
}

const DID_NOT_RUN = {
  stopped: "The tool did not run: the user stopped the turn first.",
  deadline: "The tool did not run: the turn's time limit passed first.",
  stale: "The tool did not run: the conversation was interrupted before it started.",
} as const;

/** Calls of the last assistant entry that nothing answered, unless a user message has come since (the context builder covers that case). */
function unanswered(entries: readonly ChatEntry[]): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as ChatEntry;
    if (e.$tag === "branch_start" && e.context === "fresh") return [];
    if (e.$tag === "user" || e.$tag === "interrupted" || e.$tag === "compaction") return [];
    if (e.$tag !== "assistant") continue;
    const answered = new Set<string>();
    for (const later of entries.slice(i + 1)) {
      if (later.$tag === "tool_result" || later.$tag === "subagent_result") answered.add(later.call_id);
      else if (later.$tag === "fork_merge" && later.call_id !== undefined) answered.add(later.call_id);
    }
    return e.blocks.flatMap((b) => (b.$tag === "tool_call" && !answered.has(b.call_id) ? [b.call_id] : []));
  }
  return [];
}

type CallBlock = Extract<Block, { type: "tool_call" }>;

/**
 * Run the loop for the thread as it stands: the last entry is a user message (or a tool result, for `/retry` after a
 * limit or a crash). Library refusals (`LimitExceeded`, `ChangeNotAllowed`) are thrown from here, between calls, so the
 * transcript is always valid when they are; asking again after fixing them continues the same turn.
 */
export async function* runLoop(convo: Conversation, opts: LoopOptions): AsyncGenerator<LoopEvent, LoopResult, void> {
  opts.jobs?.enterLoop();
  try {
    return yield* loopBody(convo, opts);
  } finally {
    opts.jobs?.leaveLoop();
  }
}

async function* loopBody(convo: Conversation, opts: LoopOptions): AsyncGenerator<LoopEvent, LoopResult, void> {
  const { registry } = opts;
  const drift = await toolDrift(convo, registry);
  if (drift.missing.length + drift.changed.length + drift.extra.length > 0) throw new ToolsOutOfSync(drift);
  const unsupported = toolConventionProblems(convo, registry, (await convo.setup()).model);
  if (unsupported.tools.length > 0) throw new ToolsNotSupported(unsupported.convention, unsupported.tools);

  const now = convo.now;
  const approvalCtx = { workspace: convo.dir, host: convo.host };
  let deadline = opts.deadline;
  if (deadline === undefined) {
    const config = await convo.readConfig();
    const secs = config?.ok === true ? config.value.limits.max_turn_seconds : undefined;
    if (secs !== undefined) deadline = now() + secs * 1000;
  }
  const stopReason = (): "stopped" | "deadline" | undefined => (opts.signal?.aborted === true ? "stopped" : deadline !== undefined && now() >= deadline ? "deadline" : undefined);

  const record = async function* (call: { call_id: string; name: string }, out: ToolOutput, t0: number, skipped?: string): AsyncGenerator<LoopEvent, void, void> {
    if (out.recorded === true) {
      yield { type: "tool.result", callId: call.call_id, name: call.name, content: out.content, is_error: out.is_error === true, truncated: false, ms: now() - t0 };
      return;
    }
    let full: { $tag: "blob"; sha256: string; bytes: number; mime: string } | undefined;
    const shaped = await shapeResult(out, {
      ...(opts.resultLimit === undefined ? {} : { limit: opts.resultLimit }),
      keep: async (bytes) => {
        const sha256 = await convo.store.put(bytes);
        full = { $tag: "blob", sha256, bytes: bytes.length, mime: "text/plain" };
        return `blob:${sha256}`;
      },
    });
    await convo.append({ $tag: "tool_result", call_id: call.call_id, is_error: shaped.is_error, content: shaped.content, ...(shaped.truncated ? { truncated: true } : {}), ...(full === undefined ? {} : { full }) });
    yield { type: "tool.result", callId: call.call_id, name: call.name, content: shaped.content, is_error: shaped.is_error, truncated: shaped.truncated, ms: now() - t0, ...(skipped === undefined ? {} : { skipped }) };
  };

  if (opts.jobs !== undefined) for (const id of await opts.jobs.recover()) yield { type: "job.event", job: id, status: "lost", summary: `job ${id} was lost` };

  // Calls an earlier loop left unanswered are not run now; the model hears that they did not run.
  const entries = (await convo.readEntries()).flatMap((e) => (e.ok ? [e.value] : []));
  const names = new Map<string, string>();
  for (const e of entries) if (e.$tag === "assistant") for (const b of e.blocks) if (b.$tag === "tool_call") names.set(b.call_id, b.name);
  for (const id of unanswered(entries)) yield* record({ call_id: id, name: names.get(id) ?? "" }, { content: DID_NOT_RUN.stale, is_error: true }, now(), "stale");

  const turnOpts: TurnOptions = { ...opts, deadline: deadline as number };
  if (deadline === undefined) delete (turnOpts as { deadline?: number }).deadline;
  let requests = 0;
  for (;;) {
    if (opts.jobs !== undefined) for (const j of await opts.jobs.flush()) yield { type: "job.event", ...j };
    requests++;
    yield { type: "request.start", n: requests };
    const gen = requestStream(convo, turnOpts);
    let result: TurnResult;
    for (;;) {
      const n = await gen.next();
      if (n.done) {
        result = n.value;
        break;
      }
      yield { type: "stream", event: n.value };
    }
    yield { type: "request.end", n: requests, result };
    if (result.status !== "completed") return { status: result.status, requests, last: result };
    const calls = result.completed.blocks.filter((b): b is CallBlock => b.type === "tool_call");
    if (result.completed.stop_reason !== "tool_use" || calls.length === 0) return { status: "completed", requests, last: result };

    for (const [i, call] of calls.entries()) {
      const why = stopReason();
      if (why !== undefined) {
        for (const rest of calls.slice(i)) yield* record({ call_id: rest.call_id, name: rest.name }, { content: DID_NOT_RUN[why], is_error: true }, now(), why);
        return { status: why, requests, last: result };
      }
      const t0 = now();
      yield { type: "tool.start", callId: call.call_id, name: call.name, args: (call.args ?? {}) as Record<string, unknown> };
      const checked = registry.check(call);
      if ("error" in checked) {
        yield* record(call, { content: checked.error, is_error: true }, t0);
        continue;
      }
      const decline = async function* (reason: string | undefined, via: "asked" | "headless"): AsyncGenerator<LoopEvent, void, void> {
        yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: false, via, ...(reason === undefined ? {} : { reason }) };
        yield* record(call, { content: `The user declined to run this call${reason === undefined || reason === "" ? "." : `: ${reason}`}`, is_error: true }, t0);
      };
      let proceed = true;
      if (opts.grants !== undefined) {
        const hit = await permitted(checked.tool, checked.args, await opts.grants.allow(call.name), now(), approvalCtx);
        if (hit.permitted) yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: true, via: "allowlist", keys: hit.keys };
        else if (opts.approve === undefined) {
          proceed = false;
          yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: false, via: "headless" };
          yield* record(call, { content: "This call needs the user's approval and none is available here, so it did not run.", is_error: true }, t0);
        } else {
          const keys = (await checked.tool.allowKeys?.(checked.args, approvalCtx)) ?? null;
          const decision = await opts.approve({ callId: call.call_id, name: call.name, args: checked.args, tool: checked.tool, keys });
          if (!decision.allow) {
            proceed = false;
            yield* decline(decision.reason, "asked");
          } else {
            const ev: Extract<LoopEvent, { type: "tool.approval" }> = { type: "tool.approval", callId: call.call_id, name: call.name, allowed: true, via: "asked" };
            if (decision.grant !== undefined && keys !== null && keys.length > 0) {
              const bad = keys.map((k) => keyProblem(checked.tool, k)).find((p) => p !== undefined);
              const until = untilAfter(now(), decision.grant.seconds);
              try {
                if (bad !== undefined) throw new Error(bad);
                await opts.grants.grant(call.name, keys, until, { commit: decision.grant.commit ?? !Number.isFinite(decision.grant.seconds) });
                ev.granted = { keys, until };
              } catch (e) {
                ev.grantError = e instanceof Error ? e.message : String(e); // the user said yes: this call still runs, once
              }
            }
            yield ev;
          }
        }
      } else if (opts.approve !== undefined) {
        const decision = await opts.approve({ callId: call.call_id, name: call.name, args: checked.args, tool: checked.tool, keys: null });
        yield { type: "tool.approval", callId: call.call_id, name: call.name, allowed: decision.allow, ...(decision.allow || decision.reason === undefined ? {} : { reason: decision.reason }) };
        if (!decision.allow) {
          proceed = false;
          yield* record(call, { content: `The user declined to run this call${decision.reason === undefined || decision.reason === "" ? "." : `: ${decision.reason}`}`, is_error: true }, t0);
        }
      }
      if (!proceed) continue;
      const signals = [opts.signal, deadline === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadline - now()))].filter((s): s is AbortSignal => s !== undefined);
      const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);
      let out: ToolOutput;
      try {
        const res = await checked.tool.execute(checked.args, { signal, callId: call.call_id, workspace: convo.dir, host: convo.host, blobs: convo.store });
        if (!isStarted(res)) out = res;
        else if (opts.jobs === undefined) {
          res.started.stop();
          out = { content: "background jobs are not available here", is_error: true };
        } else {
          const id = await opts.jobs.start(call.call_id, res.started);
          out = { content: `started job ${id}: ${res.started.summary}. It keeps running; you will be told when it ends (jobs lists jobs, job_stop stops one).` };
        }
      } catch (e) {
        out = { content: `The tool failed: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
      yield* record(call, out, t0);
    }
    const after = stopReason();
    if (after !== undefined) return { status: after, requests, last: result };
  }
}
