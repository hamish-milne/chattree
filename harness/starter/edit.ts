import type { Tool } from "../tools.ts";
import { versionOf } from "./version.ts";
import { display, resolveInWorkspace } from "./workspace.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * Edit by line number (docs/tools.md, 4.1). `read` numbers every line and gives the file's version; a change names lines
 * of the file as it was read, so nothing the model does earlier in the same call can shift them. Two shapes:
 *   replace lines `start`..`end` (inclusive) with `content` (empty content deletes them);
 *   insert `content` after line `after` (0 is the top of the file, the last line number appends).
 */
export interface Change {
  start?: number;
  end?: number;
  after?: number;
  content: string;
}

export class EditFailed extends Error {}

interface Line {
  text: string;
  /** The line's own terminator; empty on an unterminated last line. */
  eol: string;
}

const SHOWN = 6;
const clip = (s: string): string => (s.length > 100 ? `${s.slice(0, 97)}...` : s);

function splitLines(text: string): { lines: Line[]; finalNewline: boolean; eol: string } {
  if (text === "") return { lines: [], finalNewline: true, eol: "\n" };
  const finalNewline = text.endsWith("\n");
  const parts = text.split("\n");
  if (finalNewline) parts.pop();
  const lines = parts.map((p, k): Line => {
    const terminated = k < parts.length - 1 || finalNewline;
    if (!terminated) return { text: p, eol: "" };
    return p.endsWith("\r") ? { text: p.slice(0, -1), eol: "\r\n" } : { text: p, eol: "\n" };
  });
  return { lines, finalNewline, eol: lines.find((l) => l.eol !== "")?.eol ?? "\n" };
}

/** `content` as lines: empty means none; one trailing newline is ignored. */
function contentLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\r?\n$/, "").split(/\r?\n/);
}

const numbered = (rows: string[], first: number, sign: string): string[] => {
  const shown = rows.slice(0, SHOWN).map((t, i) => `${sign} ${first + i}\t${clip(t)}`);
  if (rows.length > SHOWN) shown.push(`${sign} ... ${rows.length - SHOWN} more line${rows.length - SHOWN === 1 ? "" : "s"}`);
  return shown;
};

/** Apply the changes to the text as one numbering, top to bottom. Returns the new text and a report of what happened, in the new numbering. */
export function applyChanges(original: string, changes: readonly Change[]): { text: string; report: string[]; lines: number } {
  const { lines, finalNewline, eol } = splitLines(original);
  const n = lines.length;
  const ops = changes.map((c, index) => {
    const where = `change ${index + 1}`;
    const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
    if (c.after !== undefined) {
      if (c.start !== undefined || c.end !== undefined) throw new EditFailed(`${where}: give either \`start\` and \`end\` (replace lines) or \`after\` (insert), not both`);
      if (!isInt(c.after) || c.after < 0 || c.after > n) throw new EditFailed(`${where}: \`after\` ${String(c.after)} is not between 0 and ${n} (the file has ${n} line${n === 1 ? "" : "s"}; 0 inserts at the top, ${n} appends)`);
      if (c.content === "") throw new EditFailed(`${where}: an insert needs \`content\``);
      return { index, key: c.after, end: c.after, kind: 0, c };
    }
    if (!isInt(c.start) || !isInt(c.end)) throw new EditFailed(`${where}: give \`start\` and \`end\` line numbers (to replace or delete lines), or \`after\` (to insert)`);
    if (c.start < 1 || c.end < c.start || c.end > n) throw new EditFailed(`${where}: lines ${c.start}-${c.end} are not within the file's ${n} line${n === 1 ? "" : "s"} (start must be at least 1 and end at least start)${n === 0 ? "; the file is empty, so use \`after\`: 0 to add text" : ""}`);
    return { index, key: c.start - 1, end: c.end, kind: 1, c };
  });
  ops.sort((a, b) => a.key - b.key || a.kind - b.kind || a.index - b.index);

  const out: Line[] = [];
  const report: string[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.key < i) throw new EditFailed(`change ${op.index + 1} overlaps another change (lines are numbered as they were read, and each line may be changed once per call)`);
    out.push(...lines.slice(i, op.key));
    const added = contentLines(op.c.content);
    const first = out.length + 1;
    const removed = op.kind === 1 ? lines.slice(op.key, op.end).map((l) => l.text) : [];
    for (const t of added) out.push({ text: t, eol: "" });
    i = op.kind === 1 ? op.end : op.key;
    const head =
      op.kind === 0
        ? `change ${op.index + 1}: inserted ${added.length} line${added.length === 1 ? "" : "s"} after line ${op.c.after}; now lines ${first}-${first + added.length - 1}`
        : added.length === 0
          ? `change ${op.index + 1}: deleted lines ${op.c.start}-${op.c.end}; line ${first} is now what followed them`
          : `change ${op.index + 1}: replaced lines ${op.c.start}-${op.c.end} with ${added.length} line${added.length === 1 ? "" : "s"}; now lines ${first}-${first + added.length - 1}`;
    report.push([head, ...numbered(removed, op.c.start ?? 0, "-"), ...numbered(added, first, "+")].join("\n"));
  }
  out.push(...lines.slice(i));
  const text = out.map((l, k) => l.text + (k === out.length - 1 && !finalNewline ? "" : l.eol === "" ? eol : l.eol)).join("");
  return { text, report, lines: out.length };
}

