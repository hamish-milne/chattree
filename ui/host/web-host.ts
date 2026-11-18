/**
 * The web host: a controller behind a plain HTTP server, for a browser tab instead of a VS Code webview. Events go to
 * the page, and intents come back, over one WebSocket (`/ws`: JSON texts, see `ws.ts`); the page is the real views
 * (`extensions/vscode/web/`). It exists so the whole product can be driven in a real browser by a test (see
 * `test/e2e/`), with the things VS Code does for the extension (opening a file, the settings file) done by the host's
 * stand-ins. It listens on the loopback address only and serves only the files of one directory.
 *
 * Node only: nothing in `ui/model/` imports this.
 */
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseIntent, type UiEvent, type UiIntent } from "../model/protocol.ts";

/** What the host needs of a controller (the mock and the real one both are this). */
export interface HostedController {
  handle(intent: UiIntent): void;
}

export interface WebHostOptions {
  /** Make the controller; `emit` sends an event to every page that is open. */
  controller: (emit: (event: UiEvent) => void) => HostedController;
  /** The built page (`dist/web`): a plain file name in it is served. */
  dir: string;
  /** Default: any free port. */
  port?: number;
}

export interface WebHost {
  url: string;
  /** The events sent so far and the intents received, for a test to look at. */
  log: { events: UiEvent[]; intents: UiIntent[] };
  close(): Promise<void>;
}

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return (data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : data).toString("utf8");
};

export async function startWebHost(options: WebHostOptions): Promise<WebHost> {
  const pages = new Set<WebSocket>();
  const log: WebHost["log"] = { events: [], intents: [] };
  const emit = (event: UiEvent): void => {
    log.events.push(event);
    const text = JSON.stringify(event);
    for (const p of pages) p.send(text);
  };
  const controller = options.controller(emit);
  const complain = (message: string): void => emit({ type: "notice", level: "error", message });

  /** Check an intent from the page and hand it to the controller. The page is another context and is not trusted. */
  const answer = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return complain("The host was sent something that is not JSON");
    }
    const parsed = parseIntent(raw);
    if (!parsed.ok)
      return complain(`The host refused an intent: ${parsed.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    log.intents.push(parsed.value);
    try {
      controller.handle(parsed.value);
    } catch (e) {
      complain(`The controller failed on ${parsed.value.type}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET") {
      const file = name === "/" ? "index.html" : name.slice(1);
      if (/^[\w.-]+$/.test(file)) {
        readFile(join(options.dir, file)).then(
          (body) =>
            res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" }).end(body),
          () => res.writeHead(404).end("not found"),
        );
        return;
      }
    }
    res.writeHead(404).end("not found");
  });
  // A web page of another origin must not be able to drive the product through the person's browser.
  const sockets = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 1_000_000,
    verifyClient: (
      { origin, req }: { origin: string; req: IncomingMessage },
      done: (ok: boolean, code?: number, message?: string) => void,
    ) => (origin === `http://${req.headers.host ?? ""}` ? done(true) : done(false, 403, "origin not allowed")),
  });
  sockets.on("connection", (ws) => {
    pages.add(ws);
    ws.on("close", () => pages.delete(ws));
    ws.on("message", (data) => answer(rawText(data)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const p of pages) p.terminate();
        sockets.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
