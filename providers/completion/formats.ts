/**
 * The completion formats that ship with chattree. Each model family has its own sentinels, its own order of prefix and suffix, and its own
 * way of writing other files into the prompt, which is why the format is a declaration per family and not one prompt with the words changed.
 *
 * What was read, and where (2026-11-24): Seed-Coder, Mellum and DeepSeek-Coder from their model cards; Qwen2.5-Coder and StarCoder2 sentinels from
 * their tokenizer files; Sweep's from its published `inference.py`. The layout of other files in Qwen2.5-Coder's and StarCoder2's prompts is from
 * memory of their reports and is what `tools/completion-bench.ts` is there to check.
 */
import {
  cutAtMarker,
  defineFim,
  type ContextFile,
  type EditFormat,
  type EditRequest,
  type FimFormat,
  type RecentChange,
  type CompletionFormat,
} from "./format.ts";

/** Qwen2.5-Coder: prefix, suffix, middle; other files as `<|file_sep|>` sections after an optional `<|repo_name|>`. Also the base of Sweep. */
export const qwenCoder = defineFim({
  id: "qwen2.5-coder",
  prefix: "<|fim_prefix|>",
  suffix: "<|fim_suffix|>",
  middle: "<|fim_middle|>",
  order: "psm",
  extraTokens: ["<|repo_name|>", "<|file_sep|>", "<|endoftext|>"],
  stop: ["<|endoftext|>", "<|file_sep|>"],
  files: {
    repo: (name) => `<|repo_name|>${name}\n`,
    header: (path) => `<|file_sep|>${path}\n`,
    target: (path) => `<|file_sep|>${path}\n`,
  },
});

/** Seed-Coder (ByteDance): the suffix comes first, then the prefix, then the middle; no place for other files is documented. */
export const seedCoder = defineFim({
  id: "seed-coder",
  prefix: "<[fim-prefix]>",
  suffix: "<[fim-suffix]>",
  middle: "<[fim-middle]>",
  order: "spm",
});

/** Mellum (JetBrains): suffix first; other files as `<filename>` sections before the file being completed. */
export const mellum = defineFim({
  id: "mellum",
  prefix: "<fim_prefix>",
  suffix: "<fim_suffix>",
  middle: "<fim_middle>",
  order: "spm",
  extraTokens: ["<filename>", "<reponame>", "<fim_pad>"],
  stop: ["<filename>"],
  // Naming the file with no others is a guess: the card's example always has other files.
  files: { header: (path) => `<filename>${path}\n`, target: (path) => `<filename>${path}\n`, nameAlone: true },
});

/** StarCoder2: prefix, suffix, middle; other files after `<repo_name>`, each after `<file_sep>`. */
export const starcoder2 = defineFim({
  id: "starcoder2",
  prefix: "<fim_prefix>",
  suffix: "<fim_suffix>",
  middle: "<fim_middle>",
  order: "psm",
  extraTokens: ["<repo_name>", "<file_sep>", "<|endoftext|>"],
  stop: ["<|endoftext|>", "<file_sep>"],
  files: {
    repo: (name) => `<repo_name>${name}`,
    header: (path) => `<file_sep>${path}\n`,
    target: (path) => `<file_sep>${path}\n`,
  },
});

/** DeepSeek-Coder: the begin marker, the prefix, the hole marker, the suffix, the end marker. */
export const deepseekCoder = defineFim({
  id: "deepseek-coder",
  prefix: "<｜fim▁begin｜>",
  suffix: "<｜fim▁hole｜>",
  middle: "<｜fim▁end｜>",
  // The hole sits between the two texts, so the order of the tokens is begin, prefix, hole, suffix, end: that is `psm` with the sentinels as given.
  order: "psm",
});

const FILE_SEP = "<|file_sep|>";
const CURSOR = "<|cursor|>";

