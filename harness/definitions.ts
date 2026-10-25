import { sha256Hex, type BlobStore } from "../src/index.ts";
import { ChangeNotAllowed, stable, type AgentSetup, type Change, type PinnedDefinition } from "./setup.ts";
import type { ChangeKind } from "./entries.ts";

/**
 * Pinned definitions (docs/providers.md, P10): tools, instructions, skills and MCP servers are recorded in the
 * transcript as a name and the hash of their canonical form, never as the definition itself. Where the bytes
 * live is the host's choice per definition: copied into `blobs/` (`store: "blob"`), or only referenced
 * (`store: "external"`, e.g. a file in a shared submodule) and served by the host's `DefinitionSource`.
 * Either way the harness recomputes hashes at the start of a turn, so drift is always detected.
 */

/** The canonical, provider-independent form of a tool. Adapters translate it; its hash is what is pinned. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  input_schema: Record<string, unknown>;
  /** Behavioural flags that matter to the harness (read-only, needs approval, ...); part of the hash. */
  flags?: Record<string, unknown>;
}

export type DefinitionKind = "tool" | "instructions" | "skill" | "mcp";
export type DefinitionSection = "tools" | "instructions" | "skills" | "mcp";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

const KIND_OF: Record<DefinitionSection, DefinitionKind> = { tools: "tool", instructions: "instructions", skills: "skill", mcp: "mcp" };
export const INSTRUCTIONS_NAME = "instructions";

/** The bytes whose SHA-256 is the definition's hash: the text itself for instructions, sorted-key JSON for everything else. */
export function encodeDefinition(kind: DefinitionKind, value: unknown): Uint8Array {
  if (kind === "instructions") {
    if (typeof value !== "string") throw new DefinitionError("instructions are text");
    return enc.encode(value);
  }
  return enc.encode(stable(value));
}

export function decodeDefinition(kind: DefinitionKind, bytes: Uint8Array): unknown {
  const text = dec.decode(bytes);
  return kind === "instructions" ? text : JSON.parse(text);
}

export class DefinitionError extends Error {
  override name = "DefinitionError";
}

/** The hash a definition is pinned under. */
export async function hashDefinition(kind: DefinitionKind, value: unknown): Promise<string> {
  return sha256Hex(encodeDefinition(kind, value));
}

/**
 * Pin a definition: compute its hash and, for `blob`, put the canonical bytes in the store (the blob's hash is
 * the definition's hash, so the verifier can check it). The result goes into an `agent_setup` change.
 */
export async function pinDefinition(kind: DefinitionKind, value: unknown, where: { store: "blob"; blobs: BlobStore } | { store: "external"; ref: string }): Promise<PinnedDefinition> {
  const bytes = encodeDefinition(kind, value);
  if (where.store === "blob") {
    const hash = await where.blobs.put(bytes);
    return { hash, store: "blob" };
  }
  return { hash: await sha256Hex(bytes), store: "external", ref: where.ref };
}

/** The host's hook: what definitions exist and their bytes. Org-wide tooling in a submodule is the typical backing. */
export interface DefinitionSource {
  list(): Promise<{ kind: DefinitionKind; name: string; hash: string; ref?: string }[]>;
  /** The canonical bytes for exactly that hash, or undefined if the source does not have them. */
  get(kind: DefinitionKind, name: string, hash: string): Promise<Uint8Array | undefined>;
}

/** Every pinned definition of a setup, with its section. */
export function pinnedOf(setup: AgentSetup): { section: DefinitionSection; kind: DefinitionKind; name: string; pin: PinnedDefinition }[] {
  const out: { section: DefinitionSection; kind: DefinitionKind; name: string; pin: PinnedDefinition }[] = [];
  for (const section of ["tools", "skills", "mcp"] as const) {
    for (const [name, pin] of Object.entries(setup[section])) out.push({ section, kind: KIND_OF[section], name, pin });
  }
  if (setup.instructions !== undefined) out.push({ section: "instructions", kind: "instructions", name: INSTRUCTIONS_NAME, pin: setup.instructions });
  return out;
}

const kindFor = (section: DefinitionSection): ChangeKind => (section === "instructions" ? "instructions_changed" : "tools_changed");

/**
 * Compare what the transcript pinned with what the host's source offers now. A definition that is listed with a
 * different hash is `changed`; one that is no longer listed is `missing` (a blob copy would still replay, but
 * the agent could no longer use it). Without a source, only external pins are a problem: nothing can serve them.
 */
export async function checkDefinitions(setup: AgentSetup, source?: DefinitionSource): Promise<Change[]> {
  const pins = pinnedOf(setup);
  const listed = source === undefined ? undefined : new Map((await source.list()).map((d) => [`${d.kind}\0${d.name}`, d.hash]));
  const out: Change[] = [];
  for (const { section, kind, name, pin } of pins) {
    const label = `${kind} ${name}`;
    if (listed === undefined) {
      if (pin.store === "external") out.push({ kind: kindFor(section), message: `${label} is pinned externally but no definition source is configured` });
      continue;
    }
    const found = listed.get(`${kind}\0${name}`);
    if (found === undefined) out.push({ kind: kindFor(section), message: `${label} is pinned but the definition source no longer lists it` });
    else if (found !== pin.hash) out.push({ kind: kindFor(section), message: `${label} changed: pinned ${pin.hash.slice(0, 12)}, now ${found.slice(0, 12)}` });
  }
  return out;
}

/** `checkDefinitions`, refusing with `ChangeNotAllowed` for anything the caller has not allowed. */
export async function assertDefinitions(setup: AgentSetup, source: DefinitionSource | undefined, allow: readonly ChangeKind[] = []): Promise<void> {
  const refused = (await checkDefinitions(setup, source)).filter((c) => !allow.includes(c.kind));
  if (refused.length > 0) throw new ChangeNotAllowed(refused, "definitions drifted");
}

export interface LoadedDefinitions {
  /** Sorted by name, so the rendered tool list (and the cache prefix) never depends on map order. */
  tools: ToolDefinition[];
  instructions: string | undefined;
  skills: Record<string, unknown>;
  mcp: Record<string, unknown>;
}

/** Fetch and verify the bytes of every pinned definition: from `blobs/` or from the host's source. Throws if any does not match its hash. */
export async function loadDefinitions(setup: AgentSetup, from: { blobs: BlobStore; source?: DefinitionSource }): Promise<LoadedDefinitions> {
  const out: LoadedDefinitions = { tools: [], instructions: undefined, skills: {}, mcp: {} };
  for (const { section, kind, name, pin } of pinnedOf(setup)) {
    const bytes = pin.store === "blob" ? await from.blobs.get(pin.hash) : await from.source?.get(kind, name, pin.hash);
    if (bytes === undefined) throw new DefinitionError(`${kind} ${name} (${pin.hash.slice(0, 12)}) is not available from ${pin.store === "blob" ? "blobs/" : "the definition source"}`);
    if ((await sha256Hex(bytes)) !== pin.hash) throw new DefinitionError(`${kind} ${name}: the bytes do not match the pinned hash ${pin.hash.slice(0, 12)}`);
    const value = decodeDefinition(kind, bytes);
    if (section === "tools") out.tools.push(value as ToolDefinition);
    else if (section === "instructions") out.instructions = value as string;
    else out[section][name] = value;
  }
  out.tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
