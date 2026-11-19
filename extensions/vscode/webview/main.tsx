/**
 * The page of both webviews in VS Code: the models over the extension host. `data-view` says which view this one is. It posts
 * intents to the host and applies every event the host sends; notices are shown by the host, as VS Code's own notifications.
 */
import { render } from "preact";
import "./base.css";
// Importing the package installs the hook that re-renders a component when a signal it read changes.
// oxlint-disable-next-line import/no-unassigned-import -- the import is the point
import "@preact/signals";
import { ChatModel } from "chattree/ui/model/chat-model";
import { ConfigModel } from "chattree/ui/model/config-model";
import { GraphModel } from "chattree/ui/model/graph-model";
import type { UiEvent, UiIntent } from "chattree/ui/model/protocol";
import { ChatView } from "./chat/ChatView.tsx";
import { GraphView } from "./graph/GraphView.tsx";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();
const send = (intent: UiIntent): void => api.postMessage(intent);
const graph = new GraphModel(send);
const chat = new ChatModel(send);
const config = new ConfigModel(send);

window.addEventListener("message", (m: MessageEvent<UiEvent>) => {
  // The host sends only events it built; the page does not check them again.
  graph.apply(m.data);
  chat.apply(m.data);
  config.apply(m.data);
});

const root = document.getElementById("app");
const view = document.body.dataset["view"];
if (root !== null) {
  render(view === "graph" ? <GraphView model={graph} /> : <ChatView model={chat} config={config} />, root);
  send({ type: "ready", view: view === "graph" ? "graph" : "chat" });
}
