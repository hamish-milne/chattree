import type { Tool } from "../tools.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { runTool, scriptTool, type RunToolOptions } from "./run.ts";
import { writeTool } from "./write.ts";

export { PathRefused, resolveInWorkspace } from "./workspace.ts";
export { expandGlob, GlobError } from "./glob.ts";
export { applyChanges, EditFailed, type Change } from "./edit.ts";
export { versionOf } from "./version.ts";
export { expandEnv, SECRET_ENV_PATTERN, type RunToolOptions } from "./run.ts";

/** The leaf tools: read, write, edit, run, script (docs/tools.md, 4.1). The meta tools come with the loop's later steps. */
export function leafTools(opts: RunToolOptions = {}): Tool[] {
  return [readTool(), writeTool(), editTool(), runTool(opts), scriptTool(opts)];
}
