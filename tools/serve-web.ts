/**
 * Runs the product in a browser tab: builds the page (`dist/web/`), then serves it over the web host with the real controller on
 * the folders given (default: the current directory). `pnpm web [folder...]`; `PORT` chooses the port. Keys are read from the
 * environment, as the settings name them. Loopback only; the file the person asks to open is printed, not opened.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeHost } from "../hosts/node.ts";
import { Controller } from "../ui/controller/controller.ts";
import { startWebHost } from "../ui/host/web-host.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "vscode");
const out = join(root, "dist", "web");
const built = spawnSync(process.execPath, ["--no-warnings", join(root, "tools", "build-web.mts")], { stdio: "inherit", env: process.env });
if (built.status !== 0) process.exit(built.status ?? 1);

const folders = (process.argv.length > 2 ? process.argv.slice(2) : ["."]).map((f) => resolve(f));
const env = { host: nodeHost(), cwd: process.cwd(), env: process.env, now: Date.now };
const host = await startWebHost({
  dir: out,
  port: Number(process.env["PORT"] ?? 5174),
  controller: (emit) =>
    new Controller({
      env,
      folders,
      send: emit,
      session: `web-${process.pid}`,
      platform: {
        openFile: (f) => {
          console.log(`open ${f.path}${f.line === undefined ? "" : `:${f.line}`}`);
          return Promise.resolve();
        },
        copy: (t) => {
          console.log(`copy ${t}`);
          return Promise.resolve();
        },
        pickFiles: () => Promise.resolve([]),
      },
    }),
});
console.log(`chattree at ${host.url} (folders: ${folders.join(", ")})`);
