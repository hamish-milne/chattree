/**
 * The tasks of `tools/exec-bench.ts`: small JavaScript modules (`tools/exec-suite/*.fn`) with tests, from which two kinds of task are made and
 * both are judged by running the result, not by comparing it with a reference text, since many different texts are right.
 *
 * - **fill-in-the-middle**: a span marked `⟦ ... ⟧` in the module is taken out, the model writes it again, and the module is run against the
 *   tests. A module with two marked spans makes two tasks (the other span is put back each time).
 * - **next edit**: the module as it was is the reference. The person has made the first part of a change (renamed a variable at its declaration, or
 *   changed a function's parameters or return value) and the rest of the module has not caught up, so it no longer works. The model is shown the
 *   change and the file and writes the lines again; the result must give the reference's outputs.
 *
 * A file starts with `//! key value` lines, which are not part of the module: `entry` (the function the tests call), `tests` (a JavaScript array of
 * argument lists), `rename OLD NEW` (any number: one task each), and for edits written by hand `change OLD ==> NEW` (what the person did first) and
 * `follow OLD ==> NEW` (what has to follow); `\n` in those is a line break. The expected outputs are not written down: they are what the
 * module gives with the spans in place, so the tests can only be wrong in what they cover, never in the figures.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RecentChange } from "../providers/completion/index.ts";

const run = promisify(execFile);
const RUNNER = new URL("./exec-runner.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const SUITE_DIR = new URL("./exec-suite/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export type Outcome =
  | { kind: "ok"; results: string[] }
  | { kind: "syntax"; message: string }
  | { kind: "timeout" }
  | { kind: "crash"; message: string };

/**
 * Run the module's tests: each result is the JSON of what the call returned, or `throws NAME`. Done in a child process that may not touch files or
 * start others (node's permission model), in a context that has no process or network, and under a time limit: enough for code a local model wrote
 * for a test, not a defence against code written to attack.
 */
export async function runTests(source: string, entry: string, tests: string, timeoutMs = 3000): Promise<Outcome> {
  const payload = JSON.stringify({ source, entry, tests, timeout: timeoutMs });
  try {
    const child = run(process.execPath, ["--permission", "--allow-fs-read=" + RUNNER, "--no-warnings", RUNNER], {
      timeout: timeoutMs + 5000,
      maxBuffer: 1024 * 1024,
    });
    child.child.stdin?.end(payload);
    const { stdout } = await child;
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Outcome;
  } catch (e) {
    return { kind: "crash", message: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export interface Hole {
  /** Where the span starts and ends in the reference. */
  start: number;
  end: number;
  text: string;
}

export interface Spec {
  id: string;
  entry: string;
  tests: string;
  /** The module with the spans in place and no markers. */
  reference: string;
  holes: Hole[];
  renames: [from: string, to: string][];
  change: [old: string, replacement: string][];
  follow: [old: string, replacement: string][];
}

const OPEN = "⟦";
const CLOSE = "⟧";

/** Take the markers out of a module's text, noting where each span was. */
export function parseHoles(source: string): { reference: string; holes: Hole[] } {
  let reference = "";
  const holes: Hole[] = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf(OPEN, at);
    if (open < 0) break;
    const close = source.indexOf(CLOSE, open);
    if (close < 0) throw new Error("a span is not closed");
    reference += source.slice(at, open);
    const text = source.slice(open + 1, close);
    holes.push({ start: reference.length, end: reference.length + text.length, text });
    reference += text;
    at = close + 1;
  }
  return { reference: reference + source.slice(at), holes };
}

const unescape = (s: string): string => s.replace(/\\n/g, "\n");
const pair = (v: string): [string, string] => {
  const i = v.indexOf(" ==> ");
  if (i < 0) throw new Error(`needs OLD ==> NEW: ${v}`);
  return [unescape(v.slice(0, i)), unescape(v.slice(i + 5))];
};

export function parseSpec(id: string, text: string): Spec {
  const header = new Map<string, string[]>();
  const body: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\/\/! (\w+) (.*)$/.exec(line);
    if (m === null) body.push(line);
    else header.set(m[1] as string, [...(header.get(m[1] as string) ?? []), m[2] as string]);
  }
  const one = (k: string): string => {
    const v = header.get(k)?.[0];
    if (v === undefined) throw new Error(`${id}: no ${k}`);
    return v;
  };
  const { reference, holes } = parseHoles(body.join("\n"));
  return {
    id,
    entry: one("entry"),
    tests: one("tests"),
    reference,
    holes,
    renames: (header.get("rename") ?? []).map((r) => {
      const [from, to] = r.split(" ");
      if (from === undefined || to === undefined) throw new Error(`${id}: rename needs two names`);
      return [from, to];
    }),
    change: (header.get("change") ?? []).map(pair),
    follow: (header.get("follow") ?? []).map(pair),
  };
}

export async function loadSuite(dir = SUITE_DIR): Promise<Spec[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".fn")).sort();
  return Promise.all(names.map(async (n) => parseSpec(n.slice(0, -3), await readFile(join(dir, n), "utf8"))));
}

