/**
 * How a tool call is shown in the chat. The built-in tools (read, edit, write, run, script) have a shape of their own,
 * worked out from their arguments and from the text of their result, which is the format the tools themselves write.
 * Any other tool, including one from an MCP server, gets the generic shape: its arguments and its result as text. This
 * is the part that has no drawing in it, so a view only chooses how each shape looks.
 */
import type { Block } from "./transcript.ts";

type Tool = Extract<Block, { type: "tool" }>;

/** One row of a diff or a listing: `+` added, `-` removed, space unchanged, `…` rows that are not shown. */
export interface DiffRow {
  sign: "+" | "-" | " " | "…";
  /** The line number, when the row is a line of a file. */
  n?: number;
  text: string;
}

/** One change to a file: what it did, in words, and the lines around it. */
export interface DiffHunk {
  head: string;
  rows: DiffRow[];
}

export type ToolView =
  | { kind: "edit"; path: string; line?: number; added: number; removed: number; note?: string; failed?: string; hunks: DiffHunk[] }
  | { kind: "write"; path: string; added: number; note?: string; failed?: string; rows: DiffRow[] }
  | { kind: "read"; path: string; line?: number; range?: string; version?: string; failed?: string; rows: DiffRow[] }
  | { kind: "run"; shell: "command" | "script"; command: string; exit?: number; output: string; failed: boolean }
  | { kind: "generic"; args: string; result?: { text: string; truncated: boolean }; failed: boolean };

/** Most rows of a file the view will list from arguments alone. */
const PREVIEW_ROWS = 200;

const parseArgs = (args: string): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(args);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : undefined;
  } catch {
    return undefined;
  }
};
const str = (a: Record<string, unknown>, k: string): string | undefined => (typeof a[k] === "string" ? a[k] : undefined);
const int = (a: Record<string, unknown>, k: string): number | undefined => {
  const v = a[k];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
};
const isSign = (x: string | undefined): x is "+" | "-" | " " => x === "+" || x === "-" || x === " ";

/** The line of the first change in a set of hunks, for a button that opens the file there. */
const firstChange = (hunks: DiffHunk[]): { line: number } | Record<string, never> => {
  for (const h of hunks) {
    const row = h.rows.find((r) => (r.sign === "+" || r.sign === "-") && r.n !== undefined);
    if (row?.n !== undefined) return { line: row.n };
  }
  return {};
};

/** The lines of text, without the one newline that ends it. */
const linesOf = (text: string): string[] => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));

/** `n\ttext` or `  n\ttext` as rows; anything else is kept as a row with no number. */
const ROW = /^([-+ ]) *(\d+)\t(.*)$/;
const ELIDED = /^([-+ ]) \.\.\. (.*)$/;

function editView(t: Tool, a: Record<string, unknown>): ToolView {
  const path = str(a, "path") ?? "";
  const failed = t.result !== undefined && t.status === "error" ? t.result.text : undefined;
  if (t.result === undefined || failed !== undefined) {
    // Before the result there is only what was asked for: the new lines, and the range they replace.
    const start = int(a, "start");
    const end = int(a, "end") ?? start;
    const after = int(a, "after");
    const content = linesOf(str(a, "content") ?? "");
    const first = after !== undefined ? after + 1 : (start ?? 1);
    const removed = after === undefined && start !== undefined && end !== undefined ? end - start + 1 : 0;
    const head =
      after !== undefined
        ? `insert after line ${after}`
        : content.length === 0
          ? `delete lines ${start ?? "?"}-${end ?? "?"}`
          : `replace lines ${start ?? "?"}-${end ?? "?"}`;
    const rows: DiffRow[] = content.slice(0, PREVIEW_ROWS).map((text, i) => ({ sign: "+", n: first + i, text }));
    if (content.length > PREVIEW_ROWS) rows.push({ sign: "…", text: `${content.length - PREVIEW_ROWS} more lines` });
    const hunks = [{ head, rows }];
    return {
      kind: "edit",
      path,
      ...firstChange(hunks),
      added: content.length,
      removed,
      hunks,
      ...(failed === undefined ? {} : { failed }),
    };
  }
  const lines = t.result.text.split("\n");
  const note = lines[0]?.startsWith("edited ") === true ? lines[0] : undefined;
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  for (const line of lines.slice(note === undefined ? 0 : 1)) {
    if (/^change \d+:/.test(line)) {
      hunks.push({ head: line.replace(/^change \d+: /, ""), rows: [] });
      continue;
    }
    const hunk = hunks.at(-1) ?? hunks[hunks.push({ head: "", rows: [] }) - 1];
    const r = ROW.exec(line);
    const e = ELIDED.exec(line);
    if (r !== null) {
      const sign = isSign(r[1]) ? r[1] : " ";
      if (sign === "+") added++;
      else if (sign === "-") removed++;
      hunk?.rows.push({ sign, n: Number(r[2]), text: r[3] ?? "" });
    } else if (e !== null) {
      const more = Number(/^(\d+) more/.exec(e[2] ?? "")?.[1] ?? 0);
      if (e[1] === "+") added += more;
      else if (e[1] === "-") removed += more;
      hunk?.rows.push({ sign: "…", text: e[2] ?? "" });
    }
  }
  return { kind: "edit", path, ...firstChange(hunks), added, removed, ...(note === undefined ? {} : { note }), hunks };
}

