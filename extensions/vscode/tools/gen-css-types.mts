/**
 * Writes `x.module.css.d.ts` beside every `x.module.css` under `webview/` and `preview/`.
 *   node tools/gen-css-types.mts           write what is out of date
 *   node tools/gen-css-types.mts --check   fail if anything is out of date (used by a test)
 *   node tools/gen-css-types.mts --watch   keep them current while editing (part of `pnpm dev`)
 */
import { existsSync, readFileSync, watch, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { declarationFor } from "./css-classes.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = ["webview", "preview"].map((d) => join(root, d));

function modules(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...modules(p));
    else if (name.endsWith(".module.css")) out.push(p);
  }
  return out;
}

/** Bring one module's declaration up to date; true if it changed. */
function sync(css: string, write: boolean): boolean {
  const dts = `${css}.d.ts`;
  const want = declarationFor(basename(css), readFileSync(css, "utf8"));
  if (existsSync(dts) && readFileSync(dts, "utf8") === want) return false;
  if (write) writeFileSync(dts, want);
  return true;
}

/** Declarations whose stylesheet is gone. */
function orphans(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".module.css.d.ts") && !existsSync(p.slice(0, -".d.ts".length))) out.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

const mode = process.argv[2];
const all = dirs.flatMap(modules);
if (mode === "--check") {
  const stale = [...all.filter((f) => sync(f, false)), ...orphans()];
  if (stale.length > 0) {
    console.error(`out of date (run \`node tools/gen-css-types.mts\`):\n${stale.map((f) => `  ${relative(root, f)}`).join("\n")}`);
    process.exit(1);
  }
} else {
  for (const f of all) if (sync(f, true)) console.log(`wrote ${relative(root, f)}.d.ts`);
  for (const o of orphans()) {
    unlinkSync(o);
    console.log(`removed ${relative(root, o)}`);
  }
  if (mode === "--watch") {
    console.log("watching for stylesheet changes");
    let timer: NodeJS.Timeout | undefined;
    for (const d of dirs)
      watch(d, { recursive: true }, (_e, name) => {
        if (name === null || !name.endsWith(".module.css")) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          for (const f of dirs.flatMap(modules)) if (sync(f, true)) console.log(`wrote ${relative(root, f)}.d.ts`);
          for (const o of orphans()) unlinkSync(o);
        }, 50);
      });
  }
}