interface FileEdit {
  path: string;
  version: string;
  changes: Change[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CHANGE_KEYS = ["start", "end", "after", "content"];

/**
 * The slips models make with the nesting, each with one possible meaning: a single file's `{path, version, changes}` without
 * the `files` list; a change's fields written directly on the file; a `version` or `path` repeated inside a change.
 */
export function normalizeEdit(args: unknown): unknown {
  if (!isObj(args)) return args;
  let files: unknown = args["files"];
  if (files === undefined && ("changes" in args || "path" in args)) files = [args];
  const list = Array.isArray(files) ? files : isObj(files) ? [files] : undefined;
  if (list === undefined) return args;
  return {
    files: list.map((f) => {
      if (!isObj(f)) return f;
      const file: Record<string, unknown> = { ...f };
      if (file["changes"] === undefined && CHANGE_KEYS.some((k) => k in file)) {
        const change: Record<string, unknown> = {};
        for (const k of CHANGE_KEYS) if (k in file) change[k] = file[k];
        for (const k of CHANGE_KEYS) delete file[k];
        file["changes"] = [change];
      }
      const changes = file["changes"];
      if (Array.isArray(changes)) {
        file["changes"] = changes.map((c) => {
          if (!isObj(c)) return c;
          const change = { ...c };
          if ("version" in change) {
            if (file["version"] === undefined) file["version"] = change["version"];
            delete change["version"];
          }
          if ("path" in change) {
            if (file["path"] === undefined) file["path"] = change["path"];
            if (change["path"] === file["path"]) delete change["path"];
          }
          return change;
        });
      }
      return file;
    }),
  };
}

export function editTool(): Tool {
  return {
    normalize: normalizeEdit,
    definition: {
      name: "edit",
      description:
        "Change lines of existing files, using the line numbers and the `version` that read shows (read the file first; the numbers are only valid for that version). Each change is either `start` and `end` (inclusive line numbers) with `content` replacing those lines (empty `content` deletes them), or `after` with `content` inserted after that line (0 is the top, the last line number appends). `content` is the new lines as plain text, without line numbers. All changes to a file in one call use the numbering you read, so do not adjust for earlier changes; they must not overlap. Whole files are applied or not at all. The result shows what was removed and added, with the new line numbers and the new version. To create a file or rewrite one entirely, use write.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["files"],
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "The files to change, in order.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "version", "changes"],
              properties: {
                path: { type: "string", description: "Path relative to the workspace root." },
                version: { type: "string", description: "The file's version: the 8 hex digits after `version` in its header from read." },
                changes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 100,
                  description: "The changes, numbered as the file was read.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["content"],
                    properties: {
                      start: { type: "integer", minimum: 1, description: "First line to replace." },
                      end: { type: "integer", minimum: 1, description: "Last line to replace (inclusive)." },
                      after: { type: "integer", minimum: 0, description: "Insert after this line instead of replacing." },
                      content: { type: "string", description: "The new text; empty to delete the lines." },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const files = args["files"] as FileEdit[];
      const lines: string[] = [];
      for (const [i, f] of files.entries()) {
        try {
          const abs = await resolveInWorkspace(host, workspace, f.path, "write");
          const name = display(host, workspace, abs);
          const st = await host.fs.stat(abs);
          if (st === undefined) throw new EditFailed(`${name} does not exist (use write to create it)`);
          if (st.isDirectory) throw new EditFailed(`${name} is a directory`);
          const bytes = await host.fs.read(abs);
          let original: string;
          try {
            original = dec.decode(bytes);
          } catch {
            throw new EditFailed(`${name} is not UTF-8 text`);
          }
          const now = await versionOf(bytes);
          // Models copy the header loosely ("version 1f08cd1f", "v 1f08cd1f"): what counts is the 8 hex digits.
          const given = /[0-9a-f]{8}/i.exec(f.version)?.[0]?.toLowerCase();
          if (given === undefined) throw new EditFailed(`\`version\` must be the 8 hex digits that read shows after "version" (the file is at ${now} now)`);
          if (given !== now) throw new EditFailed(`${name} has changed since you read it (you gave ${given}, it is at ${now} now); read it again and use its numbers`);
          const out = applyChanges(original, f.changes);
          const written = enc.encode(out.text);
          await host.fs.writeAtomic(abs, written, { keepMode: true });
          lines.push(`edited ${name} (now ${out.lines} line${out.lines === 1 ? "" : "s"}, version ${await versionOf(written)})`, ...out.report);
        } catch (err) {
          if (!(err instanceof EditFailed) && !(err instanceof Error && err.name === "PathRefused")) throw err;
          const rest = files.length - i - 1;
          lines.push(`failed: ${f.path}: ${err.message}; nothing in it was changed${rest > 0 ? `; the other ${rest} file${rest === 1 ? " was" : "s were"} not edited` : ""}`);
          return { content: lines.join("\n"), is_error: true };
        }
      }
      return { content: lines.join("\n") };
    },
  };
}
