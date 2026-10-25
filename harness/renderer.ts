/**
 * A renderer turns the structured entries that have no provider equivalent (a compaction, a merged fork, a
 * subagent's result, a tool call that was cut off) into the text a model reads. Which renderer an agent uses is
 * part of its setup (`agent_setup.renderer`), so what the model was shown is reproducible from the transcript
 * and the wording can be improved, or translated, without changing the past.
 *
 * Rules for renderers:
 * - **A renderer id is immutable.** `chattree-english-v1` will always produce exactly these strings (a test pins
 *   them); a better wording is a new id, and moving an agent to it is a setup change (`renderer_changed`),
 *   because it changes every rendered turn and so the cached prefix.
 * - Renderers are pure functions of their arguments: no clock, no locale lookups, no randomness.
 * - The strings are for the model, not the user interface.
 */

export interface MergedFiles {
  changed: string[];
  added: string[];
  discarded: string[];
}

export interface Renderer {
  /** The summary a compaction stands for, shown where the compacted range began. */
  compaction(summary: string): string;
  /** A fork merged back into this branch. */
  forkMerge(summary: string, files: MergedFiles): string;
  /** A subagent's result, as the result of the call that started it. */
  subagentResult(summary: string, files: MergedFiles): string;
  /** A subagent's result when no call here started it (the call was compacted away): shown as a message. */
  subagentResultUnattached(summary: string, files: MergedFiles): string;
  /** A tool call whose arguments were still arriving when the response was interrupted. It did not run. */
  cutOffCall(toolName: string): string;
  /** The result given to a call that never got one. */
  toolDidNotRun(): string;
  /** A subagent's task, as its first message. */
  subagentBrief(brief: string): string;
  /** The user message `continueInterrupted` writes after a cut-off reply (stored as text when written). */
  continueInterrupted(): string;
}

/** Looks a renderer up by the id an agent's setup names. */
export type Renderers = Readonly<Record<string, Renderer>>;

export const DEFAULT_RENDERER = "chattree-english-v1";

function filesNote(f: MergedFiles): string {
  const parts: string[] = [];
  if (f.added.length > 0) parts.push(`added: ${f.added.join(", ")}`);
  if (f.changed.length > 0) parts.push(`changed: ${f.changed.join(", ")}`);
  if (f.discarded.length > 0) parts.push(`not kept (conflicted): ${f.discarded.join(", ")}`);
  return parts.length === 0 ? "" : `\n[Files: ${parts.join("; ")}]`;
}

/** The first renderer. Frozen: see the rules above. */
export const chattreeEnglishV1: Renderer = Object.freeze({
  compaction: (summary: string) => `[Summary of the earlier conversation]\n${summary}`,
  forkMerge: (summary: string, files: MergedFiles) => `[A side conversation that branched from this one was merged back]\n${summary}${filesNote(files)}`,
  subagentResult: (summary: string, files: MergedFiles) => `${summary}${filesNote(files)}`,
  subagentResultUnattached: (summary: string, files: MergedFiles) => `[A subagent finished]\n${summary}${filesNote(files)}`,
  cutOffCall: (toolName: string) => `[A call to ${toolName} was cut off before it finished and did not run]`,
  toolDidNotRun: () => "The tool did not run: the conversation was interrupted before it produced a result.",
  subagentBrief: (brief: string) => brief,
  continueInterrupted: () => "Your previous reply was cut off. Continue from where it stopped, without repeating what you already wrote.",
});

/** The renderers that ship with the harness. Hosts add their own by passing more to `prepareContext`. */
export const builtinRenderers: Renderers = { [DEFAULT_RENDERER]: chattreeEnglishV1 };

/** The renderer an id names, or an error that says how to provide it. */
export function findRenderer(id: string, available: Renderers = builtinRenderers): Renderer {
  const r = available[id] ?? builtinRenderers[id];
  if (r === undefined) throw new Error(`unknown renderer ${JSON.stringify(id)}: provide it in the renderers option (known: ${[...new Set([...Object.keys(available), ...Object.keys(builtinRenderers)])].join(", ")})`);
  return r;
}
