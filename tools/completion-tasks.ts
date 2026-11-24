/**
 * Tasks for `tools/completion-bench.ts`, made from the files of a repository: a place in a file is chosen, the text from there is taken out
 * as the answer, and what is left before and after it is the question. Pure and seeded, so the same files and seed give the same tasks.
 *
 * Three kinds, from the usual shapes of completion: `line` (the cursor at the start of a line's code, the answer the rest of the line),
 * `mid-line` (after an opening bracket, an equals sign or a comma, the answer the rest of the line) and `block` (the cursor at the start
 * of the body of a function or a branch, the answer the body).
 */
import type { ContextFile } from "../providers/completion/index.ts";

export interface SourceFile {
  path: string;
  text: string;
}

export type FimKind = "line" | "mid-line" | "block";
export const FIM_KINDS: readonly FimKind[] = ["line", "mid-line", "block"];

export interface FimTask {
  id: string;
  path: string;
  kind: FimKind;
  prefix: string;
  suffix: string;
  /** What was taken out. */
  expected: string;
  /** Other files that look related, the most relevant last. */
  context: ContextFile[];
}

export interface TaskOptions {
  seed: number;
  /** Tasks of each kind to make (fewer if the files have no more places of that kind). */
  perKind: number;
  kinds?: readonly FimKind[] | undefined;
  /** How much of the file around the cursor is the question (default 3000 before, 1500 after). */
  prefixChars?: number | undefined;
  suffixChars?: number | undefined;
  /** Other files given as context: how many and how much of each (default 3 and 1500). */
  contextFiles?: number | undefined;
  contextChars?: number | undefined;
}

/** A small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const COMMENT = /^(\/\/|#|\*|\/\*|--|;;|"""|''')/;
const indentOf = (line: string): number => line.length - line.trimStart().length;
const isCode = (line: string): boolean => line.trim() !== "" && !COMMENT.test(line.trim());

interface Place {
  kind: FimKind;
  /** Where the cursor is, and where the answer ends, as offsets into the file. */
  start: number;
  end: number;
}

/** The places of each kind that a file has. */
export function placesIn(text: string): Place[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  const places: Place[] = [];
  for (let i = 3; i < lines.length - 1; i++) {
    const line = lines[i] as string;
    if (!isCode(line)) continue;
    const at = starts[i] as number;
    const trimmed = line.trim();
    const lineEnd = at + line.length;
    if (trimmed.length >= 15) places.push({ kind: "line", start: at + indentOf(line), end: lineEnd });
    const open = /[(=,{]/.exec(line.slice(indentOf(line)));
    if (open !== null) {
      let j = indentOf(line) + open.index + 1;
      if (line[j] === " ") j++;
      if (line.length - j >= 6) places.push({ kind: "mid-line", start: at + j, end: lineEnd });
    }
    // The start of a body: the line before it ends with an opening brace or a colon, and the body is indented more.
    if (/[{:]\s*$/.test(line)) {
      const base = indentOf(line);
      let k = i + 1;
      let lastCode = -1;
      while (k < lines.length && (lines[k]?.trim() === "" || indentOf(lines[k] as string) > base)) {
        if (lines[k]?.trim() !== "") lastCode = k;
        k++;
      }
      const body = lastCode - i;
      if (lastCode > 0 && body >= 2 && body <= 12 && k < lines.length)
        places.push({ kind: "block", start: starts[i + 1] as number, end: starts[lastCode + 1] as number });
    }
  }
  return places;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const identifiers = (text: string): Set<string> => new Set(text.match(IDENT) ?? []);
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The files that look most related to the cursor: the same folder counts for most, then the names they share with the code just before it. */
export function rankContext(
  target: SourceFile,
  before: string,
  others: readonly SourceFile[],
  count: number,
  chars: number,
): ContextFile[] {
  const near = identifiers(before.split("\n").slice(-40).join("\n"));
  const scored = others
    .filter((f) => f.path !== target.path)
    .map((f) => {
      let shared = 0;
      for (const id of identifiers(f.text)) if (near.has(id)) shared++;
      return { f, score: (dirOf(f.path) === dirOf(target.path) ? 5 : 0) + Math.min(shared, 20) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.f.path < b.f.path ? -1 : 1))
    .slice(0, count);
  return scored.reverse().map(({ f }) => ({ path: f.path, text: f.text.slice(0, chars) }));
}

/** The question and the answer for a place in a file, with the window of text kept around the cursor. */
function windowed(
  text: string,
  p: Place,
  o: { prefixChars: number; suffixChars: number },
): { prefix: string; suffix: string; expected: string } {
  let prefix = text.slice(0, p.start);
  if (prefix.length > o.prefixChars) {
    prefix = prefix.slice(prefix.length - o.prefixChars);
    // Start at a line, so the model is not shown half of one.
    const nl = prefix.indexOf("\n");
    if (nl >= 0) prefix = prefix.slice(nl + 1);
  }
  let suffix = text.slice(p.end);
  if (suffix.length > o.suffixChars) {
    suffix = suffix.slice(0, o.suffixChars);
    const nl = suffix.lastIndexOf("\n");
    if (nl >= 0) suffix = suffix.slice(0, nl + 1);
  }
  return { prefix, suffix, expected: text.slice(p.start, p.end) };
}

/** Make the tasks: files in a seeded order, one place of each kind from a file until there are enough. */
export function planFimTasks(files: readonly SourceFile[], o: TaskOptions): FimTask[] {
  const next = rng(o.seed);
  const kinds = o.kinds ?? FIM_KINDS;
  const win = { prefixChars: o.prefixChars ?? 3000, suffixChars: o.suffixChars ?? 1500 };
  const made = new Map<FimKind, number>(kinds.map((k) => [k, 0]));
  const tasks: FimTask[] = [];
  for (const file of shuffle(files, next)) {
    const places = placesIn(file.text);
    for (const kind of kinds) {
      if ((made.get(kind) ?? 0) >= o.perKind) continue;
      const mine = places.filter((p) => p.kind === kind);
      const p = mine[Math.floor(next() * mine.length)];
      if (p === undefined) continue;
      const w = windowed(file.text, p, win);
      if (w.expected.trim() === "") continue;
      made.set(kind, (made.get(kind) ?? 0) + 1);
      tasks.push({
        id: `${kind}:${file.path}:${p.start}`,
        path: file.path,
        kind,
        ...w,
        context: rankContext(file, w.prefix, files, o.contextFiles ?? 3, o.contextChars ?? 1500),
      });
    }
    if (kinds.every((k) => (made.get(k) ?? 0) >= o.perKind)) break;
  }
  return tasks;
}
