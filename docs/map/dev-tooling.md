# `tools/`, `scripts/`, `bench/`, `templates/`: development tooling

**Purpose.** Programs for developing and checking chattree that are not part of the product. None is imported by product code. Several are *live* tools: they call real models and are run by a person, who reports the results; they are never run by the test suite.

## The test runner

`tools/test.ts` is what `npm test` runs: one process per test file, a few at a time, each with a time limit; a hung file is killed with its process tree and named. Groups: `quick` (the default), `slow` (`[slow]` suites), `all`, or an explicit file list. See [tests.md](tests.md).

## Live checks and samplers

| File | Role |
|---|---|
| `live-check.ts` | Runs an adapter through scenarios against a real or local server and applies the conformance checks. Add a flavor in `makeAdapter` when adding an adapter. |
| `live-sample.ts`, `tasks.ts`, `agent-task.ts` | Measure how reliably a model uses the starter tools: each task (prompt, starting files, outcome check) is run many times in fresh workspaces through the real loop. |
| `record-fixture.ts` | Record one real provider response as a scrubbed test fixture. Read the fixture before committing it. |
| `gen-ui-schema.ts` | Writes `ui/fixtures/harness-schema.ts` from `configJsonSchema(defaultRegistry())`, the schema the `harness.yml` editor mock edits. Run it after a config change; `test/ui/harness-schema.test.ts` fails when the file is stale. |
| `local-adapter.ts` | The `local-models` provider as the CLI builds it, for the live tools. |
| `wire-log.ts` | Logging helper for wire-level debugging. |

## Local-model research tools

Probes and benchmarks used to decide dialects and defaults (ADR 32, 33): `dialect-bench.ts` (template versus dialect on the tool tasks), `completion-bench.ts` (fill-in-the-middle models: our prompt through `/completion` against the server's `/infill`, scored on answers cut out of a repository's files, with the server's timings; tasks in `completion-tasks.ts`, scores in `completion-score.ts`), `template-compare.ts` (how each model's chat template handles agent situations), `llama-replay.ts` (replay a request a server answered badly), `builtin-probe.ts`, `builtin-chain.ts`, `harmony-raw-probe.ts` (gpt-oss's built-in tool convention), `copy-probe.ts` (copying fidelity), `spec-bench.ts` (speculative decoding), `vision-probe.ts` and `audio-probe.ts` with their scenario generators (`vision-scenarios.ts`, `raster.ts`, `audio-scenarios.ts`, `audio-speech.ts`, `audio-samples.ts`, `media-source.ts`), and `jinja-fixture.py` (renders a template with Jinja2 for comparison). Results that matter are recorded in an ADR, not left in a script.

## Fetchers

`fetch-busybox.ts` and `fetch-ffmpeg.ts` download the pinned Windows builds through `hosts/` (hash-checked; downloads need the user's approval).

## Other

| Path | Role |
|---|---|
| `scripts/catalog.ts` | `npm run catalog -- opencode-go\|gemini`: refresh the bundled model snapshots from the services' model lists (a network call; review the diff before committing). |
| `bench/bench.ts` | `npm run bench`: strings versus bytes in the codec. |
| `templates/` | Patched copies of a model's own chat template (`gpt-oss.jinja`), used through a model entry's `chat_template`. Its README says what was changed and why. |
