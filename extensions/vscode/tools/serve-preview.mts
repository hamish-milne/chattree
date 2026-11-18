/**
 * Serves `dist/preview/` on localhost for looking at the views in a browser. Nothing else is served, and it listens on
 * the loopback address only.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "preview");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const port = Number(process.env["PORT"] ?? 5173);

createServer((req, res) => {
  const name = (req.url ?? "/").split("?")[0] ?? "/";
  const file = name === "/" ? "index.html" : name.slice(1);
  // Only plain file names directly inside dist/preview.
  const plain = /^[\w.-]+$/.test(file);
  readFile(join(dir, plain ? file : "")).then(
    (body) => res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" }).end(body),
    () => res.writeHead(404).end("not found: run `pnpm build:preview` first"),
  );
}).listen(port, "127.0.0.1", () => console.log(`preview at http://127.0.0.1:${port}/`));
