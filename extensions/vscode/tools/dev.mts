/**
 * `pnpm dev`: everything that keeps the preview current while you edit. The CSS-module declarations are regenerated when a
 * stylesheet changes, the bundle is rebuilt when any source does, and the result is served at http://127.0.0.1:5173/.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (script: string, ...args: string[]) =>
  spawn(process.execPath, ["--no-warnings", join(root, "tools", script), ...args], { cwd: root, stdio: "inherit" });

const children = [run("gen-css-types.mts", "--watch"), run("build-preview.mts", "--watch"), run("serve-preview.mts")];
const stop = (): void => {
  for (const c of children) c.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children)
  c.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
