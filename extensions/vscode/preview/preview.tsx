/**
 * The browser preview: the real views over a mock controller, in a frame that stands in for VS Code, with a theme
 * switch and a side bar you can widen or narrow. It exists so the look can be refined without VS Code; nothing here
 * ships in the extension. Intents the view sends are listed on the right, so what a click does can be seen.
 */
import { render } from "preact";
// Importing the package installs the hook that re-renders a component when a signal it read changes.
import { signal } from "@preact/signals";
import { graphFixture, THREADS } from "chattree/ui/fixtures/graph";
import { GraphModel } from "chattree/ui/model/graph-model";
import type { UiIntent } from "chattree/ui/model/protocol";
import { GraphView } from "../webview/graph/GraphView.tsx";

const theme = signal<"dark" | "light">("dark");
const width = signal(320);
const intents = signal<UiIntent[]>([]);

const graph = new GraphModel((i) => (intents.value = [i, ...intents.value].slice(0, 12)));
const reset = (): void => {
  graph.apply({ type: "graph.data", data: graphFixture() });
  graph.apply({ type: "graph.selected", thread: THREADS.main });
};
reset();

function App() {
  document.documentElement.dataset["theme"] = theme.value;
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
          Side bar width
          <input type="range" min="200" max="560" value={width.value} onInput={(e) => (width.value = Number(e.currentTarget.value))} />
          {width.value}px
        </label>
        <button class="secondary" onClick={() => graph.apply({ type: "graph.status", thread: THREADS.auth, status: "idle" })}>
          Subagent finishes
        </button>
        <button class="secondary" onClick={() => graph.apply({ type: "graph.status", thread: THREADS.lint, status: "error" })}>
          Lint thread fails
        </button>
        <button class="secondary" onClick={reset}>
          Reset
        </button>
      </div>
      <div class="stage">
        <div class="sidebar" style={{ width: `${width.value}px` }}>
          <div class="sidebar-title">Threads</div>
          <div class="sidebar-view">
            <GraphView model={graph} />
          </div>
        </div>
        <div class="log">
          <h2>Intents sent to the controller</h2>
          {intents.value.length === 0 ? (
            <pre>(click a commit, or right-click one)</pre>
          ) : (
            intents.value.map((i, n) => <pre key={n}>{JSON.stringify(i)}</pre>)
          )}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
