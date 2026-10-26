import { display, resolveInWorkspace } from "./workspace.ts";
import type { Tool } from "../tools.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

interface Edit {
  path: string;
  content: string;
  after?: string;
  before?: string;
  mode?: "replace" | "insert";
}

class EditFailed extends Error {}

const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/** Where `anchor` occurs, counting overlapping occurrences. */
function occurrences(text: string, anchor: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + 1)) at.push(i);
  return at;
}

const quote = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

function locate(text: string, anchor: string, which: "after" | "before"): number {
  const at = occurrences(text, anchor);
  if (at.length === 0) throw new EditFailed(`\`${which}\` ${quote(anchor)} was not found in the file`);
  if (at.length > 1) throw new EditFailed(`\`${which}\` ${quote(anchor)} occurs ${at.length} times (lines ${at.slice(0, 8).map((i) => lineOf(text, i)).join(", ")}${at.length > 8 ? ", ..." : ""}); make it longer so it matches once`);
  return at[0] as number;
}

/** Apply one edit to the file's text; returns the new text and a one-line description. */
export function applyEdit(original: string, edit: Edit): { text: string; summary: string } {
  // A CRLF file keeps its line endings: the model writes \n, so translate what it sent.
  const crlf = original.includes("\r\n");
  const fix = (s: string): string => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
  const after = edit.after === undefined || edit.after === "" ? undefined : fix(edit.after);
  const before = edit.before === undefined || edit.before === "" ? undefined : fix(edit.before);
  const content = fix(edit.content);
  const mode = edit.mode ?? "replace";

  if (mode === "insert") {
    if ((after === undefined) === (before === undefined)) throw new EditFailed("insert mode takes exactly one of `after` and `before`");
    const at = after !== undefined ? locate(original, after, "after") + after.length : locate(original, before as string, "before");
    return { text: original.slice(0, at) + content + original.slice(at), summary: `inserted ${content.length} characters at line ${lineOf(original, at)}` };
  }
  // A lone anchor is the usual slip (the model names the text it wants gone as the anchor, and the region silently runs to the
  // start or end of the file), so replace mode wants both and says how to use them.
  if (after === undefined || before === undefined) {
    throw new EditFailed(
      "replace mode needs both `after` and `before`: the text just before and the text just after what is to be replaced (they stay; the text between them is replaced by `content`). They are never the text being replaced itself. For example, to change `draft` in `status: draft` give after \"status: \" and before \"\\n\" with content \"final\". To add text without replacing any, use mode insert with one anchor; to rewrite a whole file, use write.",
    );
  }
  const start = locate(original, after, "after") + after.length;
  const end = locate(original, before, "before");
  if (end < start) throw new EditFailed("`before` occurs before the end of `after`");
  const removed = original.slice(start, end);
  return {
    text: original.slice(0, start) + content + original.slice(end),
    summary: `replaced ${removed.length} characters with ${content.length} (from line ${lineOf(original, start)})`,
  };
}

export function editTool(): Tool {
  return {
    definition: {
      name: "edit",
      description:
        "Change part of a file without reading all of it first. Each edit gives optional anchors `after` and `before`, exact text that must occur exactly once in the file, and `content`. The text between the end of `after` and the start of `before` is replaced by `content`; the anchors stay. Both anchors are required: they are the text just before and just after what is to be replaced, never the text being replaced itself (to change `draft` in `status: draft` give after `status: ` and before the text that follows, such as a newline). With mode `insert`, give exactly one anchor and `content` is added right after `after` or right before `before`, replacing nothing. If an anchor is missing or matches more than once the edit fails and says where the matches are. Edits are applied in order and it stops at the first failure.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["edits"],
        properties: {
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "The edits, applied in order.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "content"],
              properties: {
                path: { type: "string", description: "Path relative to the workspace root." },
                content: { type: "string", description: "The new text." },
                after: { type: "string", description: "Exact text that ends just before the region to replace (or the insert point). Must occur once." },
                before: { type: "string", description: "Exact text that begins just after the region to replace (or the insert point). Must occur once." },
                mode: { type: "string", enum: ["replace", "insert"], description: "replace (default) or insert." },
              },
            },
          },
        },
      },
    },
    async execute(args, ctx) {
      const { host, workspace } = ctx;
      const edits = args["edits"] as Edit[];
      const lines: string[] = [];
      for (const [i, e] of edits.entries()) {
        try {
          const abs = await resolveInWorkspace(host, workspace, e.path, "write");
          const name = display(host, workspace, abs);
          const st = await host.fs.stat(abs);
          if (st === undefined) throw new EditFailed(`${name} does not exist (use write to create it)`);
          if (st.isDirectory) throw new EditFailed(`${name} is a directory`);
          let original: string;
          try {
            original = dec.decode(await host.fs.read(abs));
          } catch {
            throw new EditFailed(`${name} is not UTF-8 text`);
          }
          const out = applyEdit(original, e);
          await host.fs.writeAtomic(abs, enc.encode(out.text), { keepMode: true });
          lines.push(`edited ${name}: ${out.summary}`);
        } catch (err) {
          if (!(err instanceof EditFailed) && !(err instanceof Error && err.name === "PathRefused")) throw err;
          const rest = edits.length - i - 1;
          lines.push(`failed: edit ${i + 1} (${e.path}): ${err.message}${rest > 0 ? `; the other ${rest} edit${rest === 1 ? " was" : "s were"} not applied` : ""}`);
          return { content: lines.join("\n"), is_error: true };
        }
      }
      return { content: lines.join("\n") };
    },
  };
}
