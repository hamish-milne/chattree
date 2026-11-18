# ADR 35: The UI is a controller over the harness, with views that only draw

Status: accepted

## Context

The first graphical front end is a VS Code extension: a graph of threads in the side bar, a chat in the panel, and a form for `harness.yml`. Other front ends (a browser, Electron) may follow. VS Code puts hard limits on how the extension is built: it has its own manifest, it must be bundled, and its pages (webviews) run in a separate browser context from the code that can touch files and processes.

## Decision

- **Three layers.** `ui/model/` is the shared UI core: data shapes, the message protocol and the logic that is not drawing (graph layout, entries to transcript blocks, form models). It runs anywhere, imports no Node or DOM API, and takes harness types only as `import type`. `ui/controller/` runs in the extension host, owns the conversations through the harness, and turns what happens into messages. The views draw view-models and send intents; the VS Code package holds only registration, commands and the three surfaces.
- **State that matters lives in the controller,** not in a view. A webview can be closed, hidden or reloaded without losing a thread's state; a view that opens asks for a snapshot and then follows events.
- **The protocol is a wire.** Both directions are TypeBox schemas in `ui/model/protocol.ts` and are validated where they are received, as any untrusted boundary is. The controller never trusts an intent a webview sent.
- **View state is signal models.** Inside a view, state is `@preact/signals` models (`createModel`: signals, computed values and actions in one disposable unit), rendered with Preact. A model takes its data from protocol events and sends intents; it knows nothing of VS Code.
- **The agent loop runs in the extension host,** importing the harness directly. The journal, locks and leases already make a killed process safe and let several windows share a repository. A separate daemon is a later option.
- **One repository, a workspace with one extra member.** The root package keeps `src/`, `harness/`, `cli/` and gains `ui/`. The extension is `extensions/vscode/`, its own package, because it needs its own manifest and dependencies and must be bundled for the VSIX (VS Code's Node need not run `.ts` files directly). `ui/` can become a package when a second front end needs it.
- **Mock first.** The first extension runs against a scripted controller that implements the same protocol with fixture data, and the views also run in a plain browser page with a theme switch, so the look can be refined before the real controller exists.

## Why

Keeping views dumb makes the real controller a drop-in for the mock, keeps all behaviour testable under `node:test` with no browser, and makes a second front end a matter of writing the surface. A workspace member costs one `package.json` and enforces the dependency direction (the extension imports the core; the core cannot import the extension).

## Notes

Rewinding a thread is the conversation's own rewind (it keeps the old tip under a ref); forking and merging are the existing fork and merge operations. The protocol carries the anchor (an entry or commit) and the controller decides the rest.
