# `app/`: application services

**Purpose.** What every host needs that is not a turn: the user's settings file, the provider registry (with the local models' runtime), and `init`. The CLI and the extension's controller both use it. Reasons: ADR 36.

**Depends on:** `harness/`, `providers/`, `localmodels/`, `src/`. It imports nothing from `cli/` or `ui/` and nothing terminal-shaped.

## Files

| File | Role |
|---|---|
| `env.ts` | `AppEnv`: the host, environment variables, working directory, clock and settings. A terminal's `Io` extends it. |
| `errors.ts` | `AppError(message, hint)`: a problem the person can fix. The CLI's `CliError` is one. |
| `settings.ts` | The user-level settings file: schema, load, template, create. |
| `providers.ts` | The provider registry for this machine; the local models' catalog and address; sampling lookup. |
| `init.ts` | `runInit`: write the config, start the conversation (new repository or adopt one), pin model setup and prices. `InitEnv` adds `ask` for a terminal. `provider: "none"` starts with no provider and no model pinned (a graphical host adds them in its settings): requests, compaction and price pinning then refuse with `NoModelPinned` until the first setup is made. |
| `toolset.ts` | `buildToolSet`: the tools a session offers its model (built-ins `harness.yml` lists, thread and job tools, subagent and fork tools when pumped, accepted MCP servers) with their jobs; finds busybox and ffmpeg for the host (`resolveBusybox`, `resolveFfmpeg`, `mediaFor`). |
| `environment.ts` | What this machine is, for the note the model gets (`hostEnvironment`). |
| `tool-lines.ts` | How a tool call looks: one summary line, the longer description shown before approval, result lines. Pure strings, used by the terminal and the extension. |
| `project.ts` | A project is a git working tree with `harness.yml`; maps thread names to worktrees and conversations (`findProject`, `openThread`, `conversationOptions`, `createFork` with its worktree); never climbs across a repository boundary. |
| `owner.ts` | Who this process is in run leases and journals; whether a lease's owner is dead. Node-only (pid, hostname). |
| `workspace.ts` | `inspectFolder`/`inspectWorkspace`: what can be done with each folder of a workspace: it holds a conversation (found from the folder or one inside it; the header's format version is read, the thread is not locked), a conversation can be started in it (`new` repository, or `adopt` a repository it is the top of), or it is unusable and why. A folder that is a submodule of a conversation's project (an attached repository, ADR 38) belongs to that conversation: `attachedAs` is its path from the project. |

## To change X

- *Add something both hosts need:* put it here, take an `AppEnv`, throw `AppError`.
- *Something only the terminal needs* (drafts, prompt, escape handling) stays in `cli/`.
