import { createHash } from "node:crypto";
import type { BlobStore } from "../../src/index.ts";
import type { Host } from "../../src/host.ts";
import type { HarnessConfig } from "../config.ts";
import { hashDefinition, pinDefinition, type ToolDefinition } from "../definitions.ts";
import type { AgentSetup, PinnedDefinition } from "../setup.ts";
import type { Tool, ToolOutput } from "../tools.ts";
import { httpTransport, McpClient, McpError, stdioTransport, type McpCallResult, type McpTool, type McpTransport } from "./client.ts";
import { toPortableSchema } from "./schema.ts";

/**
 * MCP servers as the harness uses them (docs/context.md, section 2): a server's configuration is **accepted by the thread** (pinned in
 * `agent_setup.mcp`) before anything is started or contacted, its tools become ordinary registry tools named `mcp__<server>__<tool>` whose
 * definitions are pinned like any tool's, and a call is an approval question like any other.
 */

export type McpServerConfig = HarnessConfig["mcp"][string];

const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/** What is pinned for a server: its configuration without any secret (a header's value is not here, only its name), canonically ordered. */
export function configValue(cfg: McpServerConfig): Record<string, unknown> {
  return {
    ...(cfg.command === undefined ? {} : { command: cfg.command, args: cfg.args }),
    ...(cfg.env === undefined ? {} : { env: sorted(cfg.env) }),
    ...(cfg.env_from === undefined ? {} : { env_from: [...cfg.env_from].sort() }),
    ...(cfg.url === undefined ? {} : { url: cfg.url }),
    ...(cfg.headers === undefined ? {} : { headers: Object.keys(cfg.headers).sort() }),
    ...(cfg.bearer_env === undefined ? {} : { bearer_env: cfg.bearer_env }),
    ...(cfg.header_env === undefined ? {} : { header_env: sorted(cfg.header_env) }),
    ...(cfg.only === undefined ? {} : { only: [...cfg.only].sort() }),
    ...(cfg.skip === undefined ? {} : { skip: [...cfg.skip].sort() }),
  };
}

export const pinServer = (blobs: BlobStore, cfg: McpServerConfig): Promise<PinnedDefinition> => pinDefinition("mcp", configValue(cfg), { store: "blob", blobs });

/** Whether the thread has accepted this configuration: `new` (never), `changed` (accepted a different one), or `accepted`. */
export async function serverState(setup: AgentSetup, name: string, cfg: McpServerConfig): Promise<"accepted" | "new" | "changed"> {
  const pin = setup.mcp[name];
  if (pin === undefined) return "new";
  return pin.hash === (await hashDefinition("mcp", configValue(cfg))) ? "accepted" : "changed";
}

/** One line saying what accepting the server lets the harness do. */
export function describeServer(cfg: McpServerConfig): string {
  if (cfg.command !== undefined) return `run ${[cfg.command, ...cfg.args].join(" ")}${cfg.env_from === undefined ? "" : ` (passing ${cfg.env_from.join(", ")} from your environment)`}`;
  const sends = [cfg.bearer_env, ...Object.values(cfg.header_env ?? {})].filter((x): x is string => x !== undefined);
  return `connect to ${cfg.url as string}${sends.length === 0 ? "" : ` (sending ${sends.join(", ")} from your environment)`}`;
}

// ---- names ---------------------------------------------------------------------------------------------------

const MAX_NAME = 64;

/** The registry name of a server's tool: letters, digits, `_` and `-`, at most 64 long; a long name keeps its start and gains a hash. */
export function toolName(server: string, tool: string): string {
  const base = `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  if (base.length <= MAX_NAME) return base;
  return `${base.slice(0, MAX_NAME - 9)}_${createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8)}`;
}

/** The server a registry name belongs to, if it is an MCP tool's. */
export const serverOf = (name: string): string | undefined => /^mcp__([a-z0-9]+(?:-[a-z0-9]+)*)__/.exec(name)?.[1];
export const isMcpTool = (name: string): boolean => name.startsWith("mcp__");

// ---- tools ---------------------------------------------------------------------------------------------------

const MAX_DESCRIPTION = 1500;

function describeTool(server: string, t: McpTool): string {
  const text = (t.description ?? t.title ?? t.name).trim().replace(/\s+\n/g, "\n");
  const cut = text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)} [cut]` : text;
  return `[MCP server ${server}] ${cut}`;
}

