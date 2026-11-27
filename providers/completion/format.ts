/**
 * Completion formats: how a request to complete code at a cursor (or to predict the next edit) becomes one raw prompt for a model that
 * was trained for it, and how the text it writes comes back. A format is a declaration, like a dialect family (`providers/dialect.ts`),
 * and not a dialect: there is no conversation, no tools and no reasoning, one request has one answer, and the whole round trip has
 * a budget of a few hundred milliseconds. The prompt goes to a server's `/completion` (`client.ts`).
 *
 * Two kinds. `fim`: fill in the middle: the text before and after the cursor, in the model's own sentinels, and the model writes what
 * goes between. `edit`: the model is shown a window of the file and the person's recent edits and writes the window again.
 */

/** A file given as context: where it is in the project, and its text. */
export interface ContextFile {
  path: string;
  text: string;
}

export interface FimRequest {
  /** The file being completed, as a path from the project's root. */
  path: string;
  /** The project's name, for formats that name the repository. */
  repo?: string | undefined;
  /** Everything before the cursor, and everything after it (the formats do not trim; the caller chooses the window). */
  prefix: string;
  suffix: string;
  /** Other files, most relevant first. A format with no place for them ignores them (`FimFormat.files`). */
  files?: readonly ContextFile[] | undefined;
}

export interface RenderedCompletion {
  prompt: string;
  /** Strings that end generation, besides the model's own end token. */
  stop: string[];
}

export interface FimFormat {
  kind: "fim";
  id: string;
  /** Whether the format has a place for other files. */
  files: boolean;
  /** The sentinel tokens it writes, as text: each should be one token in the model's vocabulary (the bench checks with `/tokenize`). */
  tokens: readonly string[];
  render(req: FimRequest): RenderedCompletion;
  /** The text to insert, from what the model wrote: cut at the first sentinel if the server let one through. */
  parse(output: string): string;
}

/** One edit the person made, as the next-edit models are shown it. Lines are numbered from 1 and the range is inclusive. */
export interface RecentChange {
  path: string;
  start: number;
  end: number;
  original: string;
  updated: string;
}

export interface EditRequest {
  path: string;
  /** The whole file as it is now. */
  text: string;
  /** The whole file as it was before the last edit, for a format that is shown both (the 1.5B Sweep). */
  before?: string | undefined;
  /** The cursor, as an offset into `text`. */
  cursor: number;
  /** The person's recent edits, oldest first. */
  recentChanges?: readonly RecentChange[] | undefined;
  /** Chunks from other files that look related, and whole files for context. */
  retrieval?: readonly ContextFile[] | undefined;
  files?: readonly ContextFile[] | undefined;
  /** Lines of the block to rewrite above and below the cursor's line (default 10 each). */
  linesBefore?: number | undefined;
  linesAfter?: number | undefined;
  /** The last edit was an insertion above the cursor: let the model rewrite the lines between it and the cursor. */
  changesAboveCursor?: boolean | undefined;
}

/** The lines the model rewrote: `[startLine, endLine)`, 0-based, and what to put there. */
export interface EditSuggestion {
  startLine: number;
  endLine: number;
  text: string;
}

/** What an edit format wrote: the prompt, the lines it lets the model rewrite, and what `parse` needs to read the answer. */
export type RenderedEdit = RenderedCompletion & {
  block: { startLine: number; endLine: number };
  prefill: string;
  /** For a format whose answer names where it starts and ends by numbered markers: the line each marker is at. */
  markers?: readonly number[] | undefined;
};

export interface EditFormat {
  kind: "edit";
  id: string;
  tokens: readonly string[];
  render(req: EditRequest): RenderedEdit;
  parse(output: string, rendered: RenderedEdit): EditSuggestion;
}

export type CompletionFormat = FimFormat | EditFormat;

/** The text up to the first of `markers`, if any is in it. */
export function cutAtMarker(text: string, markers: readonly string[]): string {
  let end = text.length;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(0, end);
}

export interface FimShape {
  id: string;
  /** The sentinels. */
  prefix: string;
  suffix: string;
  middle: string;
  /** The order the prompt has them in: prefix first (`psm`) or suffix first (`spm`). */
  order: "psm" | "spm";
  /** Other tokens the format writes, and what ends the answer besides the model's end token. */
  extraTokens?: readonly string[];
  stop?: readonly string[];
  /** How other files are written before the file being completed, if the format has a place for them. */
  files?: {
    /** Written once first, naming the repository. */
    repo?: (name: string) => string;
    /** One file: written before its text (the text and a newline follow) and between files. */
    header: (path: string) => string;
    /** The header of the file being completed: written just before the sentinels. */
    target: (path: string) => string;
    /** Name the file being completed even when there are no other files (default: only then, so one file is the plain format). */
    nameAlone?: boolean;
  };
}

/** A fill-in-the-middle format from its shape: the prompt is the files, then the target file's header, then the sentinels. */
export function defineFim(s: FimShape): FimFormat {
  const tokens = [s.prefix, s.suffix, s.middle, ...(s.extraTokens ?? [])];
  return {
    kind: "fim",
    id: s.id,
    files: s.files !== undefined,
    tokens,
    render(req) {
      let head = "";
      const f = s.files;
      const others = f === undefined ? [] : (req.files ?? []);
      if (f !== undefined && (others.length > 0 || f.nameAlone === true)) {
        if (f.repo !== undefined && req.repo !== undefined) head += f.repo(req.repo);
        for (const file of others) head += `${f.header(file.path)}${file.text.endsWith("\n") ? file.text : `${file.text}\n`}`;
        head += f.target(req.path);
      }
      const body =
        s.order === "psm"
          ? `${s.prefix}${req.prefix}${s.suffix}${req.suffix}${s.middle}`
          : `${s.suffix}${req.suffix}${s.prefix}${req.prefix}${s.middle}`;
      return { prompt: head + body, stop: [...(s.stop ?? [])] };
    },
    parse: (output) => cutAtMarker(output, tokens),
  };
}
