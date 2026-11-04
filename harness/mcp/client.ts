import type { Host, HostProcess } from "../../src/host.ts";
import { SseParser } from "../../providers/sse.ts";

/**
 * A small client for the Model Context Protocol (docs/context.md, section 2): the tools part only (`initialize`, `tools/list`, `tools/call`,
 * `notifications/tools/list_changed`), over a child process's stdin and stdout or over streamable HTTP. No dependency: the protocol is JSON-RPC 2.0
 * and a handful of rules. Resources, prompts, sampling, roots and elicitation are not offered, so a server that asks for them is told the method is unknown.
 */

export const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  override name = "McpError";
  /** The JSON-RPC error code, when the server sent one. */
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** How messages travel. Start it with the handlers; `send` rejects when the message could not be sent. */
export interface McpTransport {
  start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  /** The protocol version agreed in `initialize`, for transports that must repeat it. */
  negotiated?(version: string): void;
  close(): Promise<void>;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export type McpContent = { type: "text"; text: string } | { type: "image" | "audio"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } } | { type: "resource_link"; uri: string; name?: string; mimeType?: string } | { type: string; [k: string]: unknown };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  method: string;
}

export interface ConnectOptions {
  clientName: string;
  clientVersion: string;
  /** How long `initialize` may take, in ms. Default 30 000. */
  timeoutMs?: number;
}

export class McpClient {
  readonly #transport: McpTransport;
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #closed: string | undefined;
  #stale = false;
  #listings = 0;
  serverInfo: { name: string; version: string } | undefined;
  instructions: string | undefined;

  private constructor(transport: McpTransport) {
    this.#transport = transport;
  }

