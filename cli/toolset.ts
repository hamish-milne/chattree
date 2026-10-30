import type { Conversation } from "../harness/conversation.ts";
import { localOwner } from "./owner.ts";
import { JobRegistry, jobTools } from "../harness/jobs.ts";
import type { Approval, ApprovalRequest, LoopEvent } from "../harness/loop.ts";
import { leafTools } from "../harness/starter/index.ts";
import { forkTool, mergeTool, type ForkDeps } from "../harness/fork-tools.ts";
import { ThreadRuns } from "../harness/runs.ts";
import { subagentTool } from "../harness/subagent.ts";
import { resolveSubagentModels } from "../harness/subagent-models.ts";
import { defaultRegistry } from "../providers/index.ts";
import { ToolRegistry } from "../harness/tools.ts";
import { BUSYBOX_HINT, BusyboxError, ensureBusybox } from "../hosts/busybox.ts";
import { findBusybox } from "../hosts/node.ts";
import type { AskFn, Choice } from "./engine.ts";
import { CliError, type Io } from "./io.ts";
import { describeCall } from "./tool-lines.ts";

/** The tools a session offers its model and the jobs they start, built from `harness.yml` (`tools.env`, `tools.run.safe`, `background.resume`). */
export interface ToolSet {
  registry: ToolRegistry;
  jobs: JobRegistry;
  /** The loops running for this thread's tools (subagents). */
  runs: ThreadRuns;
}

export interface ToolSetHooks {
  /** A job's event was committed while nothing was running: tell the user. */
  onCommitted(events: { job: string; status: string; summary: string }[]): void;
  /** `background.resume` is on and an event was committed while idle: send a request. */
  onResume(): void;
  /** A request of this session is running. */
  busy(): boolean;
  /** This session's id, named as the holder of the run lease a background job takes. */
  session?: string;
  /** How a subagent's loop is run: the system prompt, and approvals that name the subagent when they ask the user. */
  /** What a subagent's loop does, for showing the user. */
  onChildEvent?(name: string, event: LoopEvent): void;
  /** A fork of this thread, made where the project keeps worktrees. */
  createFork?: ForkDeps["createFork"];
  /** The first message the model gave a fork it made. */
  onForkDraft?: ForkDeps["onDraft"];
  childLoop?(name: string): { system: string; approve?: (request: ApprovalRequest) => Promise<Approval>; owner?: { pid?: number; session?: string } };
}

/**
 * The busybox.exe `run` uses on Windows, or undefined elsewhere. `tools.run.busybox` is `auto` (default: the one that is there, else
 * the pinned release is fetched), `off` (use one that is there, never fetch) or the path of a busybox.exe. Failing to get one is the
 * user's problem, not the model's, so it is a CliError raised before anything is sent.
 */
export async function resolveBusybox(io: Io, mode: string | undefined, ensure: typeof ensureBusybox = ensureBusybox): Promise<string | undefined> {
  if (io.host.platform !== "windows") return undefined;
  const how = mode ?? "auto";
  if (how === "off") return findBusybox(io.env);
  if (how !== "auto") {
    if ((await io.host.fs.stat(how))?.isFile !== true) throw new CliError(`tools.run.busybox is ${how}, which is not a file`, BUSYBOX_HINT);
    return how;
  }
  try {
    return await ensure({ env: io.env, say: (m) => io.err(`${m}\n`) });
  } catch (e) {
    if (e instanceof BusyboxError) throw new CliError(e.message, e.hint);
    throw e;
  }
}

/** The busybox.exe for this thread's configuration (fetched on first use when `tools.run.busybox` is auto), or undefined off Windows. */
export async function busyboxFor(io: Io, convo: Conversation): Promise<string | undefined> {
  const cfg = await convo.readConfig();
  return resolveBusybox(io, cfg?.ok === true ? cfg.value.tools["run"]?.busybox : undefined);
}

