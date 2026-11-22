# Configuration

There are two files: `harness.yml` in the project (what this conversation can reach) and a user settings file (you and your machine).

## `harness.yml`

Created by `init`. It holds the outside world and the harness's disposition. It does *not* hold what the model is (model, tools, instructions): that is recorded in the history.

```yaml
providers:
  anthropic:
    $tag: anthropic
    api_key_env: ANTHROPIC_API_KEY      # the NAME of an environment variable, never a key
  local:
    $tag: openai-compatible
    base_url: http://localhost:8080/v1
limits:
  max_request_usd: 1.00
  max_turn_usd: 5.00
  max_conversation_usd: 50.00
  warn_at: 0.8
```

- **`providers`** names each provider by a key of your choice and its type by `$tag` (`anthropic`, `openai`, `openai-compatible`, `gemini`, `opencode-go`, `local-models`). Each type has its own settings; see [Providers and services](services.md).
- **`limits`** are enforced before a request is sent. A request that would pass one is refused with the figures and the line to edit. `warn_at` prints a warning first.
- **Tool approvals** are `allow` maps of key to expiry date under each tool. `read`, `write` and `edit` start allowed; everything else asks. `/tools` grants and revokes.
- **`mcp`** configures MCP servers (see [Skills and MCP servers](../extending/skills-and-mcp.md)).
- **`skills.follow`** says whether changed skills on disk are reported (`ask`, the default) or taken automatically.
- **`compaction`** controls trimming and automatic summaries.
- **`injections.environment`** turns the note that tells the model where it is (system, time zone, date, thread, working directory, commands) on or off, and `injections.environment_details` switches each of those parts (`os`, `time_zone`, `date`, `thread`, `workspace`, `commands`) separately. The working directory is part of the note, so after `/thread switch` moves a thread to another folder the model is told its new path (unless `workspace` is off).
- **`workspace.switch.ignored`** says what `/thread switch` does with git-ignored files such as `node_modules`: `move` (default) swaps them between the project folder and the thread's folder so nothing needs installing again, `leave` keeps them where they are. Anything that holds an absolute path to its folder (a Python virtual environment, say) will not survive a move.
- **`attached`** is for code kept in a git submodule of the thread's repository (see [Concepts](concepts.md)). `note` (default on) tells the model which repositories are attached, and `guidance` (default on) adds that the workspace is scratch space, the repositories are where the work that ships goes, and commits there wait for you to ask: turn it off if your instruction files say so in your own words. `merge.state` (default on) lets a thread that made no commits merge its code changes as files are merged; `merge.rebase` (default on) lets a thread with commits be fast-forwarded into a parent that has nothing uncommitted. Off, either leaves the work for the parent as a branch. `branch_prefix` (default `chattree`) names the branch made for a thread's commits when it made none itself.
- **`background.resume`** lets a finished background job restart an idle thread (default off, because it spends money).

`harness.yml` can be edited by hand (comments are kept), with `/config edit`, or with `chattree config edit`. `init` writes a JSON Schema to `.chattree/harness.schema.json` and a `yaml-language-server` comment, so editors that support it validate and complete the file. `/config` validates it and lists problems.

**Trust.** A `harness.yml` can arrive with a cloned repository, and it can name programs to run. chattree uses nothing from it (no provider, tool grant or MCP server) until you approve the file for the thread; `/trust` shows what changed since you last approved it.

## Secrets

Config holds the *name* of an environment variable. chattree reads the process environment, then a file `chattree/env` inside the repository's `.git` directory (not committable). A missing variable is reported when the conversation opens, naming the variable and the provider. Resolved secrets are scrubbed from the history, logs and error messages.

## User settings

`settings.yml` under `~/.config/chattree/` (`$XDG_CONFIG_HOME` if set; `%APPDATA%\chattree\` on Windows; `CHATTREE_SETTINGS` names another file). It holds display preferences and the local model host's settings (`local_models`). `chattree settings` shows it and `chattree settings edit` opens it, creating it with a commented template. An unknown key or bad value stops the command with the file's path and the problems.