  /** Start the transport and do the handshake. Throws `McpError` if the server does not answer or speaks another protocol. */
  static async connect(transport: McpTransport, opts: ConnectOptions): Promise<McpClient> {
    const client = new McpClient(transport);
    await transport.start((m) => client.#onMessage(m), (why) => client.#onClose(why));
    try {
      const r = await client.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: opts.clientName, version: opts.clientVersion } }, { timeoutMs: opts.timeoutMs ?? 30_000 });
      if (!isObject(r) || typeof r["protocolVersion"] !== "string") throw new McpError("the server's reply to initialize was not understood");
      const version = r["protocolVersion"];
      if (!["2025-06-18", "2025-03-26", "2024-11-05"].includes(version)) throw new McpError(`the server speaks protocol version ${version}, which this client does not`);
      transport.negotiated?.(version);
      const info = r["serverInfo"];
      if (isObject(info) && typeof info["name"] === "string") client.serverInfo = { name: info["name"], version: typeof info["version"] === "string" ? info["version"] : "" };
      if (typeof r["instructions"] === "string") client.instructions = r["instructions"];
      await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return client;
    } catch (e) {
      await client.close();
      throw e;
    }
  }

  /** The server said its tool list changed since it was last read. */
  get stale(): boolean {
    return this.#stale;
  }

  /** How many times the tool list has been read: a holder that read it earlier than this has an older list than the next one to read it. */
  get listings(): number {
    return this.#listings;
  }

  /** Why the connection ended, or undefined while it is up. */
  get closedBecause(): string | undefined {
    return this.#closed;
  }

  /** Every tool the server lists, following the pagination cursor. */
  async listTools(opts: { timeoutMs?: number } = {}): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.#request("tools/list", cursor === undefined ? {} : { cursor }, { timeoutMs: opts.timeoutMs ?? 30_000 });
      if (!isObject(r) || !Array.isArray(r["tools"])) throw new McpError("the server's tool list was not understood");
      for (const t of r["tools"]) {
        if (isObject(t) && typeof t["name"] === "string") {
          out.push({
            name: t["name"],
            ...(typeof t["title"] === "string" ? { title: t["title"] } : {}),
            ...(typeof t["description"] === "string" ? { description: t["description"] } : {}),
            inputSchema: t["inputSchema"],
            ...(isObject(t["annotations"]) ? { annotations: t["annotations"] } : {}),
          });
        }
      }
      cursor = typeof r["nextCursor"] === "string" && r["nextCursor"] !== "" ? r["nextCursor"] : undefined;
      if (cursor === undefined) {
        this.#stale = false;
        this.#listings++;
        return out;
      }
    }
    throw new McpError("the server's tool list has more than 50 pages");
  }

  /** Call a tool. Aborting `signal` tells the server (`notifications/cancelled`) and rejects. */
  async callTool(name: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallResult> {
    const r = await this.#request("tools/call", { name, arguments: args }, opts);
    if (!isObject(r)) throw new McpError("the server's result was not understood");
    const content = Array.isArray(r["content"]) ? (r["content"].filter((c) => isObject(c) && typeof c["type"] === "string") as McpContent[]) : [];
    return { content, ...(r["isError"] === true ? { isError: true } : {}), ...(r["structuredContent"] === undefined ? {} : { structuredContent: r["structuredContent"] }) };
  }

  async close(): Promise<void> {
    this.#onClose("closed");
    await this.#transport.close().catch(() => undefined);
  }

  #request(method: string, params: unknown, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
    if (this.#closed !== undefined) return Promise.reject(new McpError(`the connection is closed (${this.#closed})`));
    const id = this.#next++;
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const cancel = (reason: string, error: McpError): void => {
        if (!this.#pending.has(id)) return;
        done();
        if (method !== "initialize") void this.#transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }).catch(() => undefined);
        reject(error);
      };
      const onAbort = (): void => cancel("the caller stopped", new McpError(`${method} was stopped`));
      this.#pending.set(id, {
        method,
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      if (opts.signal?.aborted === true) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.timeoutMs !== undefined) timer = setTimeout(() => cancel("timed out", new McpError(`${method} timed out after ${Math.round((opts.timeoutMs as number) / 1000)} s`)), opts.timeoutMs);
      this.#transport.send({ jsonrpc: "2.0", id, method, params }).catch((e: unknown) => {
        if (!this.#pending.has(id)) return;
        done();
        reject(e instanceof Error ? e : new McpError(String(e)));
      });
    });
  }

  #onMessage(m: JsonRpcMessage): void {
    if (m.method !== undefined) {
      if (m.id === undefined) {
        if (m.method === "notifications/tools/list_changed") this.#stale = true;
        return; // other notifications (progress, logging, resources) are not used
      }
      // A request from the server. Only `ping` is answered; everything else is a capability this client does not have.
      const reply: JsonRpcMessage = m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
      void this.#transport.send(reply).catch(() => undefined);
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.#pending.get(m.id);
    if (p === undefined) return;
    if (m.error !== undefined) p.reject(new McpError(`${p.method}: ${m.error.message}`, m.error.code));
    else p.resolve(m.result);
  }

  #onClose(why: string): void {
    if (this.#closed !== undefined) return;
    this.#closed = why;
    for (const p of [...this.#pending.values()]) p.reject(new McpError(`the server's connection ended (${why}) before it answered ${p.method}`));
  }
}

// ---- stdio ---------------------------------------------------------------------------------------------------

export interface StdioOptions {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
}

/** A server that is a child process speaking newline-delimited JSON on stdin and stdout. Its stderr is kept for the error if it dies. */
export function stdioTransport(host: Host, o: StdioOptions): McpTransport {
  let proc: HostProcess | undefined;
  const enc = new TextEncoder();
  return {
    async start(onMessage, onClose) {
      if (host.spawn === undefined) throw new McpError("this host cannot start long-running programs, which an MCP server over stdio needs");
      try {
        proc = await host.spawn(o.command, o.args, { cwd: o.cwd, env: o.env });
      } catch (e) {
        throw new McpError(`could not start ${o.command}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const p = proc;
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        try {
          for await (const chunk of p.output) {
            buf += dec.decode(chunk, { stream: true });
            for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line === "") continue;
              try {
                const m = JSON.parse(line) as unknown;
                if (isObject(m) && m["jsonrpc"] === "2.0") onMessage(m as JsonRpcMessage);
              } catch {
                /* a server that logs to stdout: not a message */
              }
            }
          }
        } catch {
          /* the stream ended badly: the exit below says how */
        }
      })();
      void p.exit.then((x) => {
        const tail = new TextDecoder().decode(x.stderr).trim().split("\n").slice(-5).join(" | ");
        onClose(`${o.command} exited with code ${x.exitCode}${tail === "" ? "" : `: ${tail}`}`);
      });
    },
    async send(m) {
      if (proc === undefined) throw new McpError("the server is not running");
      await proc.write(enc.encode(`${JSON.stringify(m)}\n`));
    },
    async close() {
      if (proc === undefined) return;
      await proc.closeInput().catch(() => undefined);
      proc.kill();
    },
  };
}

// ---- streamable HTTP -----------------------------------------------------------------------------------------

export interface HttpOptions {
  url: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}

/** A server at an HTTP endpoint (the 2025 "streamable HTTP" transport): each message is a POST, answered by JSON or by an event stream. */
export function httpTransport(o: HttpOptions): McpTransport {
  const f = o.fetch ?? fetch;
  let session: string | undefined;
  let version: string | undefined;
  let deliver: ((m: JsonRpcMessage) => void) | undefined;
  let ended: ((why: string) => void) | undefined;
  const controller = new AbortController();
  const headers = (): Record<string, string> => ({ ...o.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session === undefined ? {} : { "mcp-session-id": session }), ...(version === undefined ? {} : { "mcp-protocol-version": version }) });
  const dispatch = (v: unknown): void => {
    for (const m of Array.isArray(v) ? v : [v]) if (isObject(m) && m["jsonrpc"] === "2.0") deliver?.(m as JsonRpcMessage);
  };
  return {
    async start(onMessage, onClose) {
      deliver = onMessage;
      ended = onClose;
    },
    negotiated(v) {
      version = v;
    },
    async send(m) {
      let res: Response;
      try {
        res = await f(o.url, { method: "POST", headers: headers(), body: JSON.stringify(m), signal: controller.signal });
      } catch (e) {
        throw new McpError(`could not reach ${o.url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid !== null && session === undefined) session = sid;
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        if (res.status === 404 && session !== undefined) ended?.("the server forgot the session (HTTP 404)");
        throw new McpError(`${o.url} answered HTTP ${res.status}${body === "" ? "" : `: ${body}`}`);
      }
      if (m.id === undefined) {
        await res.body?.cancel().catch(() => undefined);
        return; // a notification: the server answers 202 with nothing
      }
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && res.body !== null) {
        // The answer comes on the stream, possibly after other messages; reading it must not hold up the sender.
        void (async () => {
          const sse = new SseParser();
          const reader = res.body?.getReader();
          try {
            while (reader !== undefined) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const ev of sse.push(value)) if (ev.event === "message") dispatch(JSON.parse(ev.data) as unknown);
            }
          } catch (e) {
            if (!controller.signal.aborted) ended?.(`the event stream failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
        return;
      }
      try {
        dispatch(JSON.parse(await res.text()) as unknown);
      } catch {
        throw new McpError(`${o.url} answered something that is not JSON-RPC`);
      }
    },
    async close() {
      controller.abort();
      if (session !== undefined) await f(o.url, { method: "DELETE", headers: { ...o.headers, "mcp-session-id": session, ...(version === undefined ? {} : { "mcp-protocol-version": version }) } }).catch(() => undefined);
    },
  };
}