function writeView(t: Tool, a: Record<string, unknown>): ToolView {
  const content = linesOf(str(a, "content") ?? "");
  const rows: DiffRow[] = content.slice(0, PREVIEW_ROWS).map((text, i) => ({ sign: "+", n: i + 1, text }));
  if (content.length > PREVIEW_ROWS) rows.push({ sign: "…", text: `${content.length - PREVIEW_ROWS} more lines` });
  const failed = t.result !== undefined && t.status === "error" ? t.result.text : undefined;
  return {
    kind: "write",
    path: str(a, "path") ?? "",
    added: content.length,
    rows,
    ...(t.result === undefined || failed !== undefined ? {} : { note: t.result.text }),
    ...(failed === undefined ? {} : { failed }),
  };
}

function readView(t: Tool, a: Record<string, unknown>): ToolView {
  const path = str(a, "path") ?? "";
  if (t.result === undefined) return { kind: "read", path, rows: [] };
  if (t.status === "error") return { kind: "read", path, rows: [], failed: t.result.text };
  const lines = t.result.text.split("\n");
  const header = /^=== (.*?) \((.*)\) ===$/.exec(lines[0] ?? "");
  const version = /version ([0-9a-f]{8})/.exec(header?.[2] ?? "")?.[1];
  const range = header?.[2]?.replace(/,? ?version [0-9a-f]{8}/, "").trim();
  const rows: DiffRow[] = [];
  for (const line of lines.slice(header === null ? 0 : 1)) {
    const m = /^ *(\d+)\t(.*)$/.exec(line);
    if (m !== null) rows.push({ sign: " ", n: Number(m[1]), text: m[2] ?? "" });
    else if (line.startsWith("... ")) rows.push({ sign: "…", text: line.slice(4) });
    else if (line !== "") rows.push({ sign: " ", text: line });
  }
  const first = int(a, "offset");
  return {
    kind: "read",
    path,
    ...(first === undefined || first < 1 ? {} : { line: first }),
    ...(range === undefined || range === "" ? {} : { range }),
    ...(version === undefined ? {} : { version }),
    rows,
  };
}

function runView(t: Tool, a: Record<string, unknown>, shell: "command" | "script"): ToolView {
  const command = (shell === "script" ? str(a, "script") : str(a, "command")) ?? "";
  if (t.result === undefined) return { kind: "run", shell, command, output: "", failed: false };
  const m = /^exit (-?\d+)[^\n]*\n?/.exec(t.result.text);
  const exit = m === null ? undefined : Number(m[1]);
  return {
    kind: "run",
    shell,
    command,
    ...(exit === undefined ? {} : { exit }),
    output: m === null ? t.result.text : t.result.text.slice(m[0].length),
    failed: t.status === "error" || (exit !== undefined && exit !== 0),
  };
}

export function toolView(t: Tool): ToolView {
  const a = parseArgs(t.args);
  if (a !== undefined) {
    switch (t.name) {
      case "edit":
        return editView(t, a);
      case "write":
        return writeView(t, a);
      case "read":
        return readView(t, a);
      case "run":
        return runView(t, a, "command");
      case "script":
        return runView(t, a, "script");
    }
  }
  return {
    kind: "generic",
    args: t.args,
    ...(t.result === undefined ? {} : { result: { text: t.result.text, truncated: t.result.truncated } }),
    failed: t.status === "error",
  };
}
