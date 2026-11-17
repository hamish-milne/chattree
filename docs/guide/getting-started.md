# Getting started

## Install

chattree is not yet published as a package. From a checkout:

```
pnpm install
pnpm chattree --help
```

`pnpm chattree` runs `cli/chattree.ts`. You need Node 22.18 or later and Git 2.38 or later (chattree checks the Git version and says so if it is too old; Ubuntu 22.04 ships 2.34, so install a newer one there).

## Create a conversation

Make an empty directory and start one there:

```
mkdir my-chat && cd my-chat
chattree init --provider anthropic --model <model-id>
```

`init` creates a Git repository, writes `harness.yml`, adds the ignore entries, commits the first entry, and pins the current prices so costs work from the first message. It looks for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in your environment and records the *name* of the variable, never the key. `--provider` is `anthropic`, `openai` or `compatible` (with `--base-url` for a server such as Ollama or llama.cpp); `--key-env` names another variable. For a conversation inside a repository you already have, see `--adopt` in [Commands](commands.md).

## Talk

```
chattree chat
```

Type a message and press Enter to add a line; a blank line sends it. Pasted text is taken whole. Lines starting with `/` are commands: `/help` lists them, `/status` shows the thread, model and spend, `/quit` leaves. In a script, `chattree say "text"` sends one message and prints the reply (`-` reads standard input; `--attach <file>` adds a file).

## Look at the history

The conversation is an ordinary repository, so:

```
git log --oneline
```

shows every entry as a commit. `/history`, `/show <n>` and `/log` show the same from inside a session, and `/export <file>` writes the thread as Markdown.

## Try a fork

`/fork` starts a side conversation from the current point, in its own worktree. Work in it, then `/merge` brings it back into the thread it came from with a summary (you can write one, or the model will). See [Concepts](concepts.md).
