# `test/e2e/` and `ui/host/`: the end-to-end journey

**Purpose.** One script that is a person's whole use of the product, from a folder with no conversation to delivered files, run in a real browser against the real views. It is the success state the real controller (`ui/controller/`, not yet written) is built towards: it runs today against the mock controller and fails where the mock only pretends.

**Status.** The journey, the driver, the Playwright runner, the disk world and the web host exist. The test is a `[slow]` suite marked `todo` (it runs and reports its failure, and does not fail the run) until the real controller passes it. With the mock it gets through initializing a folder, adding a provider, a new thread and a first turn with an approved write, and fails at the first check of the disk.

## Pieces

| File | Role |
|---|---|
| `ui/host/web-host.ts` | A controller behind a loopback HTTP server: `/events` (server-sent events) and `/intent` (POST, validated with `parseIntent`). Plain HTTP rather than a websocket, so it needs no dependency. |
| `extensions/vscode/web/` | The page: the real views, wired to the host. Built by `tools/build-web.mts`. |
| `test/e2e/driver.ts` | `Driver`: click, right-click, type, expect visible or gone, read text, screenshot, by role and name, label or text. Never a class name or a position. |
| `test/e2e/playwright-driver.ts` | The driver over a Playwright page. A second runner (VS Code's own webview) will implement the same interface. |
| `test/e2e/journey.ts` | The script, and `World`: what it needs to know (the folder, the tasks, the file expected) and the checks that are not on screen (files in the folder, files on a branch, the branch checked out, the files opened). |
| `test/e2e/world.ts` | `diskWorld`: the `World` over a real temporary workspace, using the file system and `git show`. |
| `test/e2e/web.test.ts` | Builds the page, starts the host, launches Chromium, runs the journey. `E2E_SHOTS=<dir>` keeps a picture at each stage (and of the failure); `E2E_TRACE=1` prints the page's console. |

## The journey

1. Initialize the folder from the repository menu; the sheet opens on Providers.
2. Add Anthropic, see the connection pass, save.
3. New thread; send a task; thinking and a tool call appear; approve the write; the file is on the thread's branch and not yet in the project folder.
4. Open the file the agent named (recorded by the host's stand-in for the editor).
5. Fork from the reply and send a second task on the fork.
6. Edit a file by hand, switch the workspace to the fork (the file is kept as a snapshot).
7. Merge the fork into the trunk.
8. Switch back to the trunk; the files are in the project folder and on the trunk branch, checked against disk and git.

## Working on it

- Run it: `CHATTREE_SLOW=1 E2E_SHOTS=/tmp/shots node --no-warnings --test test/e2e/web.test.ts`.
- A control the journey needs and cannot name by role and label is a gap in the view's accessibility: fix the view (an `aria-label`, a role), not the selector.
- For the real controller the test swaps `MockController` for the real one, with a fake provider server and a scripted model that writes `notes.md`; `World` is unchanged.
