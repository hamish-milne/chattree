import { browser, expect } from "@wdio/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env["CHATTREE_PROBE_DIR"] ?? ".";
const file = join(process.env["CHATTREE_PROBE_SCRATCH"] ?? ".", "project", "probe.txt");
const TEXT = "first line of the file\nsecond line\nhello";
const MODES = ["insert", "multiline", "replace-line", "replace-earlier", "edit-earlier", "edit-earlier-jump", "label"] as const;

interface Entry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Vscode = typeof import("vscode");

/**
 * Run a function in the editor's extension host, which gets the `vscode` module first; its result crosses a process boundary, so
 * its type is the function's word for it and nothing here checks it.
 */
async function inEditor<P extends unknown[], T>(fn: (vscode: Vscode, ...params: P) => T | Promise<T>, ...params: P): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the bridge types its function loosely
  const result: unknown = await browser.executeWorkbench(fn as (vscode: unknown, ...p: unknown[]) => unknown, ...params);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  return result as T;
}

/** The probe's log, as the extension host has it now. */
const readLog = (): Promise<Entry[]> =>
  inEditor(async (vscode) => (await vscode.commands.executeCommand<Entry[]>("completionsProbe.log")) ?? []);

const run = (command: string): Promise<unknown> => inEditor((vscode, c: string) => vscode.commands.executeCommand(c), command);

const documentText = (): Promise<string> => inEditor((vscode) => vscode.window.activeTextEditor?.document.getText() ?? "<no editor>");

/** Put the document back as it was, with the cursor at the end of the last line. */
const reset = (mode: string): Promise<void> =>
  inEditor(
    async (vscode, m: string, text: string) => {
      const ed = vscode.window.activeTextEditor;
      if (ed === undefined) return;
      await ed.edit((b) => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), text));
      ed.selection = new vscode.Selection(2, 5, 2, 5);
      await vscode.commands.executeCommand("completionsProbe.setMode", m);
    },
    mode,
    TEXT,
  );

/** What the editor drew for suggestions: elements whose class names say so. */
const drawn = (): Promise<{ tag: string; cls: string; text: string }[]> =>
  browser.execute(() =>
    [
      ...document.querySelectorAll(
        '[class*="ghost-text"], [class*="inline-edit"], [class*="inlineEdit"], [class*="inline-completion"], [class*="inlineSuggest"]',
      ),
    ]
      .slice(0, 30)
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        cls: String(e.getAttribute("class")).slice(0, 120),
        text: (e.textContent ?? "").slice(0, 80),
      })),
  );

const report: Record<string, unknown> = {};

describe("what VS Code does with inline completions and inline edits", () => {
  before(async () => {
    mkdirSync(out, { recursive: true });
    await inEditor(async (vscode, f: string) => {
      const doc = await vscode.workspace.openTextDocument(f);
      await vscode.window.showTextDocument(doc);
    }, file);
    for (let i = 0; i < 40 && !(await readLog()).some((e) => e.kind === "registered"); i++) await wait(250);
  });

  after(() => {
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(`probe report: ${join(out, "report.json")}`);
  });

  for (const mode of MODES) {
    it(`mode ${mode}`, async () => {
      await reset(mode);
      await run("workbench.action.focusActiveEditorGroup");
      const before = (await readLog()).length;
      await run("editor.action.inlineSuggest.trigger");
      let slice: Entry[] = [];
      for (let i = 0; i < 40; i++) {
        slice = (await readLog()).slice(before);
        if (slice.some((e) => e.kind === "provide")) break;
        await wait(250);
      }
      await wait(1500);
      const shownDom = await drawn();
      await browser.saveScreenshot(join(out, `${mode}.png`));
      await run("editor.action.inlineSuggest.commit");
      await wait(500);
      const afterCommit = await documentText();
      let afterJump: string | undefined;
      if (afterCommit === TEXT) {
        // An inline edit away from the cursor may need a jump to it before it can be taken.
        await run("editor.action.inlineSuggest.jump");
        await wait(500);
        await run("editor.action.inlineSuggest.commit");
        await wait(500);
        afterJump = await documentText();
      }
      slice = (await readLog()).slice(before);
      report[mode] = { provided: slice.some((e) => e.kind === "provide"), drawn: shownDom, afterCommit, afterJump, log: slice };
      console.log(
        `${mode}: provided=${slice.some((e) => e.kind === "provide")} drawn=${shownDom.length} commit=${JSON.stringify(afterCommit)}${afterJump === undefined ? "" : ` jump=${JSON.stringify(afterJump)}`}`,
      );
      await run("editor.action.inlineSuggest.hide");
      if (mode === "insert") expect(slice.some((e) => e.kind === "provide")).toBe(true);
    });
  }

  it("typing asks for a suggestion by itself", async () => {
    await reset("insert");
    await run("workbench.action.focusActiveEditorGroup");
    const before = (await readLog()).length;
    await browser.keys(["x"]);
    await wait(2500);
    const slice = (await readLog()).slice(before);
    report["typing"] = { log: slice, text: await documentText() };
    console.log(
      `typing: provide calls=${slice.filter((e) => e.kind === "provide").length} triggerKinds=${JSON.stringify(slice.filter((e) => e.kind === "provide").map((e) => e["triggerKind"]))}`,
    );
    await run("editor.action.inlineSuggest.hide");
  });
});
