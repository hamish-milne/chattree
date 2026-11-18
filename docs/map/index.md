# Project map

How chattree is put together, where everything lives, and what to change to add something. Start here. Each topic page describes one subsystem, usually one directory. Why things are the way they are is in [`../adr/`](../adr/README.md); the rules for changing them are in [`../conventions.md`](../conventions.md).

## What chattree is

A model-neutral agent harness whose conversation history lives in Git. A conversation is a repository: each transcript entry is a commit, forks and subagents are branches and worktrees. A host (today the CLI) drives a *turn*: build a request from the transcript, stream it through a provider adapter, commit the result, run any tools the model asked for, repeat. Models can be hosted APIs or local servers that chattree starts and manages.

## Layers

```
cli/            the command-line host         ui/   the UI core (graphical hosts)
  │                                              │
harness/        conversations, turns, tools, limits and cost        providers/   model APIs, prices, dialects
  │                                                                    │
  └───────────────┬────────────────────────────────────────────────────┘
                  │            localmodels/   the local model host (daemon over llama-server)
src/            runtime-independent core: codec, validation, blobs, Host seam, Git layer
hosts/          the Host implementations for a machine (Node)
```

Dependencies point down. `src/` imports nothing from the rest of the repository and is typechecked without Node types. `harness/` does not know about terminals. `providers/` does not know about git or the transcript.

## Topics

| Page | Directory | What it covers |
|---|---|---|
| [src.md](src.md) | `src/`, `src/git/` | Transcript codec, validation, blobs, `Host`, locks, the Git wrapper. Byte-level format: [transcript-format.md](transcript-format.md). |
| [hosts.md](hosts.md) | `hosts/` | The local-machine host; busybox and ffmpeg fetchers. |
| [harness.md](harness.md) | `harness/`, `harness/starter/`, `harness/mcp/` | Conversation, entries, context, setup, turn, loop, tools, subagents, limits, media, MCP. |
| [providers.md](providers.md) | `providers/` | Adapters, HTTP transport, prices, catalogs, dialects. |
| [localmodels.md](localmodels.md) | `localmodels/` | The model host: daemon, install, download, store, sampling. |
| [cli.md](cli.md) | `cli/` | The `chattree` command: engine, commands, sessions, terminal. |
| [vscode.md](vscode.md) | `extensions/vscode/` | The VS Code extension: views, the browser preview, tools. |
| [ui.md](ui.md) | `ui/` | The UI core: view-models, the controller/view message protocol, fixtures. |
| [dev-tooling.md](dev-tooling.md) | `tools/`, `scripts/`, `bench/`, `templates/` | Test runner, live checks, local-model research tools. |
| [tests.md](tests.md) | `test/` | Test layout, how crash safety is tested, where to add tests. |
| [dependencies.md](dependencies.md) | `package.json` | Packages, why each is here, the update policy. |
| [lifecycle-graph.md](lifecycle-graph.md) | | A worked example of a conversation's history as a graph. |

## I want to...

| Task | Start in | Also touch |
|---|---|---|
| Add a field or entry type to the transcript | `harness/entries.ts` | version constant, readers and writers, `verify.ts`, `test/harness/entries.test.ts`; widening is a minor bump |
| Change how a value is written to disk | `src/scalar.ts`, `src/emit.ts` | `src/parse.ts` in step, `transcript-format.md`, fuzz tests |
| Add a mutation on a conversation | `harness/conversation.ts` | event, crash-injection test, `verify.ts` |
| Add a provider or API | `providers/` (see [adapters guide](../extending/provider-adapters.md)) | `providers/index.ts`, fixtures, `tools/live-check.ts` |
| Add a model to the bundled catalog or update prices | `providers/catalog/`, `providers/pricing-data.ts` | `npm run catalog` |
| Add a built-in tool | `harness/starter/` or a new file in `harness/` | `cli/toolset.ts` ([tools guide](../extending/tools.md)) |
| Add a slash command | `cli/commands/` | `commands/index.ts`, `test/cli/`, `docs/guide/commands.md` |
| Add a setting for a thread's model | the adapter's `settings` schema in `providers/` | `cli/commands/setup.ts` if it needs special handling |
| Add a `harness.yml` key | `harness/config.ts` | `docs/guide/configuration.md`, the generated editor schema updates itself |
| Add a user setting | `cli/settings.ts` | `docs/guide/configuration.md` |
| Change what the model sees of the history | `harness/context.ts`, `harness/context-builder.ts`, `harness/renderer.ts` | renderer id if wording changes |
| Add a spending limit or price meter | `harness/limits.ts`, `harness/ledger.ts`, `providers/pricing.ts` | `harness/estimate.ts` |
| Support a new local model family | `providers/dialects/` (see [dialects guide](../extending/dialects.md)) | `localmodels/` catalog entries, `tools/dialect-bench.ts` |
| Change what the model host does | `localmodels/` | `cli/models.ts` for the verbs |
| Run commands somewhere other than this machine | implement `Host` ([hosts guide](../extending/hosts.md)) | `test/hosts/` |
| Build another front end | use `harness/` and `providers/` ([embedding guide](../extending/embedding.md)) | follow the split in `cli/` |

## Glossary

- **Entry**: one record in a transcript (`user`, `assistant`, `tool_result`, `agent_setup`, `compaction`, ...). One entry, one commit.
- **Thread**: a branch of a conversation, with its own worktree and `chat.yml`.
- **Fork**: a thread started from an earlier point of another; merged back with a summary.
- **Subagent**: a fresh-context thread started by the model for a task; its result merges into the parent.
- **Setup** (`agent_setup`): the folded record of what a thread's agent is: model, settings, tools, instructions, skills, MCP servers, price pin, renderer.
- **Pin**: a definition (tool, skill, MCP server, price table) recorded by hash so history can be reproduced.
- **Blob**: a large or binary value stored by content hash outside the entry.
- **Host**: the seam for running programs and touching files (`src/host.ts`), also used loosely for a front end such as the CLI.
- **Adapter**: a provider implementation turning a context into a stream of neutral events.
- **Dialect**: our own prompt rendering and output parsing for a local model, replacing the server's chat template.
- **Renderer**: the text a model reads for entries with no provider equivalent (a compaction, a merged fork).
- **Journal**: the log of a request in flight, beside the repository, used for crash recovery.
- **Lease**: who is running a thread, and until when.
- **Injection**: text the harness adds before a request, recorded as an entry.
- **Pump**: the part that finds threads that can continue without a person and runs them.
