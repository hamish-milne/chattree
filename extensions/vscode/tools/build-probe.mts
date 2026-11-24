/** Bundles the completions probe (`probe/`) into `probe/dist/extension.js`, the way the extension is bundled. */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "probe");
await build({
  entryPoints: [join(root, "src", "extension.ts")],
  outfile: join(root, "dist", "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
});
