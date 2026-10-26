/**
 * Slips with one possible meaning in the flat arguments of read, write and edit (docs/tools.md, 4.1): the old nested shape
 * with one item (`files: [{path, changes: [{...}]}]`, `files: ["a.txt"]`), and a different name for the same thing
 * (`file` for `path`, `contents` for `content`). Anything with several files or changes is left for validation to refuse.
 */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const WRAPPERS = ["files", "paths", "changes"];

export function flattenArgs(args: unknown, aliases: Record<string, readonly string[]>): unknown {
  if (!isObj(args)) return args;
  let out: Record<string, unknown> = { ...args };
  for (const w of WRAPPERS) {
    const v = out[w];
    if (v === undefined) continue;
    const one = Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;
    if (isObj(one)) {
      delete out[w];
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

export const PATH_ALIASES = ["file", "file_path", "filepath", "filename", "file_name"] as const;
