/** What the controller asks of the editor, done with the VS Code API. */
import * as vscode from "vscode";
import type { Platform } from "chattree/ui/controller/platform";

/** The scheme for a read-only copy of a file as an earlier commit had it. */
export const SNAPSHOT_SCHEME = "chattree-snapshot";

/** Serves the copies `openFile` was given; `label` is the document's name, so each is shown under it. */
export class SnapshotProvider implements vscode.TextDocumentContentProvider {
  readonly #bytes = new Map<string, Uint8Array>();
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return new TextDecoder().decode(this.#bytes.get(uri.toString()) ?? new Uint8Array());
  }

  uriFor(label: string, bytes: Uint8Array): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${label}` });
    this.#bytes.set(uri.toString(), bytes);
    this.#changed.fire(uri);
    return uri;
  }
}

export function vscodePlatform(snapshots: SnapshotProvider): Platform {
  return {
    async openFile(file) {
      const uri = file.content === undefined ? vscode.Uri.file(file.path) : snapshots.uriFor(file.content.label, file.content.bytes);
      const line = file.line === undefined ? undefined : Math.max(0, file.line - 1);
      const endLine = file.endLine === undefined ? line : Math.max(0, file.endLine - 1);
      const selection =
        line === undefined || endLine === undefined ? undefined : new vscode.Range(line, 0, endLine, Number.MAX_SAFE_INTEGER);
      await vscode.window.showTextDocument(uri, { preview: true, ...(selection === undefined ? {} : { selection }) });
    },
    async beforeSend() {
      if (vscode.workspace.getConfiguration("chattree").get<boolean>("saveBeforeSend", true)) await vscode.workspace.saveAll(false);
    },
    async saveAttach(folder, key, project) {
      const uri = vscode.Uri.file(folder);
      const config = vscode.workspace.getConfiguration("chattree", uri);
      const have = config.inspect<Record<string, string>>("attach")?.workspaceFolderValue ?? {};
      await config.update("attach", { ...have, [key]: project }, vscode.ConfigurationTarget.WorkspaceFolder);
    },
    copy: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
    async pickFiles() {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach" });
      return Promise.all(
        (picked ?? []).map(async (uri) => ({
          name: uri.path.slice(uri.path.lastIndexOf("/") + 1),
          bytes: await vscode.workspace.fs.readFile(uri),
        })),
      );
    },
  };
}
