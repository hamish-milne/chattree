import type { Conversation } from "../harness/conversation.ts";
import { JobRegistry, jobTools } from "../harness/jobs.ts";
import type { Approval, ApprovalRequest } from "../harness/loop.ts";
import { leafTools } from "../harness/starter/index.ts";
import { ToolRegistry } from "../harness/tools.ts";
import type { Io } from "./io.ts";
import { describeCall } from "./tool-lines.ts";

/** The tools a session offers its model and the jobs they start, built from `harness.yml` (`tools.env`, `tools.run.safe`, `background.resume`). */
export interface ToolSet {
  registry: ToolRegistry;
  jobs: JobRegistry;
}

export interface ToolSetHooks {
  /** A job's event was committed while nothing was running: tell the user. */
  onCommitted(events: { job: string; status: string; summary: string }[]): void;
  /** `background.resume` is on and an event was committed while idle: send a request. */
  onResume(): void;
  /** A request of this session is running. */
  busy(): boolean;
}

export async function buildToolSet(io: Io, convo: Conversation, hooks: ToolSetHooks): Promise<ToolSet> {
  const cfg = await convo.readConfig();
  const config = cfg?.ok === true ? cfg.value : undefined;
  const env = config?.tools.env ?? [];
  const jobs = new JobRegistry(convo, { resume: config?.background.resume === true, onCommitted: hooks.onCommitted, onResume: hooks.onResume, busy: hooks.busy });
  const safe = config?.tools["run"]?.safe ?? [];
  const registry = new ToolRegistry([...leafTools({ env: { allow: env, values: io.env }, safe }), ...jobTools(jobs)]);
  return { registry, jobs };
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
export function makeApprover(ask: (question: string, fallback?: string) => Promise<string>): (request: ApprovalRequest) => Promise<Approval> {
  return async (request) => {
    const menu = request.keys === null || request.keys.length === 0 ? "[y] yes, once  [n] no" : `[y] yes, once  [5] 5 minutes  [h] 1 hour  [f] forever  [n] no\n  (5, h and f allow: ${request.keys.join("; ")})`;
    const answer = await ask(`\nAllow this?\n  ${describeCall(request.name, request.args).replace(/\n/g, "\n  ")}\n  ${menu}\n>`, "n");
    const parsed = parseAnswer(answer, request);
    if (parsed !== "no") return parsed;
    const reason = (await ask("Why not? (sent to the model; Enter to skip)", "")).trim();
    return { allow: false, ...(reason === "" ? {} : { reason }) };
  };
}
