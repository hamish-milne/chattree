/**
 * Bundles the browser preview into `dist/preview/`: the page, its script and its styles. The same bundler will build
 * the extension's webviews, so a view that works here works in VS Code.
 */
import { context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env["PREVIEW_OUT"] ?? join(root, "dist", "preview");
await mkdir(out, { recursive: true });
// Declarations for the CSS modules are part of building, so a stale one cannot reach the type check or the bundle.
await import("./gen-css-types.mts");

const ctx = await context({
  // Class names in `*.module.css` are renamed per file (`graph_row`); the types for them are generated beside them.
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

const watching = process.argv[2] === "--watch";
if (watching) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}

// The stylesheet is what the entry imports: theme variables, the frame and the shared styles, then each view's module.
await cp(join(root, "preview", "index.html"), join(out, "index.html"));
console.log(`built ${out}`);