// ---- fill-in-the-middle tasks -------------------------------------------------------------------------------------

export type ExecKind = "line" | "mid-line" | "block";

export interface ExecFimTask {
  id: string;
  spec: string;
  kind: ExecKind;
  path: string;
  prefix: string;
  suffix: string;
  /** What was taken out. */
  expected: string;
}

export function fimTasksOf(spec: Spec): ExecFimTask[] {
  return spec.holes.map((h, i) => {
    const prefix = spec.reference.slice(0, h.start);
    const lineStart = prefix.lastIndexOf("\n") + 1;
    const kind: ExecKind = h.text.includes("\n") ? "block" : prefix.slice(lineStart).trim() === "" ? "line" : "mid-line";
    return {
      id: `${spec.id}/fim${i + 1}`,
      spec: spec.id,
      kind,
      path: `${spec.id}.js`,
      prefix,
      suffix: spec.reference.slice(h.end),
      expected: h.text,
    };
  });
}

// ---- next-edit tasks ----------------------------------------------------------------------------------------------

export interface ExecEditTask {
  id: string;
  spec: string;
  kind: "rename" | "call-site";
  path: string;
  /** The module as the person has it, the first part of the change made. */
  stale: string;
  /** The module with the whole change made. */
  after: string;
  /** Just after what the person typed. */
  cursor: number;
  recent: RecentChange;
  /** Lines below the cursor's that the change reaches, and so how far the block the model rewrites has to go (at least 10, the usual). */
  linesAfter: number;
}

/** How many lines below the cursor's the last difference between the two texts is. */
function reach(stale: string, after: string, cursor: number): number {
  const a = stale.split("\n");
  const b = after.split("\n");
  const cursorLine = stale.slice(0, cursor).split("\n").length - 1;
  let last = cursorLine;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) last = Math.max(last, i);
  return Math.max(10, last - cursorLine + 1);
}

const isComment = (line: string): boolean => line.trimStart().startsWith("//");

/** The change between two texts as the next-edit models are shown it: the lines that differ, numbered in the new text. */
export function recentChangeOf(path: string, before: string, after: string): RecentChange {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {
    path,
    start: head + 1,
    end: Math.max(head + 1, b.length - tail),
    original: a.slice(head, a.length - tail).join("\n"),
    updated: b.slice(head, b.length - tail).join("\n"),
  };
}

