import type { Tool } from "../tools.ts";
import { versionOf } from "./version.ts";
import { PATH_ALIASES, flattenArgs } from "./args.ts";
import { display, resolveInWorkspace } from "./workspace.ts";
import { ALL } from "../approvals.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * Edit by line number (docs/tools.md, 4.1). `read` numbers every line and gives the file's version; a change names lines
 * of the file as it was read. The tool takes one change per call (flat arguments: nested lists are shown to some models as
 * `any[]`); `applyChanges` still takes several, numbered as read. Two shapes:
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
  const done: { head: string; removed: string[]; removedFrom: number; added: string[]; first: number; delta: number }[] = [];
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
    done.push({ head, removed, removedFrom: op.c.start ?? 0, added, first, delta: added.length - removed.length });
  }
  out.push(...lines.slice(i));
  // The result shows each change and the line either side of it as the file is now, so a doubled brace or a lost blank line is visible.
  const report = done.map((d) => {
    const before = d.first >= 2 ? [`  ${d.first - 1}\t${clip(out[d.first - 2]?.text ?? "")}`] : [];
    const afterAt = d.first + d.added.length;
    const after = afterAt <= out.length ? [`  ${afterAt}\t${clip(out[afterAt - 1]?.text ?? "")}`] : [];
    // Models forget that line numbers move after an edit: say so when lines follow the change.
    const moved = d.delta !== 0 && afterAt <= out.length ? `; the lines after it moved ${d.delta > 0 ? "down" : "up"} by ${Math.abs(d.delta)}` : "";
    return [d.head + moved, ...numbered(d.removed, d.removedFrom, "-"), ...before, ...numbered(d.added, d.first, "+"), ...after].join("\n");
  });
  const text = out.map((l, k) => l.text + (k === out.length - 1 && !finalNewline ? "" : l.eol === "" ? eol : l.eol)).join("");
  return { text, report, lines: out.length };
}

const CHANGE_ALIASES = { start: ["start_line", "line_start", "from", "from_line"], end: ["end_line", "line_end", "to", "to_line"], after: ["after_line", "insert_after"], content: ["contents", "text", "new_text", "replace_with", "replacement", "new_content"] } as const;

/** The flat arguments of edit: one file, one change (docs/tools.md, 4.1). The nested shapes with one item are repaired (args.ts). */
export function normalizeEdit(args: unknown): unknown {
  return flattenArgs(args, { path: PATH_ALIASES, ...CHANGE_ALIASES });
}

export function editTool(): Tool {
  return {
    normalize: normalizeEdit,
    definition: {
      name: "edit",
      description:
        "Change part of an existing file by line number. First read the file: read numbers every line and gives the file's `version` (8 hex digits). Then give `path`, `version` and one change: either `start` and `end` (inclusive line numbers) with `content` replacing those lines (leave `content` empty to delete them), or `after` with `content` inserting new lines after that line (`after` 0 is the top of the file; the last line number appends). `content` is plain text without line numbers. `start` and `end` replace the lines they name, blank lines included, so to add lines without removing any, use `after`. Lines outside start..end stay as they are, so do not repeat them in `content`. The result shows the change with the line either side of it, the file's new line numbers and its new version; for another change to the same file use that new version and those numbers (an edit moves the lines after it, and the result says by how much; working from the bottom of the file upwards keeps the earlier numbers valid). Example: `{\"path\": \"a.txt\", \"version\": \"1f08cd1f\", \"start\": 2, \"end\": 3, \"content\": \"new line two\"}`. To create a file or rewrite one entirely, use write.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "version"],
        properties: {
          path: { type: "string", description: "Path of the file, relative to the workspace root." },
          version: { type: "string", description: "The file's version: the 8 hex digits after `version` in the header that read (or an earlier edit or write) gave." },
          start: { type: "integer", minimum: 1, description: "First line to replace or delete. Use with `end`." },
          end: { type: "integer", minimum: 1, description: "Last line to replace or delete (inclusive). Defaults to `start`, so leave it out to change one line." },
          after: { type: "integer", minimum: 0, description: "Insert after this line number instead of replacing (0 is the top). Use instead of `start` and `end`." },
          content: { type: "string", description: "The new text for those lines, or the text to insert. Empty (or left out) when deleting lines." },
        },
      },
    },
    allowKeys: () => [ALL],
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const f = args as { path: string; version: string; start?: number; end?: number; after?: number; content?: string };
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
        const change: Change = { content: f.content ?? "" };
        if (f.start !== undefined) change.start = f.start;
        // A single line is the common case and models leave `end` out: it means the same line.
        if (f.end !== undefined) change.end = f.end;
        else if (f.start !== undefined && f.after === undefined) change.end = f.start;
        if (f.after !== undefined) change.after = f.after;
        const out = applyChanges(original, [change]);
        const written = enc.encode(out.text);
        await host.fs.writeAtomic(abs, written, { keepMode: true });
        return { content: [`edited ${name} (now ${out.lines} line${out.lines === 1 ? "" : "s"}, version ${await versionOf(written)})`, ...out.report].join("\n") };
      } catch (err) {
        if (!(err instanceof EditFailed) && !(err instanceof Error && err.name === "PathRefused")) throw err;
        return { content: `failed: ${f.path}: ${err.message}; nothing in it was changed`, is_error: true };
      }
    },
  };
}