/** What the model is shown of a result: its text; other kinds of content are named, not carried. */
export function resultText(r: McpCallResult): string {
  const parts: string[] = [];
  for (const c of r.content) {
    if (c.type === "text" && typeof c["text"] === "string") parts.push(c["text"]);
    else if (c.type === "image" || c.type === "audio") parts.push(`[${c.type} (${String(c["mimeType"] ?? "unknown type")}, ${Math.round(((typeof c["data"] === "string" ? c["data"].length : 0) * 3) / 4)} bytes) was returned and is not shown]`);
    else if (c.type === "resource" && typeof c["resource"] === "object" && c["resource"] !== null) {
      const res = c["resource"] as { uri?: string; text?: string; mimeType?: string };
      parts.push(typeof res.text === "string" ? res.text : `[resource ${res.uri ?? ""}${res.mimeType === undefined ? "" : ` (${res.mimeType})`} was returned and is not shown]`);
    } else if (c.type === "resource_link") parts.push(`[link: ${String(c["uri"] ?? "")}${typeof c["name"] === "string" ? ` (${c["name"]})` : ""}]`);
    else parts.push(`[${c.type} content was returned and is not shown]`);
  }
  if (parts.length === 0 && r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  return parts.join("\n");
}

function wrap(server: string, client: McpClient, t: McpTool, name: string, schema: Record<string, unknown>): Tool {
  const definition: ToolDefinition = { name, description: describeTool(server, t), input_schema: schema, flags: { mcp: server } };
  return {
    definition,
    // Every call asks, as the server's own claims about it (`readOnlyHint`) are not something to rely on; "all" lets the user grant that tool for a while.
    allowKeys: () => ["all"],
    async execute(args, ctx): Promise<ToolOutput> {
      try {
        const r = await client.callTool(t.name, args, { signal: ctx.signal });
        return { content: resultText(r) || "(the server returned no content)", ...(r.isError === true ? { is_error: true } : {}) };
      } catch (e) {
        return { content: `MCP server ${server}: ${e instanceof Error ? e.message : String(e)}`, is_error: true };
      }
    },
  };
}

export interface ServerStatus {
  name: string;
  state: "accepted" | "new" | "changed";
  /** Why it is not connected, when it is not. */
  error?: string;
  connected: boolean;
  info?: { name: string; version: string };
  instructions?: string;
  /** The tools offered, by registry name, with the server's own name. */
  tools: { name: string; tool: string }[];
  /** Tools the server has that cannot be offered, and why. */
  skipped: { tool: string; why: string }[];
  /** What was changed to fit a tool's schema into the portable subset. */
  notes: { tool: string; note: string }[];
  /** The server says its tool list changed since it was read. */
  stale: boolean;
}

export interface ConnectedServer {
  client: McpClient;
  tools: Tool[];
  status: ServerStatus;
}

export interface McpDeps {
  host: Host;
  /** Where a server's program starts. */
  cwd: string;
  /** The host's environment, for `env_from`, `bearer_env` and `header_env`. */
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  clientVersion?: string;
  /** Milliseconds `initialize` and the tool list may take. Default 30 000. */
  timeoutMs?: number;
}

function transportFor(host: Host, cwd: string, env: McpDeps["env"], cfg: McpServerConfig, fetchImpl: typeof fetch | undefined): McpTransport {
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === "") throw new McpError(`the environment variable ${name} is not set`);
    return v;
  };
  if (cfg.command !== undefined) {
    const passed = Object.fromEntries((cfg.env_from ?? []).map((n) => [n, need(n)]));
    return stdioTransport(host, { command: cfg.command, args: cfg.args, env: { ...(cfg.env ?? {}), ...passed }, cwd });
  }
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  for (const [h, n] of Object.entries(cfg.header_env ?? {})) headers[h] = need(n);
  if (cfg.bearer_env !== undefined) headers["authorization"] = `Bearer ${need(cfg.bearer_env)}`;
  return httpTransport({ url: cfg.url as string, headers, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
}

/** Start one server whatever the thread has accepted (`/mcp accept` does this to show its tools first), and turn its tools into registry tools. */
export async function connectServer(name: string, cfg: McpServerConfig, state: ServerStatus["state"], deps: McpDeps): Promise<ConnectedServer> {
  const transport = transportFor(deps.host, deps.cwd, deps.env, cfg, deps.fetch);
  const client = await McpClient.connect(transport, { clientName: "chattree", clientVersion: deps.clientVersion ?? "0", ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) });
  try {
    const listed = await client.listTools(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs });
    const status: ServerStatus = { name, state, connected: true, tools: [], skipped: [], notes: [], stale: false, ...(client.serverInfo === undefined ? {} : { info: client.serverInfo }), ...(client.instructions === undefined ? {} : { instructions: client.instructions }) };
    const tools: Tool[] = [];
    const taken = new Set<string>();
    for (const t of listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (cfg.only !== undefined && !cfg.only.includes(t.name)) continue;
      if (cfg.skip?.includes(t.name) === true) continue;
      const schema = toPortableSchema(t.inputSchema);
      if (!schema.ok) {
        status.skipped.push({ tool: t.name, why: schema.problems.join("; ") });
        continue;
      }
      let full = toolName(name, t.name);
      for (let n = 2; taken.has(full); n++) full = `${toolName(name, t.name).slice(0, MAX_NAME - 3)}_${n}`;
      taken.add(full);
      tools.push(wrap(name, client, t, full, schema.schema));
      status.tools.push({ name: full, tool: t.name });
      for (const note of schema.notes) status.notes.push({ tool: t.name, note });
    }
    return { client, tools, status };
  } catch (e) {
    await client.close();
    throw e;
  }
}

