import { readFile, writeFile } from "node:fs/promises";
import { applyGeminiLimits, CatalogShapeError, parseOpencodeList, renderRows } from "../providers/catalog/refresh.ts";
import { GEMINI_ROWS } from "../providers/catalog/gemini-rows.ts";
import { OPENCODE_GO_ROWS } from "../providers/catalog/opencode-go-rows.ts";
import { OPENCODE_GO_BASE } from "../providers/opencode-go.ts";

/**
 * `npm run catalog -- opencode-go [--dump]` and `npm run catalog -- gemini`: refresh the bundled model snapshots from the providers'
 * model lists (a network call; `gemini` needs GEMINI_API_KEY). Review the diff before committing: prices for Gemini and the
 * long-context bands of OpenCode Go are not in these lists and stay as they were.
 */
const [which, ...flags] = process.argv.slice(2);
const root = new URL("../providers/catalog/", import.meta.url);

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": "chattree-catalog", ...headers } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function write(file: string, text: string): Promise<void> {
  await writeFile(new URL(file, root), text);
  console.log(`wrote providers/catalog/${file}`);
}

try {
  if (which === "opencode-go") {
    const body = await getJson(`${OPENCODE_GO_BASE}/v1/models`);
    if (flags.includes("--dump")) {
      console.log(JSON.stringify(body, null, 2));
    } else {
      const rows = parseOpencodeList(body, OPENCODE_GO_ROWS);
      const old = await readFile(new URL("opencode-go-rows.ts", root), "utf8");
      const comment = old.slice(old.indexOf("/**"), old.indexOf("*/") + 2).replace(/as of \d{4}-\d{2}-\d{2}/, `as of ${new Date().toISOString().slice(0, 10)}`);
      await write("opencode-go-rows.ts", renderRows(rows, { comment, type: "GoRow", from: "../opencode-go.ts", name: "OPENCODE_GO_ROWS" }));
      console.log(`${rows.length} models (was ${OPENCODE_GO_ROWS.length}). Update "as_of" in providers/opencode-go.ts too.`);
    }
  } else if (which === "gemini") {
    const key = process.env["GEMINI_API_KEY"];
    if (key === undefined || key === "") throw new Error("set GEMINI_API_KEY");
    const body = await getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": key });
    const { rows, unknown } = applyGeminiLimits(body, GEMINI_ROWS);
    const old = await readFile(new URL("gemini-rows.ts", root), "utf8");
    const comment = old.slice(old.indexOf("/**"), old.indexOf("*/") + 2);
    await write("gemini-rows.ts", renderRows(rows, { comment, type: "GeminiRow", from: "../gemini.ts", name: "GEMINI_ROWS" }));
    if (unknown.length > 0) console.log(`models in the list that have no row (add them, with prices, by hand): ${unknown.join(", ")}`);
  } else {
    console.error("usage: npm run catalog -- opencode-go [--dump] | gemini");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof CatalogShapeError ? `the list does not have the shape this expects:\n  ${e.message}\nRun with --dump to see it.` : `error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
