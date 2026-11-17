/**
 * Normalises the arguments of read, write and edit before validation. Models sometimes send the older nested shape with a
 * single item (`files: [{path, changes: [{...}]}]`, `files: ["a.txt"]`) or another name for the same field (`file` for
 * `path`). Those are flattened to the canonical shape. Anything with several files or changes is left unchanged so that
 * validation refuses it, rather than guessing which one was meant.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const WRAPPERS = ["files", "paths", "changes"];

export function flattenArgs(args: unknown, aliases: Record<string, readonly string[]>): unknown {
  if (!isObj(args)) return args;
  let out: Record<string, unknown> = { ...args };
  for (const w of WRAPPERS) {
    const v = out[w];
    if (v === undefined) continue;
    const one: unknown = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
    if (isObj(one)) {
      delete out[w];
      // Fields given at the top level win over the same fields inside the wrapper.
      out = { ...one, ...out };
    } else if (typeof one === "string" && w !== "changes" && !("path" in out)) {
      delete out[w];
      out["path"] = one;
    }
  }
  for (const [canonical, names] of Object.entries(aliases)) {
    if (canonical in out) continue;
    const found = names.find((n) => n in out);
    if (found !== undefined) {
      out[canonical] = out[found];
      delete out[found];
    }
  }
  return out;
}

/** Names a model has used for `path`, besides `path` itself. */
export const PATH_ALIASES = ["file", "file_path", "filepath", "filename", "file_name"] as const;
