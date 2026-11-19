/**
 * Instruction files: files whose text the model is given as instructions (`AGENTS.md`, a team's conventions). The transcript
 * holds a map of canonical path to the hash of the content, which is in `blobs/` (`agent_setup.files`; `null` removes a path).
 * A relative path is a file of the repository: `changedFiles` reads it as it is now, and the conversation records a
 * new entry when it differs. An absolute path is a file the host passed in, which is only what it was when given.
 *
 * What the model sees is the text of every file in order of path, so the prefix is the same whatever order the files were
 * added in; a change after the first request is shown where it was made (like the instructions), until a rebuild folds it in.
 */
import { sha256Hex, type BlobStore } from "../src/index.ts";
import type { Host } from "../src/host.ts";
import type { ChatEntry } from "./entries.ts";
import type { Renderer } from "./renderer.ts";
import { applyFiles, foldSetup } from "./setup.ts";

export const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

export class InstructionFileError extends Error {
  override name = "InstructionFileError";
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const dec = new TextDecoder("utf-8", { fatal: true });
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a path names a file of the repository (relative) rather than one the host passed in. */
export const isRepoPath = (path: string): boolean => !ABSOLUTE.test(path);

/**
 * The one spelling of a path: forward slashes, no `.` segments, and a relative path never leaves the repository. The
 * same file always has the same key, so it cannot be in the map twice.
 */
export function canonicalInstructionPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  if (!isRepoPath(path)) return slashed.replace(/\/{2,}/g, "/").replace(/(?<=.)\/$/, "");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new InstructionFileError(`${path} is outside the repository`);
    parts.push(part);
  }
  if (parts.length === 0) throw new InstructionFileError("an instruction file needs a path");
  return parts.join("/");
}

/** The text of a file's bytes, refused when it is too large or not text. */
export function instructionText(path: string, bytes: Uint8Array): string {
  if (bytes.length > MAX_INSTRUCTION_FILE_BYTES)
    throw new InstructionFileError(`${path} is ${bytes.length} bytes: an instruction file can be at most ${MAX_INSTRUCTION_FILE_BYTES}`);
  try {
    return dec.decode(bytes);
  } catch {
    throw new InstructionFileError(`${path} is not text`);
  }
}

/**
 * The repository files among `files` whose content now differs from the hash: the new hash with its bytes, or `null` where the
 * file is gone. A file that cannot be used as instructions (too large, not text) is reported in `problems` and left as it was.
 */
export async function changedFiles(
  host: Host,
  dir: string,
  files: Readonly<Record<string, string>>,
): Promise<{ changes: Map<string, { hash: string; bytes: Uint8Array } | null>; problems: string[] }> {
  const changes = new Map<string, { hash: string; bytes: Uint8Array } | null>();
  const problems: string[] = [];
  for (const [path, hash] of Object.entries(files)) {
    if (!isRepoPath(path)) continue;
    const abs = host.path.join(dir, ...path.split("/"));
    if ((await host.fs.stat(abs)) === undefined) {
      changes.set(path, null);
      continue;
    }
    const bytes = await host.fs.read(abs);
    const now = await sha256Hex(bytes);
    if (now === hash) continue;
    try {
      instructionText(path, bytes);
      changes.set(path, { hash: now, bytes });
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { changes, problems };
}

/** The verified text of each file, in order of path. Throws when a blob is missing or does not match its hash. */
export async function loadInstructionFiles(
  files: Readonly<Record<string, string>>,
  blobs: Pick<BlobStore, "get">,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const path of Object.keys(files).sort(byPath)) {
    const hash = files[path];
    if (hash === undefined) continue;
    const bytes = await blobs.get(hash);
    if (bytes === undefined) throw new InstructionFileError(`${path} (${hash.slice(0, 12)}) is not in blobs/`);
    if ((await sha256Hex(bytes)) !== hash)
      throw new InstructionFileError(`${path}: the bytes do not match the recorded hash ${hash.slice(0, 12)}`);
    out.push({ path, text: instructionText(path, bytes) });
  }
  return out;
}

/** The instructions the prefix shows with the files after them, one segment each, in order of path. */
export function withFiles(
  render: Renderer,
  instructions: string | undefined,
  files: readonly { path: string; text: string }[],
): string | undefined {
  if (files.length === 0) return instructions;
  const text = render.instructionFiles(files);
  return instructions === undefined ? text : `${instructions}\n\n${text}`;
}

/** What the model is told about a change to the files, appended where it was made; `text` is undefined for a removed file. */
export interface FilesUpdate {
  files: { path: string; text: string | undefined; added: boolean }[];
}

/** For each `append` setup entry that changed files (see `pendingAppends`): the changed paths in order, with their new text. */
export async function fileUpdates(
  entries: readonly ChatEntry[],
  pending: readonly Extract<ChatEntry, { $tag: "agent_setup" }>[],
  blobs: Pick<BlobStore, "get">,
): Promise<Map<string, FilesUpdate>> {
  const out = new Map<string, FilesUpdate>();
  for (const e of pending) {
    if (e.files === undefined) continue;
    const before = foldSetup(entries.slice(0, entries.indexOf(e))).files;
    const after = applyFiles(before, e.files);
    const changed = e.files;
    const shown = await loadInstructionFiles(Object.fromEntries(Object.entries(after).filter(([p]) => p in changed)), blobs);
    const text = new Map(shown.map((f) => [f.path, f.text]));
    const files = Object.keys(changed)
      .sort(byPath)
      .map((path) => ({ path, text: text.get(path), added: before[path] === undefined }));
    out.set(e.id, { files });
  }
  return out;
}
