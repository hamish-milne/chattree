/**
 * The starter tools: the file and command tools a thread gets by default (read, mm_read, write, edit, run, script), plus the
 * helpers they share, re-exported so callers can import from this one file. Each tool receives the host and workspace in
 * its execute context, so the tools hold no state of their own.
 */
import type { Tool } from "../tools.ts";
import { editTool } from "./edit.ts";
import { mmReadTool } from "./mm-read.ts";
import { readTool } from "./read.ts";
import { runTool, scriptTool, type RunToolOptions } from "./run.ts";
import { writeTool } from "./write.ts";

export { PathRefused, resolveInWorkspace } from "./workspace.ts";
export { expandGlob, GlobError } from "./glob.ts";
export { parseCommand, CommandSyntax, type ParsedCommand, type Word } from "./command.ts";
export { BUSYBOX_APPLETS, portableStage, NotAvailable } from "./portable.ts";
export { applyChanges, EditFailed, type Change } from "./edit.ts";
export { mmReadTool, MM_READ_MAX_BYTES } from "./mm-read.ts";
export { versionOf } from "./version.ts";
export { expandEnv, SECRET_ENV_PATTERN, type RunToolOptions } from "./run.ts";

/**
 * The leaf tools: read, mm_read, write, edit, run, script. Only these are returned; the meta tools are not part of this list.
 * `mmRead` is passed to `read` as an option; it only changes the wording of `read`'s refusal of binary files, which points to
 * `mm_read` when that tool is offered.
 */
export function leafTools(opts: RunToolOptions = {}): Tool[] {
  return [readTool({ mmRead: opts.mmRead === true }), mmReadTool(), writeTool(), editTool(), runTool(opts), scriptTool(opts)];
}
