/**
 * Bundles the web client (the views over HTTP, see `web/web.tsx`) into `dist/web/`: the page, its script and its styles.
 * `WEB_OUT` chooses another directory (the end-to-end tests build into a temporary one).
 */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env["WEB_OUT"] ?? join(root, "dist", "web");
await mkdir(out, { recursive: true });
await import("./gen-css-types.mts");
await build({
  entryPoints: [join(root, "web", "web.tsx")],
  outfile: join(out, "web.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  logLevel: "warning",
});
await cp(join(root, "web", "index.html"), join(out, "index.html"));
console.log(`built ${out}`);
