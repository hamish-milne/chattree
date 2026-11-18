/**
 * The web host: a controller behind a plain HTTP server, for a browser tab instead of a VS Code webview. Events go to
 * the page as server-sent events (`/events`) and intents come back as POSTs (`/intent`); the page is the real views
 * (`extensions/vscode/web/`). It exists so the whole product can be driven in a real browser by a test (see
 * `test/e2e/`), with the things VS Code does for the extension (opening a file, the settings file) done by the host's
 * stand-ins. It listens on the loopback address only and serves only the files of one directory.
 *
 * Node only: nothing in `ui/model/` imports this.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b: Buffer = Buffer.from(c instanceof Uint8Array ? c : String(c));
    size += b.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export async function startWebHost(options: WebHostOptions): Promise<WebHost> {
  const pages = new Set<ServerResponse>();
  const log: WebHost["log"] = { events: [], intents: [] };
  const emit = (event: UiEvent): void => {
    log.events.push(event);
    for (const p of pages) p.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = options.controller(emit);

  /** Check an intent from the page and hand it to the controller. The page is another context and is not trusted. */
  const answer = (res: ServerResponse, body: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      res.writeHead(400).end("not JSON");
      return;
    }
    const parsed = parseIntent(raw);
    if (!parsed.ok) {
      res.writeHead(400).end(`not an intent: ${parsed.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      return;
    }
    log.intents.push(parsed.value);
    try {
      controller.handle(parsed.value);
    } catch (e) {
      res.writeHead(500).end(e instanceof Error ? e.message : String(e));
      return;
    }
    res.writeHead(204).end();
  };

  const server = createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && name === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": open\n\n");
      pages.add(res);
      req.on("close", () => pages.delete(res));
      return;
    }
    if (req.method === "POST" && name === "/intent") {
      readBody(req).then(
        (body) => answer(res, body),
        () => void res.writeHead(413).end(),
      );
      return;
    }
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
        for (const p of pages) p.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
