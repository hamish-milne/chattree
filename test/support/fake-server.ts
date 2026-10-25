import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One thing the fake server does while answering: write text, wait, cut the connection, or never finish. */
export type Act = string | { wait: number } | { reset: true } | { hang: true };

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** Written in order. Without `hang` or `reset` the response ends after the last act. */
  acts?: Act[];
}

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** True once the client has gone away (aborted or closed). */
  closed: boolean;
}

/** A local HTTP server that plays scripted replies, one per request (the last repeats), and records what it was sent. */
export class FakeServer {
  readonly seen: Seen[] = [];
  readonly url: string;
  readonly #server: Server;
  readonly #script: (n: number, req: Seen) => Reply;

  private constructor(server: Server, url: string, script: (n: number, req: Seen) => Reply) {
    this.#server = server;
    this.url = url;
    this.#script = script;
  }

  static async start(script: Reply[] | ((n: number, req: Seen) => Reply)): Promise<FakeServer> {
    const fn = typeof script === "function" ? script : (n: number): Reply => script[Math.min(n, script.length - 1)] as Reply;
    let handler: ((req: IncomingMessage, res: import("node:http").ServerResponse) => void) | undefined;
    const server = createServer((req, res) => handler?.(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const self = new FakeServer(server, `http://127.0.0.1:${port}`, fn);
    handler = (req, res) => void self.#handle(req, res);
    return self;
  }

  async #handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += chunk;
    const seen: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, closed: false };
    const n = this.seen.length;
    this.seen.push(seen);
    res.on("close", () => {
      seen.closed = true;
    });
    const reply = this.#script(n, seen);
    res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", ...reply.headers });
    res.flushHeaders();
    for (const act of reply.acts ?? []) {
      if (typeof act === "string") res.write(act);
      else if ("wait" in act) await new Promise((r) => setTimeout(r, act.wait));
      else if ("reset" in act) return void res.socket?.destroy();
      else return; // hang: leave the response open
      if (res.destroyed) return;
    }
    res.end();
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