export async function buildToolSet(io: Io, convo: Conversation, hooks: ToolSetHooks): Promise<ToolSet> {
  const cfg = await convo.readConfig();
  const config = cfg?.ok === true ? cfg.value : undefined;
  const env = config?.tools.env ?? [];
  const jobs = new JobRegistry(convo, { owner: localOwner(hooks.session), resume: config?.background.resume === true, onCommitted: hooks.onCommitted, onResume: hooks.onResume, busy: hooks.busy });
  const safe = config?.tools["run"]?.safe ?? [];
  // Only tools listed under `tools` in harness.yml are offered; leaving one out turns it off.
  const listed = (name: string): boolean => config?.tools[name] !== undefined;
  const busybox = listed("run") || listed("script") ? await resolveBusybox(io, config?.tools["run"]?.busybox) : undefined;
  const runs = new ThreadRuns();
  const leaf = leafTools({ busybox, env: { allow: env, values: io.env }, safe, batch: config?.tools["run"]?.batch === true, batchLocal: config?.tools["run"]?.local ?? [], hostEnv: io.env });
  // A subagent works with the leaf tools the thread has, and cannot start subagents of its own.
  const childRegistry = new ToolRegistry(leaf.filter((t) => listed(t.definition.name)));
  // The models the parent may choose for a subagent. A list that names a provider harness.yml does not have is the user's to fix.
  const chosen = resolveSubagentModels(config?.subagent.models, new Set(Object.keys(config?.providers ?? {})), (p, id) => convo.modelInfo(p, id));
  if (chosen.problems.length > 0) throw new CliError(chosen.problems.join("\n"), "fix subagent.models in harness.yml, or remove it to give subagents the parent's model");
  const adapters = defaultRegistry();
  const validateSettings = async (provider: string, settings: unknown): Promise<string[]> => {
    const tag = (config?.providers[provider] as { $tag?: string } | undefined)?.$tag;
    const def = tag === undefined ? undefined : adapters.get(tag);
    if (def === undefined) return [`no adapter for provider ${provider}`];
    const r = await def.settings["~standard"].validate(settings);
    return r.issues === undefined ? [] : r.issues.map((i) => `${(i.path ?? []).map((q) => (typeof q === "object" ? q.key : q)).join(".") || "settings"}: ${i.message}`);
  };
  const meta = hooks.childLoop === undefined ? [] : [subagentTool({ convo, childRegistry, runs, models: chosen.models, validateSettings, merge: config?.subagent.merge ?? "auto", loopOptions: (_child, name) => (hooks.childLoop as NonNullable<ToolSetHooks["childLoop"]>)(name), ...(hooks.onChildEvent === undefined ? {} : { onEvent: hooks.onChildEvent }) })];
  const auto = hooks.childLoop === undefined ? undefined : { runs, childRegistry, loopOptions: (_c: Conversation, name: string) => (hooks.childLoop as NonNullable<ToolSetHooks["childLoop"]>)(name) };
  const forks = hooks.createFork === undefined ? [] : [forkTool({ convo, createFork: hooks.createFork, ...(auto === undefined ? {} : { auto }), ...(hooks.onForkDraft === undefined ? {} : { onDraft: hooks.onForkDraft }) }), mergeTool({ convo })];
  const all = [...leaf, ...jobTools(jobs), ...meta, ...forks];
  const registry = new ToolRegistry(all.filter((t) => listed(t.definition.name)));
  return { registry, jobs, runs };
}

/** The user's answer to "may this call run?", as a loop approval. */
export function parseAnswer(answer: string, request: ApprovalRequest): "no" | Approval {
  const c = answer.trim().toLowerCase()[0] ?? "n";
  if (c === "y") return { allow: true };
  const grant = request.keys !== null && request.keys.length > 0;
  if (grant && c === "5") return { allow: true, grant: { seconds: 300 } };
  if (grant && c === "h") return { allow: true, grant: { seconds: 3600 } };
  if (grant && c === "f") return { allow: true, grant: { seconds: Infinity } };
  return "no";
}

/** Ask the user about a call. `ask` is the terminal's question; without one nothing is asked and the call is declined. */
export function makeApprover(ask: AskFn, label?: string): (request: ApprovalRequest) => Promise<Approval> {
  return async (request) => {
    const grant = request.keys !== null && request.keys.length > 0;
    const choices: Choice[] = grant
      ? [{ key: "y", label: "yes, once" }, { key: "5", label: "yes, for 5 minutes" }, { key: "h", label: "yes, for 1 hour" }, { key: "f", label: "yes, forever" }, { key: "n", label: "no" }]
      : [{ key: "y", label: "yes, once" }, { key: "n", label: "no" }];
    const answer = await ask(`\nAllow this${label === undefined ? "" : ` (asked by subagent ${label})`}?\n  ${describeCall(request.name, request.args).replace(/\n/g, "\n  ")}${grant ? `\n  (5, h and f allow: ${(request.keys as string[]).join("; ")})` : ""}`, "n", choices);
    const parsed = parseAnswer(answer, request);
    if (parsed !== "no") return parsed;
    const reason = (await ask("Why not? (sent to the model; Enter to skip)", "")).trim();
    return { allow: false, ...(reason === "" ? {} : { reason }) };
  };
}
