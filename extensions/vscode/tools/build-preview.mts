/**
 * Bundles the browser preview into `dist/preview/`: the page, its script and its styles. The same bundler will build
 * the extension's webviews, so a view that works here works in VS Code.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env["PREVIEW_OUT"] ?? join(root, "dist", "preview");
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, "preview", "preview.tsx")],
  outfile: join(out, "preview.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  logLevel: "info",
});

// One stylesheet: the theme variables, the frame, then each view's own.
const css = [
  "preview/themes.css",
  "preview/preview.css",
  "webview/base.css",
  "webview/form/form.css",
  "webview/graph/graph.css",
  "webview/chat/chat.css",
];
await writeFile(join(out, "preview.css"), (await Promise.all(css.map((f) => readFile(join(root, f), "utf8")))).join("\n"));
await cp(join(root, "preview", "index.html"), join(out, "index.html"));
console.log(`built ${out}`);
