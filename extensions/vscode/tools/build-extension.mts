/**
 * Bundles the extension into `dist/`: the extension host's script (`extension.js`, with the controller and the harness inside,
 * `vscode` left out as the editor provides it) and the webviews' page (`webview/webview.js` and `.css`). `EXTENSION_OUT` chooses
 * another directory.
 */
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env["EXTENSION_OUT"] ?? join(root, "dist");
await mkdir(out, { recursive: true });
await import("./gen-css-types.mts");

await build({
  entryPoints: [join(root, "src", "extension.ts")],
  outfile: join(out, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  // The harness finds its vendored files from its own URL; in the one-file bundle that is the bundle's.
  define: { "import.meta.url": "__chattreeUrl" },
  banner: { js: 'const __chattreeUrl = require("node:url").pathToFileURL(__filename).href;' },
  sourcemap: true,
  logLevel: "warning",
});

await build({
  entryPoints: [join(root, "webview", "main.tsx")],
  outfile: join(out, "webview", "webview.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  logLevel: "warning",
});
console.log(`built ${out}`);
