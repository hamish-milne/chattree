# `test/`: tests

**Layout.** Tests mirror the source tree and are named `*.test.ts`:

| Directory | Covers |
|---|---|
| `test/core/` | `src/`: codec, fuzz, framing, tags, cross-check against `yaml`, blobs, schema, git (including batched reads and `fast-import`). |
| `test/validate.test.ts` | `src/validate.ts`. |
| `test/harness/` | `harness/`: entries and versions, conversation, fork and subagents with crash injection, compaction, verification, random operations (`random-ops`), the loop, tools, approvals, MCP, search, leases, jobs, media. |
| `test/providers/` | Each adapter against recorded fixtures at many chunk sizes, conformance, HTTP base, SSE, pricing, dialects. |
| `test/localmodels/` | The local model host: plan, download, install, store, daemon, sampling. |
| `test/cli/` | The engine and commands through `submit(line)` with a fake terminal, sessions, drafts, skills, MCP, trust, threads. |
| `test/app/` | `app/`: the settings file, init (with and without a provider), what can be done with a workspace folder. |
| `test/ui/` | The UI core: fixtures are valid data, the protocol accepts every message and refuses what a view must not send. |
| `test/e2e/` | The whole product in a real browser (Playwright, Chromium) over the web host: `journey.ts` is one person's work from an empty folder to delivered files, written against `driver.ts` (roles, names, labels, text; never classes); `playwright-driver.ts` and `world.ts` give it hands and a real disk. A [slow] suite; see [e2e.md](e2e.md). |
| `test/hosts/` | The Node host, busybox and ffmpeg fetchers. |
| `test/integration/` | `lifecycle.test.ts`: one conversation through everything, then deep verification and `git fsck --strict`. |
| `test/tools/` | The dev tools' pure parts (scenario generators, bench logic). |
| `test/support/` | Shared helpers: the toy adapter, the fake HTTP server and fake llama-server, the fault-injecting host (`hosts.ts`), temporary repositories (`tmp.ts`), seeded generators (`gen.ts`), `slow()`, wait helpers. |
| `test/fixtures/` | Recorded files used by tests. |

**How they run.** `npm test` (the quick group), `npm run test:slow`, `npm run test:all`; see `tools/test.ts`. Each file runs in its own process. Tests use `node:test` and `node:assert/strict`. Real Git in temporary repositories is preferred over mocks. Needs Git 2.38 or later on `PATH`.

**Crash safety is tested by injection.** A host that fails the nth side-effecting call is run at every index of a mutation, and the test reopens the conversation and checks the history verifies. Random-operation tests (`random-ops`) run seeded sequences against a model of the expected transcript and verify every branch.

**Where to add a test.** Beside the existing tests for the module you changed, in the mirrored directory. A new entry type needs a case in `test/harness/entries.test.ts`; a new adapter needs fixtures and a conformance run (`test/providers/`); a new command needs a table test in `test/cli/`; a new mutation needs a crash sweep.
