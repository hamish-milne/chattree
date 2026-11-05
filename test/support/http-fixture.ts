import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Route {
  body?: Uint8Array | string;
  status?: number;
  headers?: Record<string, string>;
  /** Honour Range requests (default true). */
  ranges?: boolean;
  /** Destroy the connection after this many body bytes. */
  cutAfter?: number;
  /** Computed per request, instead of `body` and `status`. */
  handle?: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

/** A small HTTP server for download tests: fixed routes, Range support, and a record of what was asked. */
export class HttpFixture {
  readonly routes = new Map<string, Route>();
  readonly seen: Seen[] = [];
  readonly #server = createServer((req, res) => this.#serve(req, res));
  base = "";

  static async start(): Promise<HttpFixture> {
    const f = new HttpFixture();
    await new Promise<void>((resolve) => f.#server.listen(0, "127.0.0.1", resolve));
    f.base = `http://127.0.0.1:${(f.#server.address() as AddressInfo).port}`;
    return f;
  }

  on(path: string, route: Route): this {
    this.routes.set(path, route);
    return this;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #serve(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0] as string;
    this.seen.push({ method: req.method ?? "GET", path, headers: req.headers });
    const route = this.routes.get(path);
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    if (route.handle !== undefined) {
      route.handle(req, res);
      return;
    }
    const body = typeof route.body === "string" ? Buffer.from(route.body) : Buffer.from(route.body ?? new Uint8Array(0));
    const headers = { ...(route.headers ?? {}) };
    let status = route.status ?? 200;
    let slice = body;
    const range = /^bytes=(\d+)-$/.exec(String(req.headers["range"] ?? ""));
    if (range !== null && route.ranges !== false && status === 200) {
      const from = Number(range[1]);
      if (from >= body.length) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
        return;
      }
      slice = body.subarray(from);
      status = 206;
      headers["content-range"] = `bytes ${from}-${body.length - 1}/${body.length}`;
    }
    headers["content-length"] = String(slice.length);
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (route.cutAfter !== undefined && route.cutAfter < slice.length) {
      res.write(slice.subarray(0, route.cutAfter), () => setTimeout(() => res.destroy(), 30));
      return;
    }
    res.end(slice);
  }
}
