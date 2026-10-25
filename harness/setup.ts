import { CHANGE_KINDS, type ChangeKind, type ChatEntry } from "./entries.ts";

/**
 * An agent's state, as folded from the `agent_setup` entries on its branch (docs/providers.md, P8). Agents are
 * branches: a fork inherits the folded state without writing anything, a subagent (fresh context) starts from
 * nothing and writes its own complete first `agent_setup`.
 */

export type AgentSetupEntry = Extract<ChatEntry, { $tag: "agent_setup" }>;
export type PinnedDefinition = NonNullable<AgentSetupEntry["instructions"]>;
export type ModelSetup = NonNullable<AgentSetupEntry["model"]>;

/** The fields of an `agent_setup` entry that describe state; what a mutation changes. */
export type SetupChange = Pick<AgentSetupEntry, "model" | "tools" | "instructions" | "skills" | "mcp" | "pricing">;

export interface AgentSetup {
  model?: ModelSetup;
  tools: Record<string, PinnedDefinition>;
  instructions?: PinnedDefinition;
  skills: Record<string, PinnedDefinition>;
  mcp: Record<string, PinnedDefinition>;
  pricing?: { table: string };
  /** Provider-observed changes (`reason: provider`) no later entry has acknowledged. */
  unacknowledged: { id: string; changes: ChangeKind[] }[];
}

export const emptySetup = (): AgentSetup => ({ tools: {}, skills: {}, mcp: {}, unacknowledged: [] });

/** The model id requests should carry: the dated model once the provider has reported it, else what was asked for. */
export const servedModelId = (m: ModelSetup): string => m.resolved ?? m.id;

/** A change the harness or an adapter says a setup mutation would make. */
export interface Change {
  kind: ChangeKind;
  message: string;
  /** Extra cost per request the change is expected to cause, in USD, where the adapter can say. */
  estimatedCost?: number;
}

/** Why a setup mutation (or the next request) was refused: the changes it would make that were not allowed. */
export class ChangeNotAllowed extends Error {
  override name = "ChangeNotAllowed";
  readonly changes: readonly Change[];
  /** The flags that would permit it. */
  readonly allowWith: readonly ChangeKind[];
  constructor(changes: readonly Change[], prefix = "change not allowed") {
    const kinds = [...new Set(changes.map((c) => c.kind))];
    super(`${prefix}: ${changes.map((c) => `${c.kind} (${c.message})`).join("; ")}; allow with: ${kinds.join(", ")}`);
    this.changes = changes;
    this.allowWith = kinds;
  }
}

/** Adapter hook: classify what moving from one setup to another does, beyond what the harness can tell by itself. */
export type Classifier = (from: AgentSetup, to: AgentSetup, ctx: ClassifyContext) => readonly Change[];
export interface ClassifyContext {
  /** The conversation is inside a tool loop: the last assistant entry has tool calls without results. */
  midLoop: boolean;
}

/** Index of the first entry this agent's flow can see: the last fresh `branch_start`, as in `contextEntries`. */
function flowStart(entries: readonly ChatEntry[]): number {
  let start = 0;
  entries.forEach((e, i) => {
    if (e.$tag === "branch_start" && e.context === "fresh") start = i;
  });
  return start;
}

type Defs = Record<string, PinnedDefinition>;
const applyDefs = (base: Defs, delta: { set?: Defs | undefined; remove?: string[] | undefined } | undefined): Defs => {
  if (delta === undefined) return base;
  const out = { ...base };
  for (const name of delta.remove ?? []) delete out[name];
  for (const [name, def] of Object.entries(delta.set ?? {})) out[name] = def;
  return out;
};

/** The setup after a change. Pure. */
export function applyChange(base: AgentSetup, change: SetupChange): AgentSetup {
  return {
    ...base,
    ...(change.model === undefined ? {} : { model: change.model }),
    tools: applyDefs(base.tools, change.tools),
    ...(change.instructions === undefined ? {} : { instructions: change.instructions }),
    skills: applyDefs(base.skills, change.skills),
    mcp: applyDefs(base.mcp, change.mcp),
    ...(change.pricing === undefined ? {} : { pricing: change.pricing }),
  };
}

/** The setup an agent has after the given entries (its whole branch transcript). */
export function foldSetup(entries: readonly ChatEntry[]): AgentSetup {
  let s = emptySetup();
  for (const e of entries.slice(flowStart(entries))) {
    if (e.$tag !== "agent_setup") continue;
    const next = applyChange(s, e);
    const pending = s.unacknowledged.filter((u) => !(e.acknowledges ?? []).includes(u.id));
    if (e.reason === "provider") pending.push({ id: e.id, changes: e.changes ?? [] });
    s = { ...next, unacknowledged: pending };
  }
  return s;
}

