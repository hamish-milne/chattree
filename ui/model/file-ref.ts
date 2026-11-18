/**
 * A reference to a file in a model's text: a Markdown link whose target is a path relative to the thread's workspace,
 * with an optional line or range in the fragment (`src/net/retry.ts#L42-L58`, the form GitHub uses). Anything with a
 * scheme (`https:`), a bare fragment, or a path that starts outside the workspace is not a file reference.
 */

export interface FileRef {
  /** Relative to the workspace, with forward slashes. */
  path: string;
  line?: number;
  endLine?: number;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The file a link target names, or undefined when it names something else. */
export function parseFileRef(href: string): FileRef | undefined {
  const target = href.trim();
  if (target === "" || target.startsWith("#") || target.startsWith("//") || SCHEME.test(target)) return undefined;
  const hash = target.indexOf("#");
  const rawPath = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash + 1);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  path = path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  if (path === "" || path.startsWith("/") || /^[a-z]:\//i.test(path) || path.split("/").includes("..")) return undefined;
  const m = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
  const line = m?.[1] === undefined ? undefined : Number(m[1]);
  const end = m?.[2] === undefined ? undefined : Number(m[2]);
  return {
    path,
    ...(line === undefined || line < 1 ? {} : { line }),
    ...(line === undefined || end === undefined || end <= line ? {} : { endLine: end }),
  };
}

/** `src/a.ts`, `src/a.ts:42` or `src/a.ts:42-58`: the text to show for a reference. */
export const refLabel = (r: FileRef): string =>
  `${r.path}${r.line === undefined ? "" : `:${r.line}${r.endLine === undefined ? "" : `-${r.endLine}`}`}`;
