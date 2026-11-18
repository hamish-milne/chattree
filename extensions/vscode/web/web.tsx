/**
 * The web client: the real views in a browser tab, talking to a controller over HTTP (`ui/host/web-host.ts`). The
 * layout is the preview's frame (a side bar of threads, the chat in a panel) without its mock controls. Events
 * and intents are JSON messages on one WebSocket; nothing else is shared with the host.
 */
import { render } from "preact";
import "../preview/themes.css";
import "../preview/preview.css";
import "../webview/base.css";
import { signal } from "@preact/signals";
import { ConfigModel } from "chattree/ui/model/config-model";
import { ChatModel } from "chattree/ui/model/chat-model";
import { GraphModel } from "chattree/ui/model/graph-model";
import type { UiEvent, UiIntent } from "chattree/ui/model/protocol";
import { ChatView } from "../webview/chat/ChatView.tsx";
import { GraphView } from "../webview/graph/GraphView.tsx";

const toasts = signal<{ level: string; message: string; id: number }[]>([]);

const socket = new WebSocket(`ws://${location.host}/ws`);
const send = (intent: UiIntent): void => socket.send(JSON.stringify(intent));
const graph = new GraphModel(send);
const chat = new ChatModel(send);
const config = new ConfigModel(send);

function show(level: string, message: string): void {
  const id = Date.now() + Math.random();
  toasts.value = [...toasts.value, { level, message, id }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 8000);
}

socket.onopen = () => {
  send({ type: "ready", view: "graph" });
  send({ type: "ready", view: "chat" });
};
socket.onclose = () => show("error", "Lost the connection to the host");
socket.onmessage = (m: MessageEvent<string>) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host sends only validated events (the page does not re-check what its own host sent)
  const e = JSON.parse(m.data) as UiEvent;
  graph.apply(e);
  chat.apply(e);
  config.apply(e);
  if (e.type === "notice") show(e.level, e.message);
};

function App() {
  return (
    <div class="shell">
      <div class="workbench">
        <div class="sidebar" style={{ width: "320px" }}>
          <div class="sidebar-title">Threads</div>
          <div class="sidebar-view">
            <GraphView model={graph} />
          </div>
        </div>
        <div class="main at-bottom">
          <div class="editor" />
          <div class="panel-slot" style={{ height: "520px" }}>
            <div class="panel">
              <div class="panel-view">
                <ChatView model={chat} config={config} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="toasts" role="status" aria-live="polite">
        {toasts.value.map((t) => (
          <div key={t.id} class={`toast level-${t.level}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
