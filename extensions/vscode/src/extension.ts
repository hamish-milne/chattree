/**
 * The extension: the real controller in the extension host, a graph of threads in the side bar and the chat in the panel.
 * The views are webviews that show what the controller sends and post what the person does (`bridge.ts`); the editor itself
 * is reached through `platform.ts`.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { nodeHost } from "chattree/hosts/node";
import { Controller } from "chattree/ui/controller/controller";
import type { UiEvent } from "chattree/ui/model/protocol";
import { Bridge } from "chattree/ui/host/bridge";
import { webviewHtml } from "./html.ts";
import { SNAPSHOT_SCHEME, SnapshotProvider, vscodePlatform } from "./platform.ts";

type ViewName = "graph" | "chat";

const VIEW_IDS: Record<ViewName, string> = { graph: "chattree.graph", chat: "chattree.chat" };

function showNotice(e: UiEvent): void {
  if (e.type !== "notice") return;
  if (e.level === "error") void vscode.window.showErrorMessage(e.message);
  else if (e.level === "warning") void vscode.window.showWarningMessage(e.message);
  else void vscode.window.showInformationMessage(e.message);
}

class ChattreeView implements vscode.WebviewViewProvider {
  readonly #bridge: Bridge;
  readonly #root: vscode.Uri;
  readonly #name: ViewName;

  constructor(name: ViewName, bridge: Bridge, root: vscode.Uri) {
    this.#name = name;
    this.#bridge = bridge;
    this.#root = root;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.#root, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = webviewHtml({
      view: this.#name,
      script: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")).toString(),
      style: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css")).toString(),
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("base64"),
    });
    const detach = this.#bridge.attach({ post: (event) => void view.webview.postMessage(event) });
    const listen = view.webview.onDidReceiveMessage((m: unknown) => this.#bridge.receive(m));
    view.onDidDispose(() => {
      detach();
      listen.dispose();
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // The log: what was asked of the controller, what each request did and how long it took, every failure in full (View > Output > chattree).
  const log = vscode.window.createOutputChannel("chattree", { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("chattree.showLog", () => log.show(true)),
  );
  log.info(`chattree starting (pid ${process.pid})`);
  const snapshots = new SnapshotProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshots));

  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const env = { host: nodeHost(), cwd: folders[0] ?? process.cwd(), env: process.env, now: Date.now };
  const controllers: Controller[] = [];
  const bridge = new Bridge(
    (emit) => {
      const c = new Controller({
        env,
        folders,
        send: emit,
        platform: vscodePlatform(snapshots),
        session: `vscode-${process.pid}`,
        log: (line) => log.info(line),
      });
      controllers.push(c);
      return c;
    },
    (e) => {
      showNotice(e);
      if (e.type === "notice") log.appendLine(`[${e.level}] ${e.message}`);
    },
    (intent) => {
      // The kind of thing asked, not what was typed.
      if (intent.type !== "chat.draft") log.debug(`intent ${intent.type}`);
      // Looking at a thread or a commit is reading it: bring the chat forward.
      if (intent.type === "thread.open") void vscode.commands.executeCommand(`${VIEW_IDS.chat}.focus`);
    },
  );
  context.subscriptions.push({ dispose: () => void Promise.all(controllers.map((c) => c.close())) });

  for (const name of ["graph", "chat"] as const) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(VIEW_IDS[name], new ChattreeView(name, bridge, context.extensionUri)),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(`chattree.show${name === "graph" ? "Graph" : "Chat"}`, () =>
        vscode.commands.executeCommand(`${VIEW_IDS[name]}.focus`),
      ),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("chattree.newThread", () => {
      bridge.receive({ type: "thread.new" });
    }),
  );
  // The folders are read once, as the controller is built; a change asks for a new window, which reads them again.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void vscode.window.showInformationMessage(
        "chattree reads the workspace folders when the window opens: reload it to use the new ones.",
      );
    }),
  );
}

export function deactivate(): void {}
