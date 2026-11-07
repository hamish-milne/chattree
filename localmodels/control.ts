import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HostEvent, HostState } from "./host.ts";
import type { InstallPlan } from "./install.ts";

/**
 * The control API (docs/local-models.md, section 3): HTTP on a loopback port, the same for the CLI and a future GUI. Every request carries
 * the daemon's token. It is separate from the model API (llama-server's own port), which has no authentication of its own.
 */

export type DaemonEvent = HostEvent | { type: "consent"; plan: InstallPlan | undefined } | { type: "settings"; error: string | undefined };

export interface DaemonStatus {
  pid: number;
  startedAt: number;
  state: HostState;
  /** An installation waiting to be agreed to. */
  consent: InstallPlan | undefined;
  /** Why the last read of the settings failed, while the old settings keep running. */
  settingsError: string | undefined;
}

/** What the API asks of the daemon. */
export interface ControlTarget {
  status(): DaemonStatus;
  subscribe(listener: (e: DaemonEvent) => void): () => void;
  logs(lines: number): string[];
  start(opts: { yes: boolean }): void;
  restart(opts: { yes: boolean }): void;
  stop(): void;
  /** Fetch models without starting the server; the `pulled` event ends it. */
  pull(models: string[], force: boolean): void;
  remove(model: string): Promise<{ files: number; bytes: number }>;
  reload(): Promise<DaemonStatus>;
  consent(accept: boolean): boolean;
  load(model: string): Promise<void>;
  unload(model: string): Promise<void>;
}

export class ControlServer {
  readonly token = randomBytes(32).toString("hex");
  readonly #target: ControlTarget;
  readonly #server: Server;
  #port = 0;
  #streams = 0;
  #last = Date.now();

  /** When a request last came that was not just a look at the status. */
  get lastActivity(): number {
    return this.#last;
  }

  /** Count this as use (a model in memory is use). */
  touch(): void {
    this.#last = Date.now();
  }

  /** How many event streams are open (a session or a GUI is attached). */
  get streams(): number {
    return this.#streams;
  }

  constructor(target: ControlTarget) {
    this.#target = target;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch((e: unknown) => {
        if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        else res.end();
      });
    });
  }

  get port(): number {
    return this.#port;
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    this.#port = (this.#server.address() as AddressInfo).port;
    return this.#port;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #authorised(req: IncomingMessage): boolean {
    const given = Buffer.from((req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page must not be able to drive the daemon: no cross-origin requests, and only the loopback names for the host (DNS rebinding).
    const host = req.headers["host"] ?? "";
    if (req.headers["origin"] !== undefined || ![`127.0.0.1:${this.#port}`, `localhost:${this.#port}`].includes(host)) return json(res, 403, { error: "forbidden" });
    if (!this.#authorised(req)) return json(res, 401, { error: "the token is missing or wrong" });
    const url = new URL(req.url ?? "/", "http://x");
    const route = `${req.method} ${url.pathname}`;
    if (route !== "GET /status") this.#last = Date.now();
    const t = this.#target;
    switch (route) {
      case "GET /status":
        return json(res, 200, t.status());
      case "GET /logs":
        return json(res, 200, { lines: t.logs(Math.min(Math.max(Number(url.searchParams.get("lines") ?? 200) || 200, 1), 500)) });
      case "GET /events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (e: unknown): void => void res.write(`data: ${JSON.stringify(e)}\n\n`);
        send({ type: "status", status: t.status() });
        const off = t.subscribe(send);
        const beat = setInterval(() => res.write(": \n\n"), 15_000);
        this.#streams++;
        req.on("close", () => (off(), clearInterval(beat), this.#streams--, (this.#last = Date.now())));
        return;
      }
      case "POST /start": {
        const body = await readBody(req);
        t.start({ yes: body["yes"] === true });
        return json(res, 202, t.status());
      }
      case "POST /restart": {
        t.restart({ yes: (await readBody(req))["yes"] === true });
        return json(res, 202, t.status());
      }
      case "POST /pull": {
        const body = await readBody(req);
        const models = Array.isArray(body["models"]) && body["models"].every((m) => typeof m === "string") ? (body["models"] as string[]) : [];
        t.pull(models, body["force"] === true);
        return json(res, 202, t.status());
      }
      case "POST /rm": {
        const model = (await readBody(req))["model"];
        if (typeof model !== "string") return json(res, 400, { error: "model is required" });
        return json(res, 200, await t.remove(model));
      }
      case "POST /stop":
        json(res, 200, { stopping: true });
        t.stop();
        return;
      case "POST /reload":
        return json(res, 200, await t.reload());
      case "POST /consent": {
        const body = await readBody(req);
        return json(res, 200, { answered: t.consent(body["accept"] === true) });
      }
      case "POST /models/load":
      case "POST /models/unload": {
        const model = (await readBody(req))["model"];
        if (typeof model !== "string") return json(res, 400, { error: "model is required" });
        await (route.endsWith("/load") ? t.load(model) : t.unload(model));
        return json(res, 200, { success: true });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("the request is too large");
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new Error("the request is not JSON");
  }
}
