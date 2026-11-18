/**
 * What the `harness.yml` editor knows about the file beyond its schema: which page a setting is on, how the provider
 * adapters are named, and the approvals table (the grants under `tools.<name>.allow` and `mcp.<server>.allow`, which
 * are a map of key to expiry date and are shown as rows). It is plain functions over the file's value, so the views only
 * draw and the rules can be tested without them.
 */
import type { FormIssue } from "./form.ts";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const objectOf = (x: unknown): Json => (isObject(x) ? x : {});

export const PAGES = [
  { id: "providers", title: "Providers", hint: "Where models come from", group: "project" },
  { id: "limits", title: "Limits", hint: "Cost and time ceilings", group: "project" },
  { id: "approvals", title: "Approvals", hint: "What is allowed without asking", group: "project" },
  { id: "mcp", title: "MCP servers", hint: "Tools from other programs", group: "project" },
  { id: "subagents", title: "Subagents", hint: "Delegated threads and their models", group: "project" },
  { id: "context", title: "Context", hint: "Compaction, injections, skills", group: "project" },
  { id: "repository", title: "Repository", hint: "Housekeeping and sharing", group: "project" },
  { id: "instructions", title: "Instructions", hint: "Files the agent is given", group: "thread" },
] as const;
export type PageId = (typeof PAGES)[number]["id"] | "general";

/** The groups the pages are listed under: `harness.yml` is the project's, the instructions are the thread's. */
export const GROUPS = [
  { id: "project", title: "Project (harness.yml)" },
  { id: "thread", title: "This thread" },
] as const;

/** The page a setting is on, from its dotted path; `general` for the file as a whole or a key no page shows. */
export function pageOf(path: string): PageId {
  const [head, , third] = path.split(".");
  switch (head) {
    case "providers":
    case "limits":
    case "mcp":
      return head === "mcp" && third === "allow" ? "approvals" : head;
    case "tools":
      return "approvals";
    case "subagent":
      return "subagents";
    case "compaction":
    case "injections":
    case "skills":
    case "attachments":
      return "context";
    case "maintenance":
    case "threads":
    case "background":
    case "leases":
    case "workspace":
      return "repository";
    default:
      return "general";
  }
}

/** How many problems each page has, and the problems no page shows. */
export function issueCounts(issues: readonly FormIssue[]): {
  byPage: Map<PageId, number>;
  general: FormIssue[];
} {
  const byPage = new Map<PageId, number>();
  const general: FormIssue[] = [];
  for (const i of issues) {
    const p = pageOf(i.path);
    if (p === "general") general.push(i);
    else byPage.set(p, (byPage.get(p) ?? 0) + 1);
  }
  return { byPage, general };
}

// ---- providers -----------------------------------------------------------------------------------------------------

export interface Adapter {
  tag: string;
  label: string;
  hint: string;
  /** Whether it needs the name of an environment variable holding a key. */
  key: boolean;
  /** Whether the address is something the person normally sets. */
  address: boolean;
  /** The address to start from, when there is a usual one. */
  base?: string;
}

/** The adapters a person can pick, in the order they are offered. `local-models` is run by the harness, not set up here. */
export const ADAPTERS: readonly Adapter[] = [
  {
    tag: "anthropic",
    label: "Anthropic",
    hint: "Claude, over the Messages API",
    key: true,
    address: false,
  },
  {
    tag: "openai",
    label: "OpenAI",
    hint: "GPT, over the Responses API",
    key: true,
    address: false,
  },
  {
    tag: "gemini",
    label: "Gemini",
    hint: "Google's models",
    key: true,
    address: false,
  },
  {
    tag: "openai-compatible",
    label: "OpenAI-compatible",
    hint: "A local or hosted server that speaks the chat API",
    key: false,
    address: true,
    base: "http://localhost:8080/v1",
  },
  {
    tag: "opencode-go",
    label: "OpenCode Go",
    hint: "A hosted bundle of open models",
    key: true,
    address: false,
  },
];

export const adapterOf = (tag: unknown): Adapter =>
  ADAPTERS.find((a) => a.tag === tag) ?? {
    tag: String(tag),
    label: String(tag),
    hint: "",
    key: true,
    address: true,
  };

const KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

