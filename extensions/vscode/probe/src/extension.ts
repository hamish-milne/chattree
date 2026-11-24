/**
 * A probe, not a feature: an extension whose inline completion provider answers in a mode chosen by a command, and writes down everything
 * VS Code tells it (when it is asked, why, what was shown, how each item ended), so that `e2e/probe.test.mts` can see in a real editor what
 * the stable API does and what the proposed inline-edit API (`inlineCompletionsAdditions`) adds. It exists to settle the design of code
 * completions in chattree (docs/parking-lot.md); nothing else uses it.
 *
 * The properties of the proposed API are declared here by hand, from the proposal's own comments, because the typings of a proposal are
 * not part of `@types/vscode`. Whether VS Code reads them is what the probe finds out.
 */
import * as vscode from "vscode";
import { writeFileSync } from "node:fs";

/** What the proposal adds to an item, as read from `vscode.proposed.inlineCompletionsAdditions.d.ts`. */
interface ProposedItem {
  isInlineEdit?: boolean;
  showRange?: vscode.Range;
  jumpToPosition?: vscode.Position;
  displayLocation?: { range: vscode.Range; kind: 1 | 2; label: string };
}

export type Mode =
  | "insert" //            ghost text at the cursor
  | "multiline" //         ghost text of three lines at the cursor
  | "replace-line" //      stable API: replace the line the cursor is on (the range holds the cursor)
  | "replace-earlier" //   stable API: replace an earlier line, away from the cursor
  | "edit-earlier" //      proposed API: the same earlier line as an inline edit
  | "edit-earlier-jump" // proposed API: an inline edit with a position to jump to
  | "label" //             proposed API: ghost text shown as a label elsewhere
  | "none"; //             answer with nothing

interface Entry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

const log: Entry[] = [];
let mode: Mode = "insert";
const started = Date.now();

function record(kind: string, data: Record<string, unknown> = {}): void {
  log.push({ at: Date.now() - started, kind, ...data });
  const out = process.env["CHATTREE_PROBE_OUT"];
  if (out !== undefined) writeFileSync(out, JSON.stringify(log, null, 2));
}

const textOf = (i: vscode.InlineCompletionItem): string => (typeof i.insertText === "string" ? i.insertText : i.insertText.value);

const item = (text: string, range: vscode.Range, extra: ProposedItem = {}): vscode.InlineCompletionItem =>
  Object.assign(new vscode.InlineCompletionItem(text, range), extra);

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every mode; the compiler checks it
function answer(doc: vscode.TextDocument, pos: vscode.Position): vscode.InlineCompletionItem[] {
  const first = doc.lineAt(0).range;
  const here = new vscode.Range(pos, pos);
  switch (mode) {
    case "insert":
      return [item(" world", here)];
    case "multiline":
      return [item("\nsecond line\nthird line", here)];
    case "replace-line":
      return [item("REPLACED LINE", doc.lineAt(pos.line).range)];
    case "replace-earlier":
      return [item("EARLIER LINE REPLACED", first)];
    case "edit-earlier":
      return [
        item("EARLIER LINE EDITED", first, {
          isInlineEdit: true,
          showRange: new vscode.Range(pos.line, 0, pos.line, doc.lineAt(pos.line).text.length),
        }),
      ];
    case "edit-earlier-jump":
      return [item("EARLIER LINE EDITED", first, { isInlineEdit: true, jumpToPosition: first.end })];
    case "label":
      return [item(" world", here, { displayLocation: { range: first, kind: 2, label: "label shown on the first line" } })];
    case "none":
      return [];
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  record("activated", { version: vscode.version });
  ctx.subscriptions.push(
    vscode.commands.registerCommand("completionsProbe.setMode", (m: Mode) => {
      mode = m;
      record("mode", { mode });
    }),
    vscode.commands.registerCommand("completionsProbe.log", () => log),
  );
  const provider: vscode.InlineCompletionItemProvider & Record<string, unknown> = {
    provideInlineCompletionItems(doc, pos, context) {
      const requestUuid: unknown = Reflect.get(context, "requestUuid");
      const changeHint: unknown = Reflect.get(context, "changeHint");
      record("provide", {
        mode,
        line: pos.line,
        character: pos.character,
        triggerKind: context.triggerKind,
        hasSelectedCompletionInfo: context.selectedCompletionInfo !== undefined,
        requestUuid,
        changeHint,
      });
      return answer(doc, pos);
    },
    // The callbacks of the proposal: called only if the editor reads them.
    handleDidShowCompletionItem(shown: vscode.InlineCompletionItem, text: string) {
      record("shown", { text, insertText: textOf(shown) });
    },
    handleEndOfLifetime(ended: vscode.InlineCompletionItem, reason: { kind: number }) {
      record("endOfLife", { insertText: textOf(ended), reasonKind: reason.kind });
    },
    handleDidPartiallyAcceptCompletionItem(_item: vscode.InlineCompletionItem, info: unknown) {
      record("partialAccept", { info });
    },
  };
  ctx.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider));
  record("registered");
}

export function deactivate(): void {
  record("deactivated");
}