/** Whether the last assistant entry made tool calls that have no result yet. */
export function inToolLoop(entries: readonly ChatEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as ChatEntry;
    if (e.$tag === "branch_start" && e.context === "fresh") return false;
    if (e.$tag !== "assistant") continue;
    const answered = new Set<string>();
    for (const later of entries.slice(i + 1)) if (later.$tag === "tool_result") answered.add(later.call_id);
    return e.blocks.some((b) => b.$tag === "tool_call" && !answered.has(b.call_id));
  }
  return false;
}

/** Stable text of a JSON-like value (sorted keys), for comparing settings. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const sameDefs = (a: Defs, b: Defs): boolean => stable(a) === stable(b);

/** Whether two setups describe the same agent (acknowledgements are not part of that). */
export function sameSetup(a: AgentSetup, b: AgentSetup): boolean {
  return (
    stable(a.model ?? null) === stable(b.model ?? null) &&
    sameDefs(a.tools, b.tools) &&
    stable(a.instructions ?? null) === stable(b.instructions ?? null) &&
    sameDefs(a.skills, b.skills) &&
    sameDefs(a.mcp, b.mcp) &&
    stable(a.pricing ?? null) === stable(b.pricing ?? null)
  );
}

/**
 * What the harness can tell about a change without knowing any provider: which model, which definitions,
 * which price table. Cache, cost and capability effects are the adapter's to add (`Classifier`). Starting from
 * a setup with no model is the agent's first setup and changes nothing.
 */
export function coreClassify(from: AgentSetup, to: AgentSetup, ctx: ClassifyContext): Change[] {
  if (from.model === undefined) return [];
  const out: Change[] = [];
  const fm = from.model;
  const tm = to.model ?? fm;
  if (fm.provider !== tm.provider) out.push({ kind: "provider_changed", message: `${fm.provider} to ${tm.provider}` });
  else if (fm.id !== tm.id) out.push({ kind: "model_changed", message: `${fm.id} to ${tm.id}` });
  else if (fm.resolved !== undefined && tm.resolved !== undefined && fm.resolved !== tm.resolved) {
    out.push({ kind: "resolved_model_changed", message: `served model ${fm.resolved} became ${tm.resolved}` });
  }
  if (!sameDefs(from.tools, to.tools)) out.push({ kind: "tools_changed", message: "the tool definitions differ" });
  if (!sameDefs(from.skills, to.skills) || !sameDefs(from.mcp, to.mcp)) out.push({ kind: "tools_changed", message: "skills or MCP servers differ" });
  if (stable(from.instructions ?? null) !== stable(to.instructions ?? null)) out.push({ kind: "instructions_changed", message: "the instructions differ" });
  if (from.pricing !== undefined && stable(from.pricing) !== stable(to.pricing ?? null)) out.push({ kind: "pricing_changed", message: "the price table differs" });
  if (ctx.midLoop && (out.length > 0 || stable(fm.settings ?? null) !== stable(tm.settings ?? null))) {
    out.push({ kind: "mid_loop", message: "the agent is in the middle of a tool loop" });
  }
  return out;
}

/** Drop what a change would not alter (settings already in force, definitions already pinned), so entries hold real deltas only. */
export function minimizeChange(base: AgentSetup, change: SetupChange): SetupChange {
  const out: SetupChange = {};
  if (change.model !== undefined && stable(change.model) !== stable(base.model ?? null)) out.model = change.model;
  for (const key of ["tools", "skills", "mcp"] as const) {
    const delta = change[key];
    if (delta === undefined) continue;
    const set = Object.fromEntries(Object.entries(delta.set ?? {}).filter(([n, d]) => stable(base[key][n] ?? null) !== stable(d)));
    const remove = (delta.remove ?? []).filter((n) => n in base[key]);
    if (Object.keys(set).length > 0 || remove.length > 0) out[key] = { ...(Object.keys(set).length > 0 ? { set } : {}), ...(remove.length > 0 ? { remove } : {}) };
  }
  if (change.instructions !== undefined && stable(change.instructions) !== stable(base.instructions ?? null)) out.instructions = change.instructions;
  if (change.pricing !== undefined && stable(change.pricing) !== stable(base.pricing ?? null)) out.pricing = change.pricing;
  return out;
}

export { CHANGE_KINDS };
export type { ChangeKind };