/** The servers a thread has accepted, connected, and what could not be. */
export class McpServers {
  readonly tools: Tool[] = [];
  readonly status: ServerStatus[] = [];
  readonly #clients: McpClient[] = [];

  /** Connect every accepted server, in parallel. A server that is not accepted is not started; one that fails is reported, not thrown. */
  static async connect(servers: Record<string, McpServerConfig>, setup: AgentSetup, deps: McpDeps): Promise<McpServers> {
    const out = new McpServers();
    const results = await Promise.all(
      Object.entries(servers).map(async ([name, cfg]): Promise<{ status: ServerStatus; connected?: ConnectedServer }> => {
        const state = await serverState(setup, name, cfg);
        const base: ServerStatus = { name, state, connected: false, tools: [], skipped: [], notes: [], stale: false };
        if (state !== "accepted") return { status: { ...base, error: state === "new" ? "not accepted by this thread yet" : "its configuration changed since this thread accepted it" } };
        try {
          const c = await connectServer(name, cfg, state, deps);
          return { status: c.status, connected: c };
        } catch (e) {
          return { status: { ...base, error: e instanceof Error ? e.message : String(e) } };
        }
      }),
    );
    for (const r of results.sort((a, b) => (a.status.name < b.status.name ? -1 : 1))) {
      out.status.push(r.status);
      if (r.connected !== undefined) {
        out.tools.push(...r.connected.tools);
        out.#clients.push(r.connected.client);
      }
    }
    return out;
  }

  /** Whether any connected server says its tools changed. */
  stale(): string[] {
    return this.status.filter((s) => s.connected).flatMap((s, i) => (this.#clients[i]?.stale === true ? [s.name] : []));
  }

  async close(): Promise<void> {
    await Promise.all(this.#clients.map((c) => c.close()));
  }
}
