import type { Host } from "../../src/host.ts";

/**
 * A small glob over the host's file system, confined to the workspace. It supports `*`, `?`, `[abc]`, `[!a-z]`, `{a,b}`
 * and `**` (any number of directories), and follows the shell's dot rule: a wildcard never matches a name that
 * starts with a dot. It goes through `Host.fs`, so it works on whatever host the tools run on.
 */

export class GlobError extends Error {
  override name = "GlobError";
}

const MAX_VISITED = 20_000;
const MAX_DEPTH = 40;

export const hasGlob = (s: string): boolean => /[*?[{]/.test(s);

/** `a{b,c}d` becomes `abd` and `acd`; braces nest. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const inner = pattern.slice(open + 1, i);
        const parts: string[] = [];
        let level = 0;
        let from = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === "{") level++;
          else if (inner[j] === "}") level--;
          else if (inner[j] === "," && level === 0) {
            parts.push(inner.slice(from, j));
            from = j + 1;
          }
        }
        parts.push(inner.slice(from));
        if (parts.length === 1) break; // `{x}` is not a choice; leave it literal
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        return parts.flatMap((p) => expandBraces(head + p + tail));
      }
    }
  }
  return [pattern];
}

/** One path segment as a regular expression. */
function segmentRegex(seg: string): RegExp {
  let out = "^";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const close = seg.indexOf("]", i + 2);
      if (close === -1) out += "\\[";
      else {
        let body = seg.slice(i + 1, close);
        const neg = body.startsWith("!") || body.startsWith("^");
        if (neg) body = body.slice(1);
        out += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
        i = close;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

const dotOk = (pattern: string, name: string): boolean => !name.startsWith(".") || pattern.startsWith(".");

/** The workspace-relative paths matching `pattern` (files and directories), sorted. Throws `GlobError` for a pattern that leaves the workspace or matches too much to walk. */
export async function expandGlob(host: Host, workspace: string, pattern: string): Promise<string[]> {
  if (host.path.isAbsolute(pattern) || pattern.startsWith("/") || pattern.startsWith("\\")) throw new GlobError(`${pattern}: patterns are relative to the workspace`);
  const root = (await host.fs.realpath(workspace)) ?? workspace;
  const results = new Set<string>();
  let visited = 0;

  const inside = async (abs: string): Promise<boolean> => {
    const real = await host.fs.realpath(abs);
    if (real === undefined) return false;
    const rel = host.path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !host.path.isAbsolute(rel));
  };

  const walk = async (dirRel: string, segs: string[], depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const [seg, ...rest] = segs;
    if (seg === undefined) {
      results.add(dirRel);
      return;
    }
    const abs = host.path.join(root, dirRel);
    const join = (n: string): string => (dirRel === "" ? n : `${dirRel}/${n}`);
    if (seg === "**") {
      await walk(dirRel, rest, depth + 1); // zero directories
      let names: string[];
      try {
        names = await host.fs.readdir(abs);
      } catch {
        return;
      }
      for (const n of names.sort()) {
        if (n.startsWith(".") || ++visited > MAX_VISITED) {
          if (visited > MAX_VISITED) throw new GlobError(`${pattern}: matches too many files to search; make the pattern narrower`);
          continue;
        }
        const child = host.path.join(abs, n);
        if ((await host.fs.stat(child))?.isDirectory === true && (await inside(child))) await walk(join(n), segs, depth + 1);
      }
      return;
    }
    if (!hasGlob(seg)) {
      const child = host.path.join(abs, seg);
      const st = await host.fs.stat(child);
      if (st === undefined || !(await inside(child))) return;
      if (rest.length === 0) results.add(join(seg));
      else if (st.isDirectory) await walk(join(seg), rest, depth + 1);
      return;
    }
    let names: string[];
    try {
      names = await host.fs.readdir(abs);
    } catch {
      return;
    }
    const re = segmentRegex(seg);
    for (const n of names.sort()) {
      if (++visited > MAX_VISITED) throw new GlobError(`${pattern}: matches too many files to search; make the pattern narrower`);
      if (!dotOk(seg, n) || !re.test(n)) continue;
      const child = host.path.join(abs, n);
      if (!(await inside(child))) continue;
      if (rest.length === 0) results.add(join(n));
      else if ((await host.fs.stat(child))?.isDirectory === true) await walk(join(n), rest, depth + 1);
    }
  };

  for (const p of expandBraces(pattern)) {
    const segs = p.split("/").filter((s) => s !== "" && s !== ".");
    if (segs.includes("..")) throw new GlobError(`${pattern}: patterns cannot leave the workspace`);
    if (segs.length > 0) await walk("", segs, 0);
  }
  return [...results].sort();
}