/** A name for a new provider of this adapter that no existing one has. */
export function newProviderName(tag: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = tag === "openai-compatible" ? "local" : tag;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The provider entry a new card starts as. */
export function newProvider(tag: string): Json {
  const a = adapterOf(tag);
  return {
    $tag: tag,
    ...(a.base === undefined ? {} : { base_url: a.base }),
    ...(KEY_ENV[tag] === undefined ? {} : { api_key_env: KEY_ENV[tag] }),
  };
}

// ---- approvals -----------------------------------------------------------------------------------------------------

export const FOREVER = "2999-01-01";
export type GrantState = "forever" | "active" | "soon" | "expired" | "invalid";

export interface Grant {
  scope: "tool" | "mcp";
  /** The tool or the server the grant is under. */
  owner: string;
  /** What is allowed (a command pattern, a tool name). */
  key: string;
  /** The date or datetime as written. */
  until: string;
  state: GrantState;
}

const where = (scope: "tool" | "mcp", owner: string): string[] => (scope === "tool" ? ["tools", owner, "allow"] : ["mcp", owner, "allow"]);

export function grantState(until: string, now: Date): GrantState {
  if (until.startsWith(FOREVER.slice(0, 4)) && until.slice(0, 4) >= "2999") return "forever";
  const t = Date.parse(until);
  if (Number.isNaN(t)) return "invalid";
  if (t < now.getTime()) return "expired";
  return t - now.getTime() < 7 * 86_400_000 ? "soon" : "active";
}

/** Every grant in the file, tools first, in the file's order. */
export function grants(value: Json, now: Date): Grant[] {
  const out: Grant[] = [];
  for (const scope of ["tool", "mcp"] as const) {
    const top = objectOf(value[scope === "tool" ? "tools" : "mcp"]);
    for (const [owner, entry] of Object.entries(top)) {
      if (scope === "tool" && owner === "env") continue;
      for (const [key, until] of Object.entries(objectOf(objectOf(entry)["allow"]))) {
        const u = typeof until === "string" ? until : "";
        out.push({ scope, owner, key, until: u, state: grantState(u, now) });
      }
    }
  }
  return out;
}

/** The owners a grant could be added under: the tools that exist and the servers that are set up. */
export function grantOwners(value: Json, tools: readonly string[]): { tool: string[]; mcp: string[] } {
  const known = Object.keys(objectOf(value["tools"])).filter((k) => k !== "env");
  return {
    tool: [...new Set([...tools, ...known])].sort(),
    mcp: Object.keys(objectOf(value["mcp"])),
  };
}

function withAllow(value: Json, scope: "tool" | "mcp", owner: string, change: (allow: Json) => Json): Json {
  const top = where(scope, owner)[0];
  const topObj = objectOf(value[top ?? ""]);
  const entry = objectOf(topObj[owner]);
  const allow = change(objectOf(entry["allow"]));
  const nextEntry: Json = { ...entry };
  if (Object.keys(allow).length === 0) delete nextEntry["allow"];
  else nextEntry["allow"] = allow;
  return { ...value, [top ?? ""]: { ...topObj, [owner]: nextEntry } };
}

export const addGrant = (value: Json, scope: "tool" | "mcp", owner: string, key: string, until: string): Json =>
  withAllow(value, scope, owner, (a) => ({ ...a, [key]: until }));

export const removeGrant = (value: Json, g: Pick<Grant, "scope" | "owner" | "key">): Json =>
  withAllow(value, g.scope, g.owner, (a) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== g.key)));

export const setGrantUntil = (value: Json, g: Pick<Grant, "scope" | "owner" | "key">, until: string): Json =>
  withAllow(value, g.scope, g.owner, (a) => ({ ...a, [g.key]: until }));

/** Change what a grant allows, keeping its place in the table. */
export const renameGrant = (value: Json, g: Pick<Grant, "scope" | "owner" | "key">, key: string): Json =>
  withAllow(value, g.scope, g.owner, (a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k === g.key ? key : k, v])));

/** A date a number of days from `now`, as a plain date (`2026-11-25`). */
export const inDays = (now: Date, days: number): string => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

// ---- MCP servers ---------------------------------------------------------------------------------------------------

/** How a server is reached, for the table. */
export function mcpTransport(entry: Json): {
  kind: "command" | "url" | "none";
  text: string;
} {
  if (typeof entry["command"] === "string") {
    const args = Array.isArray(entry["args"]) ? entry["args"].filter((a): a is string => typeof a === "string") : [];
    return { kind: "command", text: [entry["command"], ...args].join(" ") };
  }
  if (typeof entry["url"] === "string") return { kind: "url", text: entry["url"] };
  return { kind: "none", text: "" };
}

/** The built-in tools, so a grant can be added for one the file does not mention yet. */
export const BUILTIN_TOOLS: readonly string[] = ["read", "edit", "write", "run", "script", "fetch", "search"];

// ---- models --------------------------------------------------------------------------------------------------------

/** The key a model has in `subagent.models`. */
export const modelKey = (provider: string, id: string): string => `${provider}/${id}`;

/** Models switched on for subagents, by key. */
export const enabledModels = (value: Json): Set<string> => new Set(Object.keys(objectOf(objectOf(value["subagent"])["models"])));

/** `provider/id` split at the first slash (a model id may itself contain slashes). */
export function splitModelKey(key: string): { provider: string; id: string } {
  const i = key.indexOf("/");
  return i < 0 ? { provider: "", id: key } : { provider: key.slice(0, i), id: key.slice(i + 1) };
}

// ---- instruction files ---------------------------------------------------------------------------------------------

/** Files tools commonly read for a project's instructions: what each is, for the "found" list. */
export const WELL_KNOWN_INSTRUCTIONS: Readonly<Record<string, string>> = {
  "AGENTS.md": "The common agent guide, read by most tools",
  "CLAUDE.md": "Claude Code's project instructions",
  "GEMINI.md": "Gemini CLI's project instructions",
  ".github/copilot-instructions.md": "GitHub Copilot's repository instructions",
  ".cursorrules": "Cursor's rules",
  "CONVENTIONS.md": "Aider's conventions file",
  "CONTRIBUTING.md": "How to contribute to the project",
};

/** Rough token count of a file from its size (about four bytes a token). */
export const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);
