import type { Host } from "../../src/host.ts";

/**
 * The workspace boundary (docs/tools.md, section 5): every path a tool is given is resolved against the thread's
 * worktree, symbolic links included, and refused if it lands outside it or on something that is the conversation
 * itself. The refusal text goes back to the model as the tool's error.
 */

export class PathRefused extends Error {
  override name = "PathRefused";
}

export type PathMode = "read" | "write";

/** Written by the harness, never by the model: the transcript, the configuration, git's own files and local state. */
const NO_WRITE = ["chat.yml", "harness.yml", ".git", ".chattree", "blobs"];
/** Not even readable: git internals and local secrets. */
const NO_READ = [".git", ".chattree"];

const within = (rel: string): boolean => rel === "" || (rel !== ".." && !rel.startsWith("../"));

/**
 * The absolute path for `requested` (relative to the workspace, or absolute inside it). Throws `PathRefused`.
 * A path that does not exist yet is checked through its nearest existing parent, so a new file cannot be created
 * through a link that leads out.
 */
export async function resolveInWorkspace(host: Host, workspace: string, requested: string, mode: PathMode): Promise<string> {
  if (requested.trim() === "") throw new PathRefused("the path is empty");
  if (requested.includes("\0")) throw new PathRefused("the path contains a NUL character");
  const root = (await host.fs.realpath(workspace)) ?? host.path.resolve(workspace);
  const abs = host.path.resolve(root, requested);
  // Resolve links in the part that exists; what does not exist yet cannot be a link.
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    const real = await host.fs.realpath(existing);
    if (real !== undefined) {
      existing = real;
      break;
    }
    const parent = host.path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  const real = host.path.resolve(existing, ...rest);
  const rel = host.path.relative(root, real).replaceAll("\\", "/");
  if (!within(rel) || host.path.isAbsolute(rel)) throw new PathRefused(`${requested} is outside the workspace`);
  const first = (rel.split("/")[0] ?? "").toLowerCase();
  const blocked = mode === "write" ? NO_WRITE : NO_READ;
  if (rel !== "" && blocked.includes(first)) {
    throw new PathRefused(mode === "write" ? `${requested} is part of the conversation or its configuration and cannot be written` : `${requested} cannot be read`);
  }
  return real;
}

/** The path as shown to the model: relative to the workspace when it is inside it. */
export function display(host: Host, workspace: string, abs: string): string {
  const rel = host.path.relative(workspace, abs).replaceAll("\\", "/");
  return rel === "" ? "." : rel.startsWith("..") ? abs : rel;
}
