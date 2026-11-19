# `test/e2e/` and `ui/host/`: the end-to-end journey

**Purpose.** One script that is a person's whole use of the product, from a folder with no conversation to delivered files, run in a real browser against the real views and the real controller (`ui/controller/`), on a real disk and git repository. Only the model is scripted.

**Status.** Passing. The `[slow]` suite builds the page, starts the web host over a `Controller` on a temporary workspace, points the process's `fetch` at a local server in place of api.anthropic.com (a scripted model: it thinks, calls `write` on `notes.md`, then says what it did, each task with its own closing words), and runs the journey in Chromium. `pnpm web [folder...]` runs the same host by hand on real folders (`tools/serve-web.ts`; keys come from the environment).

## Pieces

| File | Role |
|---|---|
| `ui/host/web-host.ts` | A controller behind a loopback HTTP server: the page's files, and one WebSocket (`/ws`, only from the page the host served) carrying events out and intents in (validated with `parseIntent`; a refused one comes back as an error `notice`). |
| `extensions/vscode/web/` | The page: the real views, wired to the host. Built by `tools/build-web.mts`. |
| `test/e2e/driver.ts` | `Driver`: click, right-click, type, expect visible or gone, read text, screenshot, by role and name, label or text. Never a class name or a position. |
| `test/e2e/playwright-driver.ts` | The driver over a Playwright page. A second runner (VS Code's own webview) will implement the same interface. |
| `test/e2e/journey.ts` | The script, and `World`: what it needs to know (the folder, the tasks, the file expected) and the checks that are not on screen (files in the folder, files on a branch, the branch checked out, the files opened). |
| `test/e2e/world.ts` | `diskWorld`: the `World` over a real temporary workspace, using the file system and `git show`. |
| `test/e2e/long-conversation.perf.ts` | The long-conversation performance test (below), with `perf-data.ts` (the generated conversation) and `perf-page.mjs` (the measurements, run in the page). |
| `test/e2e/web.test.ts` | Builds the page, starts the host, launches Chromium, runs the journey. `E2E_SHOTS=<dir>` keeps a picture at each stage (and of the failure); `E2E_TRACE=1` prints the page's console. |

## The journey

1. Initialize the folder from the repository menu; the sheet opens on Providers.
2. Add Anthropic, see the connection pass, save.
3. New thread; send a task; thinking and a tool call appear (and the approval, in a world that asks: a fresh `harness.yml` allows writes); the file is on the thread's branch and not yet in the project folder.
4. Open the file the agent named (recorded by the host's stand-in for the editor).
5. Fork from the reply and send a second task on the fork.
6. Edit a file by hand, switch the workspace to the fork (the file is kept as a snapshot).
7. Merge the fork into the trunk.
8. Switch back to the trunk; the files are in the project folder and on the trunk branch, checked against disk and git.

## Working on it

- Run it: `CHATTREE_SLOW=1 E2E_SHOTS=/tmp/shots node --no-warnings --test test/e2e/web.test.ts`.
- A control the journey needs and cannot name by role and label is a gap in the view's accessibility: fix the view (an `aria-label`, a role), not the selector.
- The product answers in its own time: a check of the disk or git after a click polls (`eventually`), and the end of a turn is the model's closing words, not the status saying Ready (it says that before the turn starts, too).
- Labels are matched exactly where the journey could match a longer one (`Message` is also the label of a sent message).
- `test/ui/conformance.test.ts` holds the mock and the real controller to the same promises to the views (the events a view may rely on after each intent), so the mock the views are built against does not drift.

## Performance with a long conversation

`test/e2e/long-conversation.perf.ts` (`pnpm test:perf`; a `*.perf.ts` file is in no other group, and the group runs one file at a time, because other work on the machine spoils a timing: it failed at 13.7 ms in a full parallel run that passes at 7.7 alone) loads the page over a web host whose controller serves a generated conversation from memory (so only the views are timed): 5000 commits on a trunk and twelve forks in the graph and 5000 blocks in the transcript (`perf-data.ts`; every message has text of its own). It measures in the page (`perf-page.mjs`, added with `addInitScript`; plain JavaScript because the test project has no DOM types):

- **A new item:** from the Enter key going down to the message painted in the transcript, and to its commit painted in the graph (a message is sent from the composer, the controller answers with `chat.append` and the whole `graph.data`). Budget 100 ms at p95 over 30 sends, after 3 that are not counted.
- **A scroll frame:** the main-thread work of one frame of a scroll, from the scroll event at the start of the frame to a task queued from that frame's animation callback (after style, layout and paint; raster is on other threads), for the transcript and the graph at 100 px per frame (a steady wheel). Budget 10 ms at p95, after 20 warm-up frames. A hard flick (400 px per frame) is measured and reported, not held to the budget.

`CHATTREE_PERF_OUT=<file>` writes the numbers as JSON, `PERF_N` sets the size. Results on the development container (headless Chromium, software rendering; p95, ms), before and after the lists were windowed (`webview/virtual.ts`):

| | before | after |
|---|---|---|
| DOM nodes | 89,466 | 618 |
| page ready | 6,553 | 441 |
| new message painted | 479 | 61 |
| new commit painted | 676 | 65 |
| transcript scroll frame, 100 px | 11.9 | 7.7 |
| graph scroll frame, 100 px | 14.3 | 7.0 |
| transcript scroll frame, 400 px | 16.1 | 6.9 |
| graph scroll frame, 400 px | 16.5 | 9.5 |

What the time was: the whole conversation in the DOM (windowing); `layoutGraph` with two quadratic loops (about 200 ms per graph update, now about 4 ms); `toLocaleTimeString` building a formatter for every row (about 290 ms over 150 frames, now one formatter); the markdown lexer on every redraw of a block (now a small cache). What is left per new commit is the controller sending the whole graph again (`graph.data` is O(commits): about 4 ms to parse at this size, and the garbage it makes), which is the next thing to change if it grows.
