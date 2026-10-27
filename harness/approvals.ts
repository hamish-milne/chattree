import { editConfig, type ConfigResult } from "../src/config.ts";
import type { Document } from "yaml";
import { isMap, isScalar } from "yaml";
import { harnessConfig, type HarnessConfig } from "./config.ts";
import type { ApprovalContext, Tool } from "./tools.ts";

/**
 * Approvals (docs/tools.md, section 5). A tool's `allow` map in harness.yml says, key by key, until when a class of
 * calls needs no question. This module is the pure part: reading expiry, deciding whether a call is covered, and
 * editing the map in the file text. Asking the user and running the call is the loop's job (`loop.ts`).
 */

/** The key that covers every call of a tool. */
export const ALL = "all";
/** "Forever": a date no one will outlive; there is no special value. */
export const FOREVER = "2999-01-01";

/** A tool's grants as harness.yml holds them: key to expiry text. */
export type AllowMap = Readonly<Record<string, string>>;

/** Milliseconds since the epoch of an expiry (a date means 00:00 UTC), or undefined if it is not one. */
export function untilMs(until: string): number | undefined {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(until) ? `${until}T00:00:00Z` : until);
  return Number.isNaN(t) ? undefined : t;
}

/** The expiry text for a grant of `seconds` from `nowMs`; a non-finite duration is forever. */
export function untilAfter(nowMs: number, seconds: number): string {
  return Number.isFinite(seconds) ? new Date(nowMs + seconds * 1000).toISOString() : FOREVER;
}

/** The keys that have not yet expired. */
export function liveKeys(map: AllowMap | undefined, nowMs: number): string[] {
  if (map === undefined) return [];
  return Object.entries(map).flatMap(([k, u]) => {
    const t = untilMs(u);
    return t !== undefined && t > nowMs ? [k] : [];
  });
}

/** What a stored grant says about one call: the keys that cover it. */
export type Permit = { permitted: true; keys: string[] } | { permitted: false };

/** Is this call covered by live keys? `all` covers everything; the rest is the tool's to judge, jointly. */
export async function permitted(tool: Tool, args: Record<string, unknown>, map: AllowMap | undefined, nowMs: number, ctx: ApprovalContext): Promise<Permit> {
  const live = liveKeys(map, nowMs);
  if (live.includes(ALL)) return { permitted: true, keys: [ALL] };
  const others = live.filter((k) => k !== ALL);
  if (tool.covers === undefined || others.length === 0) return { permitted: false };
  const used = await tool.covers(others, args, ctx);
  return used === undefined ? { permitted: false } : { permitted: true, keys: used };
}

/** A key set is usable only if the tool accepts each key; `all` is always accepted. */
export function keyProblem(tool: Tool, key: string): string | undefined {
  if (key === ALL) return undefined;
  if (key.trim() === "") return "a key may not be empty";
  return tool.validateKey?.(key) ?? (tool.covers === undefined ? `${tool.definition.name} accepts only the key "${ALL}"` : undefined);
}

export type ApprovalsEdit = { ok: true; text: string; value: HarnessConfig } | { ok: false; message: string };

const fail = (r: Extract<ConfigResult<unknown>, { ok: false }>): ApprovalsEdit => ({ ok: false, message: r.issues.map((i) => `${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("; ") });

/** Remove every expired key from every tool's map (a tool whose map empties keeps its other settings). */
function prune(doc: Document.Parsed, nowMs: number): void {
  const tools = doc.get("tools", true);
  if (!isMap(tools)) return;
  for (const pair of tools.items) {
    const allow = isMap(pair.value) ? pair.value.get("allow", true) : undefined;
    if (!isMap(allow)) continue;
    allow.items = allow.items.filter((p) => {
      const t = isScalar(p.value) && typeof p.value.value === "string" ? untilMs(p.value.value) : undefined;
      return t === undefined || t > nowMs;
    });
  }
}

/**
 * Add grants for `tool` to the file text: each key lasts until `until` or its present expiry, whichever is later
 * (a short grant never shortens a longer one). Expired keys are dropped on the way. Comments and layout stay.
 */
export async function addGrants(text: string, tool: string, keys: readonly string[], until: string, nowMs: number): Promise<ApprovalsEdit> {
  const newT = untilMs(until);
  if (newT === undefined) return { ok: false, message: `${until} is not a date or a datetime with a zone` };
  const r = await editConfig(text, harnessConfig, (doc) => {
    prune(doc, nowMs);
    for (const key of keys) {
      const old = doc.getIn(["tools", tool, "allow", key]);
      const oldT = typeof old === "string" ? untilMs(old) : undefined;
      doc.setIn(["tools", tool, "allow", key], oldT !== undefined && oldT > newT ? old : until);
    }
  });
  return r.ok ? { ok: true, text: r.text, value: r.value } : fail(r);
}

/** Remove one key of a tool, or all of its keys when `key` is undefined. A key that is not there is not an error. */
export async function revokeGrants(text: string, tool: string, key: string | undefined, nowMs: number): Promise<ApprovalsEdit> {
  const r = await editConfig(text, harnessConfig, (doc) => {
    prune(doc, nowMs);
    if (key === undefined) doc.deleteIn(["tools", tool, "allow"]);
    else doc.deleteIn(["tools", tool, "allow", key]);
  });
  return r.ok ? { ok: true, text: r.text, value: r.value } : fail(r);
}
