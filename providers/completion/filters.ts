/**
 * What is done to a suggestion before it is shown: the usual ways a fill-in-the-middle model goes wrong are repeating the text that is already
 * after the cursor, and writing nothing, or nothing new. These are pure, so the bench can score a model with and without them.
 */

const CLOSERS = new Set([")", "]", "}", ">", '"', "'", "`"]);

/**
 * Cut off the end of `suggestion` that repeats the start of `suffix`: a model that writes the closing bracket the editor has already put
 * there, or the line that follows. A single character is cut only when it closes something, so a letter that happens to match is left.
 */
export function trimSuffixOverlap(suggestion: string, suffix: string): string {
  const head = suffix.slice(0, Math.min(suffix.length, 200));
  for (let k = head.length; k >= 1; k--) {
    const tail = head.slice(0, k);
    if (tail.trim() === "" || !suggestion.endsWith(tail)) continue;
    if (k === 1 && !CLOSERS.has(tail)) continue;
    return suggestion.slice(0, suggestion.length - k);
  }
  // A last line equal to the first line after the cursor (a multi-line answer that went on into code that is already there).
  const lines = suggestion.split("\n");
  const next = suffix
    .split("\n")
    .find((l, i) => i > 0 && l.trim() !== "")
    ?.trim();
  const last = lines.at(-1)?.trim();
  if (lines.length > 1 && next !== undefined && next.length >= 3 && last === next) return lines.slice(0, -1).join("\n");
  return suggestion;
}

/** Why a suggestion should not be shown, or undefined when it can be. */
export function suggestionProblem(suggestion: string, prefix: string, suffix: string): "empty" | "no change" | undefined {
  if (suggestion.trim() === "") return "empty";
  // The text is already there: what follows the cursor starts with it.
  if (suffix.startsWith(suggestion)) return "no change";
  // It repeats the end of what is before the cursor and adds nothing.
  if (prefix.endsWith(suggestion) && suggestion.trim().length > 20) return "no change";
  return undefined;
}

/** Trim, then check: the suggestion to show, or why there is none. */
export function shown(suggestion: string, prefix: string, suffix: string): { text: string } | { problem: "empty" | "no change" } {
  const text = trimSuffixOverlap(suggestion, suffix);
  const problem = suggestionProblem(text, prefix, suffix);
  return problem === undefined ? { text } : { problem };
}
