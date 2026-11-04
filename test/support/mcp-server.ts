import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { JsonRpcMessage } from "../../harness/mcp/client.ts";

/**
 * A scripted MCP server for tests, used two ways: as a child process speaking JSON-RPC lines on stdio (run this file; the tool list and the
 * page size come from `MCP_FAKE_TOOLS` and `MCP_FAKE_PAGE` as JSON and a number), and as an HTTP endpoint in the test's own process (`startHttp`).
 */

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export const DEFAULT_TOOLS: FakeTool[] = [
  { name: "echo", description: "Repeat the text back.", inputSchema: { type: "object", properties: { text: { type: "string", description: "what to say" } }, required: ["text"] } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Waits until it is cancelled.", inputSchema: { type: "object", properties: {} } },
  { name: "picture", description: "Returns an image and some text.", inputSchema: { type: "object", properties: {} } },
  { name: "change", description: "Announces that its tool list changed.", inputSchema: { type: "object", properties: {} } },
];

export class FakeMcp {
  readonly seen: JsonRpcMessage[] = [];
  readonly cancelled: unknown[] = [];
  tools: FakeTool[];
  readonly #page: number;
  readonly #push: (m: JsonRpcMessage) => void;
  #held = new Map<number | string, () => void>();

  constructor(opts: { tools?: FakeTool[]; page?: number; push?: (m: JsonRpcMessage) => void } = {}) {
    this.tools = opts.tools ?? DEFAULT_TOOLS;
    this.#page = opts.page ?? 0;
    this.#push = opts.push ?? (() => undefined);
  }

  /** The reply to a message, or undefined when there is none (a notification, or a call held until it is cancelled). */
  async handle(m: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    this.seen.push(m);
    if (m.method === "notifications/cancelled") {
      const p = m.params as { requestId: number | string };
      this.cancelled.push(p.requestId);
      this.#held.get(p.requestId)?.();
      return undefined;
    }
    if (m.id === undefined || m.method === undefined) return undefined;
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id: m.id as number, result });
    const params = (m.params ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1.2.3" }, instructions: "be careful" });
      case "ping":
        return ok({});
      case "tools/list": {
        const from = typeof params["cursor"] === "string" ? Number(params["cursor"]) : 0;
        const size = this.#page > 0 ? this.#page : this.tools.length;
        const page = this.tools.slice(from, from + size);
        return ok({ tools: page, ...(from + size < this.tools.length ? { nextCursor: String(from + size) } : {}) });
      }
      case "tools/call": {
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        switch (params["name"]) {
          case "echo":
            return ok({ content: [{ type: "text", text: `echo: ${String(args["text"])}` }] });
          case "fail":
            return ok({ content: [{ type: "text", text: "it broke" }], isError: true });
          case "picture":
            return ok({ content: [{ type: "text", text: "here" }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
          case "change":
            this.#push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
            return ok({ content: [{ type: "text", text: "changed" }] });
          case "slow":
            await new Promise<void>((resolve) => this.#held.set(m.id as number, resolve));
            return undefined;
          default:
            return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${String(params["name"])}` } };
        }
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
    }
  }
}

export interface HttpFake {
  url: string;
  server: FakeMcp;
  /** The headers of each request, lowercased. */
  headers: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** An HTTP MCP endpoint. `sse` answers requests as event streams (with a progress notification first) instead of plain JSON; `auth` demands that header value. */
export async function startHttp(opts: { tools?: FakeTool[]; page?: number; sse?: boolean; auth?: string } = {}): Promise<HttpFake> {
  const server = new FakeMcp({ ...(opts.tools === undefined ? {} : { tools: opts.tools }), ...(opts.page === undefined ? {} : { page: opts.page }) });
  const headers: HttpFake["headers"] = [];
  let sessions = 0;
  const http: Server = createServer(async (req, res) => {
    headers.push({ ...req.headers });
    if (opts.auth !== undefined && req.headers["authorization"] !== opts.auth) {
      res.writeHead(401).end("no");
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    const m = JSON.parse(await readBody(req)) as JsonRpcMessage;
    const reply = await server.handle(m);
    const extra: Record<string, string> = m.method === "initialize" ? { "mcp-session-id": `s${++sessions}` } : {};
    if (reply === undefined) {
      res.writeHead(202, extra).end();
      return;
    }
    if (opts.sse === true) {
      res.writeHead(200, { "content-type": "text/event-stream", ...extra });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...extra }).end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, server, headers, close: () => new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); }) };
}

// ---- run as a program: JSON-RPC lines on stdin and stdout --------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tools = process.env["MCP_FAKE_TOOLS"] === undefined ? undefined : (JSON.parse(process.env["MCP_FAKE_TOOLS"]) as FakeTool[]);
  const page = process.env["MCP_FAKE_PAGE"] === undefined ? undefined : Number(process.env["MCP_FAKE_PAGE"]);
  const write = (m: JsonRpcMessage): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
  const fake = new FakeMcp({ ...(tools === undefined ? {} : { tools }), ...(page === undefined ? {} : { page }), push: write });
  process.stderr.write("fake mcp server starting\n");
  let buf = "";
  process.stdin.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      void fake.handle(JSON.parse(line) as JsonRpcMessage).then((r) => {
        if (r !== undefined) write(r);
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
