import type { GeminiRow } from "../gemini.ts";
import type { GoApi, GoRow } from "../opencode-go.ts";

/**
 * The pure half of `npm run catalog` (scripts/catalog.ts): turning what a provider's model list says into the snapshot rows, and the
 * rows into source text. Nothing here touches the network.
 *
 * The OpenCode Go parser was written from a description of the list's fields (the sandbox it was written in could not fetch the JSON
 * itself), so it looks for each field under the names and nestings that were described and fails loudly, naming the field and the keys
 * it did find, when one is missing. If it does, run `npm run catalog -- opencode-go --dump`, and fix `FIELDS` or send the output.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function dig(o: unknown, path: string): unknown {
  let at: unknown = o;
  for (const k of path.split(".")) {
    if (!isObj(at)) return undefined;
    at = at[k];
  }
  return at;
}
const first = (o: unknown, paths: readonly string[]): unknown => paths.map((p) => dig(o, p)).find((v) => v !== undefined);

/** Where each field may be in an entry of the OpenCode list: the first path that exists wins. */
export const FIELDS = {
  name: ["name"],
  api: ["api.type", "api.style", "api.name", "api.kind", "api"],
  context: ["limit.context", "limits.context", "context"],
  output: ["limit.output", "limits.output", "output_limit"],
  input_limit: ["limit.input", "limits.input"],
  input: ["cost.input", "pricing.input", "price.input"],
  price_output: ["cost.output", "pricing.output", "price.output"],
  cache_read: ["cost.cache_read", "pricing.cache_read", "price.cache_read"],
  cache_write: ["cost.cache_write", "pricing.cache_write", "price.cache_write"],
  efforts: ["reasoning.effort", "reasoning.efforts", "reasoning.levels"],
  input_modalities: ["modalities.input", "input"],
  open_weights: ["open_weights"],
} as const;

const API_NAMES: Record<string, GoApi> = { "chat-completions": "chat-completions", chat: "chat-completions", responses: "responses", messages: "messages", "generate-content": "generate-content" };

export class CatalogShapeError extends Error {
  override name = "CatalogShapeError";
}

/** Rows from the body of `GET /inference/go/v1/models`. `previous` supplies what the list does not give in a form this reads (the long-context bands). */
export function parseOpencodeList(body: unknown, previous: readonly GoRow[] = []): GoRow[] {
  const data = dig(body, "data");
  if (!Array.isArray(data)) throw new CatalogShapeError(`expected {data: [...]}, found keys: ${isObj(body) ? Object.keys(body).join(", ") : typeof body}`);
  const before = new Map(previous.map((r) => [r.id, r]));
  const rows: GoRow[] = [];
  for (const e of data) {
    const id = isObj(e) ? e["id"] : undefined;
    if (typeof id !== "string") throw new CatalogShapeError(`an entry has no string id (keys: ${isObj(e) ? Object.keys(e).join(", ") : typeof e})`);
    const need = <T>(field: keyof typeof FIELDS, ok: (v: unknown) => v is T): T => {
      const v = first(e, FIELDS[field]);
      if (!ok(v)) throw new CatalogShapeError(`${id}: no usable "${field}" at any of ${FIELDS[field].join(", ")} (entry keys: ${isObj(e) ? Object.keys(e).join(", ") : "?"})`);
      return v;
    };
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const str = (v: unknown): v is string => typeof v === "string" && v !== "";
    const apiRaw = need("api", str);
    const api = API_NAMES[apiRaw];
    if (api === undefined) throw new CatalogShapeError(`${id}: the API style ${JSON.stringify(apiRaw)} is not one of ${Object.keys(API_NAMES).join(", ")}`);
    const optional = (field: keyof typeof FIELDS): number | undefined => {
      const v = first(e, FIELDS[field]);
      return num(v) ? v : undefined;
    };
    const efforts = first(e, FIELDS.efforts);
    const mods = first(e, FIELDS.input_modalities);
    const inputLimit = optional("input_limit");
    const cacheRead = optional("cache_read");
    const cacheWrite = optional("cache_write");
    const old = before.get(id)?.long;
    rows.push({
      id,
      name: need("name", str),
      api,
      context: need("context", num),
      output: need("output", num),
      ...(inputLimit === undefined ? {} : { input_limit: inputLimit }),
      price: { input: need("input", num), output: need("price_output", num), ...(cacheRead === undefined ? {} : { cache_read: cacheRead }), ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }) },
      ...(old === undefined ? {} : { long: old }),
      efforts: Array.isArray(efforts) ? efforts.filter((x): x is string => typeof x === "string") : [],
      images: Array.isArray(mods) && mods.includes("image"),
      open_weights: first(e, FIELDS.open_weights) === true,
    });
  }
  return rows;
}

/** Fill the token limits of known Gemini models from `GET /v1beta/models`, and say which chat models the list has that the rows do not. */
export function applyGeminiLimits(body: unknown, rows: readonly GeminiRow[]): { rows: GeminiRow[]; unknown: string[] } {
  const models = dig(body, "models");
  if (!Array.isArray(models)) throw new CatalogShapeError(`expected {models: [...]}, found keys: ${isObj(body) ? Object.keys(body).join(", ") : typeof body}`);
  const byId = new Map<string, Json>();
  for (const m of models) if (isObj(m) && typeof m["name"] === "string") byId.set(m["name"].replace(/^models\//, ""), m);
  const known = new Set(rows.map((r) => r.id));
  const unknown = [...byId.entries()].filter(([id, m]) => id.startsWith("gemini-") && !known.has(id) && Array.isArray(m["supportedGenerationMethods"]) && m["supportedGenerationMethods"].includes("generateContent")).map(([id]) => id);
  return {
    rows: rows.map((r) => {
      const m = byId.get(r.id);
      const context = m?.["inputTokenLimit"];
      const output = m?.["outputTokenLimit"];
      return { ...r, ...(typeof context === "number" ? { context } : {}), ...(typeof output === "number" ? { output } : {}) };
    }),
    unknown: unknown.sort(),
  };
}

const fields = (o: Record<string, unknown>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : isObj(v) ? `{ ${fields(v)} }` : JSON.stringify(v)}`)
    .join(", ");

/** The source of a rows file: a header comment, one line per row. */
export function renderRows(rows: readonly (GoRow | GeminiRow)[], head: { comment: string; type: "GoRow" | "GeminiRow"; from: string; name: string }): string {
  return `import type { ${head.type} } from "${head.from}";\n\n${head.comment}\nexport const ${head.name}: readonly ${head.type}[] = [\n${rows.map((r) => `  { ${fields(r as unknown as Record<string, unknown>)} },`).join("\n")}\n];\n`;
}
