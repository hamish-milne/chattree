/**
 * The browser preview: the real views over a mock controller, in a frame that stands in for VS Code (side bar, editor,
 * panel), with a theme switch, a choice of where the chat sits, and sliders for the sizes. It exists so the look can
 * be refined without VS Code; nothing here ships in the extension. The intents a view sends are listed in the editor
 * area, so what a click does can be seen.
 */
import { render } from "preact";
// Importing the package installs the hook that re-renders a component when a signal it read changes.
import { signal } from "@preact/signals";
import { THREADS } from "chattree/ui/fixtures/graph";
import { MockController } from "chattree/ui/fixtures/mock-controller";
import { ConfigModel } from "chattree/ui/model/config-model";
import { ChatModel } from "chattree/ui/model/chat-model";
import { GraphModel } from "chattree/ui/model/graph-model";
import type { UiEvent, UiIntent } from "chattree/ui/model/protocol";
import { ChatView } from "../webview/chat/ChatView.tsx";
import { GraphView } from "../webview/graph/GraphView.tsx";

const theme = signal<"dark" | "light">("dark");
const place = signal<"bottom" | "right">("bottom");
const sideWidth = signal(320);
const panelSize = signal(400);
const intents = signal<UiIntent[]>([]);
const toasts = signal<{ level: string; message: string; id: number }[]>([]);

let controller: MockController;
const emit = (e: UiEvent): void => {
  graph.apply(e);
  chat.apply(e);
  config.apply(e);
  if (e.type === "notice") {
    const id = Date.now() + Math.random();
    toasts.value = [...toasts.value, { level: e.level, message: e.message, id }];
    setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 5000);
  }
};
const send = (i: UiIntent): void => {
  intents.value = [i, ...intents.value].slice(0, 14);
  controller.handle(i);
};
const graph = new GraphModel(send);
const chat = new ChatModel(send);
const config = new ConfigModel(send);
const reset = (): void => {
  controller = new MockController({ emit });
  intents.value = [];
  controller.handle({ type: "ready", view: "graph" });
  controller.handle({ type: "ready", view: "chat" });
  if (config.form.peek() !== undefined) controller.handle({ type: "ready", view: "config" });
};
reset();

const TABS = ["Problems", "Output", "Debug Console", "Terminal", "Chattree"];

function Panel() {
  return (
    <div class="panel">
      <div class="panel-tabs" role="tablist">
        {TABS.map((t) => (
          <span key={t} role="tab" aria-selected={t === "Chattree"} class={`panel-tab${t === "Chattree" ? " active" : ""}`}>
            {t}
          </span>
        ))}
      </div>
      <div class="panel-view">
        <ChatView model={chat} config={config} />
      </div>
    </div>
  );
}

function App() {
  document.documentElement.dataset["theme"] = theme.value;
  const right = place.value === "right";
  return (
    <div class="shell">
      <div class="toolbar">
        <label>
          Theme
          <select value={theme.value} onChange={(e) => (theme.value = e.currentTarget.value === "light" ? "light" : "dark")}>
            <option value="dark">Dark+</option>
            <option value="light">Light+</option>
          </select>
        </label>
        <label>
          Chat
          <select value={place.value} onChange={(e) => (place.value = e.currentTarget.value === "right" ? "right" : "bottom")}>
            <option value="bottom">in the panel (bottom)</option>
            <option value="right">in the secondary side bar</option>
          </select>
        </label>
        <label>
          Side bar
          <input
            type="range"
            min="220"
            max="520"
            value={sideWidth.value}
            onInput={(e) => (sideWidth.value = Number(e.currentTarget.value))}
          />
        </label>
        <label>
          Chat {right ? "width" : "height"}
          <input
            type="range"
            min={right ? 340 : 220}
            max={right ? 900 : 640}
            value={panelSize.value}
            onInput={(e) => (panelSize.value = Number(e.currentTarget.value))}
          />
        </label>
        <label>
          Click on a file
          <select
            value={chat.fileClick.value}
            onChange={(e) => (chat.fileClick.value = e.currentTarget.value === "after" ? "after" : "current")}
          >
            <option value="current">opens the current file</option>
            <option value="after">views it after the change</option>
          </select>
        </label>
        <button class="secondary" onClick={() => controller.setThreadStatus(THREADS.auth, "idle")}>
          Subagent finishes
        </button>
        <button class="secondary" onClick={() => controller.setThreadStatus(THREADS.lint, "error")}>
          Lint thread fails
        </button>
        <button class="secondary" onClick={reset}>
          Reset
        </button>
      </div>
      <div class="workbench">
        <div class="sidebar" style={{ width: `${sideWidth.value}px` }}>
          <div class="sidebar-title">Threads</div>
          <div class="sidebar-view">
            <GraphView model={graph} />
          </div>
        </div>
        <div class={`main ${right ? "at-right" : "at-bottom"}`}>
          <div class="editor">
            <h2>Intents sent to the controller</h2>
            {intents.value.length === 0 ? (
              <pre>(click a commit, send a message, change a setting)</pre>
            ) : (
              intents.value.map((i, n) => <pre key={n}>{JSON.stringify(i).slice(0, 160)}</pre>)
            )}
          </div>
          <div class="panel-slot" style={right ? { width: `${panelSize.value}px` } : { height: `${panelSize.value}px` }}>
            <Panel />
          </div>
        </div>
      </div>
      <div class="toasts" aria-live="polite">
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
