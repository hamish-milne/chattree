# chattree

chattree is an agent harness that keeps every conversation in Git. You talk to a model (a hosted one such as Claude or GPT, or one running on your own machine), the model can read and edit files and run commands in a workspace, and everything that happens is recorded as commits you can inspect, rewind, fork and merge with ordinary Git tools.

## What it offers

- **History in Git.** A conversation is a repository. Every message, tool call and result is one commit. You can see the whole thing with `git log`, go back to any point, and branch from it.
- **Any model, any provider.** Anthropic, OpenAI, Gemini, any OpenAI-compatible server, flat-fee plans such as OpenCode Go, and local models through llama.cpp. You can switch model mid-conversation; chattree tells you what a switch would cost and what it would break (the provider's prompt cache, for example) before it does it.
- **Threads, forks and subagents.** A *thread* is a branch of the conversation. Fork one to try something without disturbing the original, then merge the result back with a summary. The model can start *subagents*: fresh-context workers on their own branches that report back.
- **Tools with approvals.** The model can read, write and edit files, run commands, search the history, load skills and call MCP servers. Anything beyond reading and editing files asks you first, and you can grant standing permission for a time.
- **Cost under control.** Prices are pinned to the conversation. Limits for a request, a turn and the whole conversation are enforced before a request is sent, and `/usage` shows the ledger.
- **Safe by construction.** History is append-only, writes survive crashes, and a transcript that cannot be read fully is refused rather than guessed at. Secrets are named in config, never stored.
- **Context management.** Old tool output can be trimmed, and long conversations can be summarised, automatically or by hand, without rewriting history.

## Where to go next

| | |
|---|---|
| [Getting started](getting-started.md) | Install, create a conversation, send a message |
| [Concepts](concepts.md) | Threads, forks, subagents, the workspace, how history is stored |
| [Commands](commands.md) | Every command and verb |
| [Configuration](configuration.md) | `harness.yml`, the user settings file, limits and approvals |
| [Tools and approvals](tools-and-approvals.md) | What the model can do and how permission works |
| [Providers and services](services.md) | Pointing chattree at an API or a plan |
| [Local models](local-models.md) | Running models on your own machine |
| [Extending chattree](../extending/README.md) | Adapters, tools, skills, dialects |

## Requirements

Node 22.18 or later and Git 2.38 or later. chattree runs its TypeScript directly; there is no build step.
