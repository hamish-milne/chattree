# `extensions/vscode/`: the VS Code extension

**Purpose.** The first graphical front end: a thread graph in the side bar, a chat in the panel and a form for `harness.yml`. It is a workspace package (`pnpm-workspace.yaml`), separate from the root package because it has its own manifest and dependencies and is bundled for the VSIX. Reasons: ADR 35. The shared logic is in [`ui/`](ui.md).

**Status.** The graph view, the chat view (transcript, composer, status bar, model settings), the form field renderer and the browser preview exist, driven by the mock controller. The thread settings sheet (a gear in the chat header replaces the transcript with it: `harness.yml` pages for providers, limits, approvals, MCP servers, subagents, context and repository, and, for the thread, its instruction files) exists in the preview too. The extension host code and the real controller do not yet.

**Depends on:** `chattree` (the root package, through its `ui/model/*` and `ui/fixtures/*` exports), `preact`, `@preact/signals`, `marked`. The graph has a repository picker above it, a context menu (open, fork, rewind, merge, copy hash, delete thread) and a confirmation dialog for delete. Runs of tool calls are drawn as one bordered group; each built-in tool has its own body (diff, numbered lines, terminal) chosen by `toolView`. A reference to a file (in a message, or the path of a tool call) is a button (`webview/chat/FileLink.tsx`): a click opens it as the extension's setting says, and a right-click offers the current file or the file as it was after that block's change. Markdown is rendered from tokens into Preact elements (`webview/markdown.tsx`), never as HTML: raw HTML is shown as text, links are limited to http, https and mailto, images show their alt text. Webview code imports nothing from Node, `vscode` or the harness.

## Layout

Each directory has its own `tsconfig.json`, because each runs in a different place (the type checker and the linter find the nearest one).

| Path | Role |
|---|---|
| `webview/` | The views (Preact). A view takes a model from `ui/model` and draws it; it keeps no state of its own and talks to nothing but its model. `webview/graph/` is the thread graph (the checked-out thread is marked with a monitor icon; the context menu can switch the workspace to a thread, asking what to do with uncommitted files); `webview/config/` is the settings sheet: common choices as buttons and labelled inputs (provider cards with a connection check, limits, compaction), granular settings as dense tables (approvals with expiry, MCP servers, subagent models grouped by provider with a switch each, reminder rules, instruction files). |
| `preview/` | The browser preview: the views over a mock controller in a frame that stands in for VS Code, with a Dark+/Light+ theme switch (`themes.css` defines the `--vscode-*` variables VS Code would), a width slider and a log of the intents a view sends. Not shipped. |
| `tools/` | `build-preview.mts` bundles the preview with esbuild into `dist/preview/`; `serve-preview.mts` serves it on `127.0.0.1`. `.mts` because the package itself is CommonJS (the extension's output must be). |

## Working on a view

- Run `pnpm --filter chattree-vscode build:preview` then `pnpm --filter chattree-vscode preview` and open the address it prints.
- A view uses only `var(--vscode-*)` colours and fonts, so it follows the user's theme; add a variable to `preview/themes.css` when the view needs a new one (the values there are approximations of Dark+ and Light+).
- A page that uses signals must import `@preact/signals` once (the preview does), which installs the hook that re-renders on a change.
- A view's behaviour that is not drawing (what a click does, which actions apply) belongs in `ui/model` and is tested there.
- `test/ui/preview.test.ts` builds the bundle and checks it has no Node imports, no typebox and one copy of the signals core.
