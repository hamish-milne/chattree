/** Scoring a completion against the text it was taken from, and the filters' effect on it. */
import { shown } from "../providers/completion/index.ts";
import type { FimTask } from "./completion-tasks.ts";

/** The edit distance between two strings, giving up (returning the longer length) past `cap` characters so a long answer does not cost much. */
export function levenshtein(a: string, b: string, cap = 600): number {
  const x = a.slice(0, cap);
  const y = b.slice(0, cap);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length] as number;
}

export interface Score {
  /** The same text, ignoring blank space at the ends. */
  exact: boolean;
  /** The first line that has anything on it is the same. */
  firstLine: boolean;
  /** 1 for the same text, 0 for nothing in common: one minus the edit distance over the longer length. */
  similarity: number;
  empty: boolean;
}

const firstLineOf = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

export function scoreText(expected: string, got: string): Score {
  const e = expected.trim();
  const g = got.trim();
  const longest = Math.max(e.length, g.length, 1);
  return {
    exact: e === g,
    firstLine: firstLineOf(expected) === firstLineOf(got) && firstLineOf(got) !== "",
    similarity: 1 - Math.min(levenshtein(e, g), longest) / longest,
    empty: g === "",
  };
}

/** A sample scored as the model wrote it, and as it would be shown (after trimming what repeats the text after the cursor). */
export function scoreFim(task: FimTask, text: string): { raw: Score; filtered: Score; suppressed: boolean; trimmed: boolean } {
  const s = shown(text, task.prefix, task.suffix);
  const filteredText = "text" in s ? s.text : "";
  return {
    raw: scoreText(task.expected, text),
    filtered: scoreText(task.expected, filteredText),
    suppressed: "problem" in s,
    trimmed: "text" in s && s.text !== text,
  };
}