function renameTask(spec: Spec, from: string, to: string): ExecEditTask {
  const re = new RegExp(`\\b${from}\\b`, "g");
  const lines = spec.reference.split("\n");
  let first = true;
  let cursor = -1;
  let offset = 0;
  const stale: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (isComment(line) || !re.test(line)) {
      stale.push(line);
      after.push(line);
    } else {
      re.lastIndex = 0;
      after.push(line.replace(re, to));
      if (first) {
        first = false;
        const m = re.exec(line);
        re.lastIndex = 0;
        const at = m?.index ?? 0;
        stale.push(line.slice(0, at) + to + line.slice(at + from.length));
        cursor = offset + at + to.length;
      } else stale.push(line);
    }
    offset += line.length + 1;
    re.lastIndex = 0;
  }
  if (cursor < 0) throw new Error(`${spec.id}: ${from} is not in the module`);
  const path = `${spec.id}.js`;
  const staleText = stale.join("\n");
  return {
    id: `${spec.id}/rename-${from}`,
    spec: spec.id,
    kind: "rename",
    path,
    stale: staleText,
    after: after.join("\n"),
    cursor,
    recent: recentChangeOf(path, spec.reference, staleText),
    linesAfter: reach(staleText, after.join("\n"), cursor),
  };
}

function once(text: string, old: string, replacement: string, id: string): string {
  const i = text.indexOf(old);
  if (i < 0 || text.indexOf(old, i + 1) >= 0) throw new Error(`${id}: ${JSON.stringify(old)} must be in the module exactly once`);
  return text.slice(0, i) + replacement + text.slice(i + old.length);
}

function handTask(spec: Spec): ExecEditTask {
  let stale = spec.reference;
  let cursor = 0;
  for (const [old, replacement] of spec.change) {
    stale = once(stale, old, replacement, spec.id);
    cursor = Math.max(cursor, stale.indexOf(replacement) + replacement.length);
  }
  let after = stale;
  for (const [old, replacement] of spec.follow) after = once(after, old, replacement, spec.id);
  const path = `${spec.id}.js`;
  return {
    id: `${spec.id}/call-site`,
    spec: spec.id,
    kind: "call-site",
    path,
    stale,
    after,
    cursor,
    recent: recentChangeOf(path, spec.reference, stale),
    linesAfter: reach(stale, after, cursor),
  };
}

export function editTasksOf(spec: Spec): ExecEditTask[] {
  const tasks = spec.renames.map(([from, to]) => renameTask(spec, from, to));
  if (spec.change.length > 0) tasks.push(handTask(spec));
  return tasks;
}

/** Put the lines the model wrote in place of lines `[start, end)` (0-based) of the text. */
export function applyLines(text: string, start: number, end: number, replacement: string): string {
  const lines = text.split("\n");
  const body = replacement.endsWith("\n") ? replacement.slice(0, -1) : replacement;
  return [...lines.slice(0, start), ...(replacement === "" ? [] : body.split("\n")), ...lines.slice(end)].join("\n");
}

// ---- grading ------------------------------------------------------------------------------------------------------

export type Verdict = "pass" | "wrong" | "syntax" | "timeout" | "crash";

const referenceCache = new Map<string, Promise<Outcome>>();

/** What the reference gives: the outputs a candidate has to match. */
export function referenceOutcome(spec: Spec): Promise<Outcome> {
  let o = referenceCache.get(spec.id);
  if (o === undefined) {
    o = runTests(spec.reference, spec.entry, spec.tests);
    referenceCache.set(spec.id, o);
  }
  return o;
}

export async function grade(spec: Spec, candidate: string): Promise<Verdict> {
  const want = await referenceOutcome(spec);
  if (want.kind !== "ok") throw new Error(`${spec.id}: the reference does not run (${want.kind})`);
  const got = await runTests(candidate, spec.entry, spec.tests);
  if (got.kind !== "ok") return got.kind;
  return got.results.length === want.results.length && got.results.every((r, i) => r === want.results[i]) ? "pass" : "wrong";
}

/** The module with the model's text where the span was. */
export function withFill(spec: Spec, task: ExecFimTask, text: string): string {
  return task.prefix + text + task.suffix;
}