/** Lines with their line ends kept (Python's `splitlines(True)`, for the line ends the editor uses). */
function lineSpans(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const chunk = (f: ContextFile): string => `${FILE_SEP}${f.path}\n${f.text}\n`;

/**
 * Sweep next-edit (Apache-2.0, 7B and 1.5B, on Qwen2.5-Coder): the file around the cursor, chunks from related files, the person's recent
 * changes, then the block around the cursor three times: as it was before the last edit (`original/`), as it is with the cursor marked
 * (`current/`), and `updated/`, which the model writes. The start of `updated/` is given: every line above the cursor's, so the model
 * writes from the cursor's line on (or, after an insertion above the cursor, only the first line, so it can rewrite the lines between).
 */
export const sweepNextEdit: EditFormat = {
  kind: "edit",
  id: "sweep-next-edit",
  tokens: [FILE_SEP, CURSOR, "<|endoftext|>"],
  render(req: EditRequest) {
    const lines = lineSpans(req.text);
    const starts: number[] = [];
    let acc = 0;
    for (const l of lines) {
      starts.push(acc);
      acc += l.length;
    }
    // The line whose span holds the cursor; a cursor at the very end belongs to the last line.
    let cursorLine = Math.max(0, lines.length - 1);
    for (let i = 0; i < lines.length; i++) {
      if (req.cursor < (starts[i] ?? 0) + (lines[i]?.length ?? 0)) {
        cursorLine = i;
        break;
      }
    }
    const blockStart = Math.max(0, cursorLine - (req.linesBefore ?? 10));
    const blockEnd = Math.min(lines.length, cursorLine + (req.linesAfter ?? 10) + 1);
    const codeBlock = lines.slice(blockStart, blockEnd).join("");
    const rel = Math.max(0, req.cursor - (starts[blockStart] ?? 0));
    const withCursor = `${codeBlock.slice(0, rel)}${CURSOR}${codeBlock.slice(rel)}`;
    const before = codeBlock.slice(0, rel);
    let prefill: string;
    if (req.changesAboveCursor === true) {
      // The first line of the block, and the blank lines right after it, as far as the cursor.
      const nl = before.indexOf("\n");
      let end = nl < 0 ? 0 : nl + 1;
      while (end < before.length && before[end] === "\n") end++;
      prefill = before.slice(0, end);
    } else {
      const nl = before.lastIndexOf("\n");
      prefill = nl < 0 ? "" : codeBlock.slice(0, nl + 1);
    }
    const window = lines.slice(Math.max(0, cursorLine - 150), Math.min(lines.length, cursorLine + 150)).join("");
    const range = `${req.path}:${blockStart + 1}:${blockEnd}`;
    const recent = (req.recentChanges ?? [])
      .map((c) => `${FILE_SEP}${c.path}:${c.start}:${c.end}\noriginal:\n${c.original}\nupdated:\n${c.updated}`)
      .join("\n");
    const retrieval = (req.retrieval ?? []).map((f) => `\n${chunk(f)}`).join("");
    const files = (req.files ?? []).map(chunk).join("");
    const prompt =
      `${files}${FILE_SEP}${req.path}\n${window}${retrieval}\n${recent}\n` +
      `${FILE_SEP}original/${range}\n${codeBlock}\n` +
      `${FILE_SEP}current/${range}\n${withCursor}\n` +
      `${FILE_SEP}updated/${range}\n${prefill}`;
    return { prompt, stop: ["<|endoftext|>", FILE_SEP], block: { startLine: blockStart, endLine: blockEnd }, prefill };
  },
  parse(output, rendered) {
    return {
      startLine: rendered.block.startLine,
      endLine: rendered.block.endLine,
      text: rendered.prefill + cutAtMarker(output, [FILE_SEP, "<|endoftext|>"]),
    };
  },
};

/**
 * The 1.5B Sweep model's layout, which is not the 7B's (read from the `run_model.py` on its model card, 2026-11-25): no cursor marker and no
 * line ranges, the recent changes written as `<|file_sep|>PATH.diff` with `original:` and `updated:`, and then the whole file before the last
 * edit (`original/PATH`), as it is now (`current/PATH`) and as the model writes it (`updated/PATH`), joined by single newlines. The answer is
 * the whole file again, so it stands for every line.
 */
export const sweepNextEditSmall: EditFormat = {
  kind: "edit",
  id: "sweep-next-edit-1.5b",
  tokens: [FILE_SEP, "<|endoftext|>"],
  render(req: EditRequest) {
    const parts: string[] = [];
    for (const f of req.files ?? []) parts.push(`${FILE_SEP}${f.path}`, f.text);
    for (const c of req.recentChanges ?? []) parts.push(`${FILE_SEP}${c.path}.diff`, "original:", c.original, "updated:", c.updated);
    parts.push(
      `${FILE_SEP}original/${req.path}`,
      req.before ?? req.text,
      `${FILE_SEP}current/${req.path}`,
      req.text,
      `${FILE_SEP}updated/${req.path}`,
    );
    return {
      prompt: parts.join("\n"),
      stop: [FILE_SEP, "</s>", "<|endoftext|>"],
      block: { startLine: 0, endLine: lineSpans(req.text).length },
      prefill: "",
    };
  },
  parse(output, rendered) {
    return {
      startLine: rendered.block.startLine,
      endLine: rendered.block.endLine,
      // The prompt ends at the name, so the model's first character is the line break after it.
      text: cutAtMarker(output.startsWith("\n") ? output.slice(1) : output, [FILE_SEP, "<|endoftext|>"]),
    };
  },
};

/** A hunk of the person's change as a unified diff, with up to three unchanged lines each side (which the file as it is now supplies). */
function diffHunk(c: RecentChange, text: string): string {
  const lines = lineSpans(text).map((l) => l.replace(/\n$/, ""));
  const first = c.start - 1;
  const ctxBefore = lines.slice(Math.max(0, first - 3), first);
  const ctxAfter = lines.slice(c.end, c.end + 3);
  const old = c.original === "" ? [] : c.original.split("\n");
  const now = c.updated === "" ? [] : c.updated.split("\n");
  const start = first - ctxBefore.length + 1;
  const body = [...ctxBefore.map((l) => ` ${l}`), ...old.map((l) => `-${l}`), ...now.map((l) => `+${l}`), ...ctxAfter.map((l) => ` ${l}`)];
  return (
    `--- a/${c.path}\n+++ b/${c.path}\n` +
    `@@ -${start},${ctxBefore.length + old.length + ctxAfter.length} +${start},${ctxBefore.length + now.length + ctxAfter.length} @@\n` +
    `${body.join("\n")}\n`
  );
}

const MARKER = (n: number): string => `<|marker_${n}|>`;
const USER_CURSOR = "<|user_cursor|>";
/** Lines between one marker and the next in the editable region. The card does not say how Zed spaces them: the sample prompt has them 14 to 16 lines apart. */
const MARKER_EVERY = 8;

/**
 * Zeta 2.1 (Zed, Apache-2.0, fine-tuned from Seed-Coder-8B-Base), as its model card and sample prompt show: a suffix-first prompt whose
 * "prefix" is related files, the person's edits as unified diffs (`<filename>edit_history`), and the file up to an editable region. The region
 * is cut into spans by numbered markers at line starts (the last marker closes it) with the cursor marked inside; the model answers with two
 * markers and the new text between them, so it writes only the part it changes. The cursor marker may come back in the answer, and is taken out.
 */
export const zeta21: EditFormat = {
  kind: "edit",
  id: "zeta-2.1",
  tokens: ["<[fim-suffix]>", "<[fim-prefix]>", "<[fim-middle]>", "<filename>", "<|marker_1|>", USER_CURSOR],
  render(req: EditRequest) {
    const lines = lineSpans(req.text);
    const cursorLine = req.text.slice(0, req.cursor).split("\n").length - 1;
    const before = req.linesBefore ?? 20;
    const after = Math.max(req.linesAfter ?? 20, 20);
    const regionStart = Math.max(0, cursorLine - before);
    const regionEnd = Math.min(lines.length, cursorLine + after + 1);
    const markerLines: number[] = [];
    for (let l = regionStart; l < regionEnd; l += MARKER_EVERY) markerLines.push(l);
    markerLines.push(regionEnd);
    let offset = lines.slice(0, regionStart).join("").length;
    let region = "";
    for (let i = 0; i < markerLines.length - 1; i++) {
      const from = markerLines[i];
      const to = markerLines[i + 1];
      if (from === undefined || to === undefined) continue;
      let span = lines.slice(from, to).join("");
      const spanStart = offset;
      offset += span.length;
      if (to === regionEnd) span = span.replace(/\n$/, "");
      if (req.cursor >= spanStart && req.cursor <= spanStart + span.length && (req.cursor < offset || to === regionEnd))
        span = span.slice(0, req.cursor - spanStart) + USER_CURSOR + span.slice(req.cursor - spanStart);
      region += MARKER(i + 1) + span;
    }
    region += MARKER(markerLines.length);
    const suffix = lines.slice(regionEnd).join("");
    const parts = [`<[fim-suffix]>\n${suffix === "" || suffix.endsWith("\n") ? suffix : `${suffix}\n`}<[fim-prefix]>`];
    for (const f of req.files ?? []) parts.push(`<filename>${f.path}\n${f.text}\n`);
    const changes = req.recentChanges ?? [];
    if (changes.length > 0) {
      parts.push(
        `${(req.files ?? []).length > 0 ? "\n" : ""}<filename>edit_history\n${changes.map((c) => diffHunk(c, req.text)).join("")}\n`,
      );
    }
    parts.push(`<filename>${req.path}\n${lines.slice(0, regionStart).join("")}${region}\n<[fim-middle]>`);
    return {
      prompt: parts.join(""),
      stop: ["<[end\u2581of\u2581sentence]>"],
      block: { startLine: regionStart, endLine: regionEnd },
      prefill: "",
      markers: markerLines,
    };
  },
  parse(output, rendered) {
    const marks = [...output.matchAll(/<\|marker_(\d+)\|>/g)];
    const none = { startLine: rendered.block.startLine, endLine: rendered.block.startLine, text: "" };
    const first = marks[0];
    const last = marks.at(-1);
    const lines = rendered.markers;
    if (first === undefined || last === undefined || first === last || lines === undefined) return none;
    const from = lines[Number(first[1]) - 1];
    const to = lines[Number(last[1]) - 1];
    if (from === undefined || to === undefined || from > to) return none;
    const text = output.slice(first.index + first[0].length, last.index).replaceAll(USER_CURSOR, "");
    return { startLine: from, endLine: to, text };
  },
};

const FORMATS: readonly CompletionFormat[] = [
  qwenCoder,
  seedCoder,
  mellum,
  starcoder2,
  deepseekCoder,
  sweepNextEdit,
  sweepNextEditSmall,
  zeta21,
];

export function completionFormats(): readonly CompletionFormat[] {
  return FORMATS;
}

export function completionFormat(id: string): CompletionFormat {
  const f = FORMATS.find((x) => x.id === id);
  if (f === undefined) throw new Error(`unknown completion format ${JSON.stringify(id)}; known: ${FORMATS.map((x) => x.id).join(", ")}`);
  return f;
}

export function fimFormat(id: string): FimFormat {
  const f = completionFormat(id);
  if (f.kind !== "fim") throw new Error(`${id} is a next-edit format, not a fill-in-the-middle one`);
  return f;
}
