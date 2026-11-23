# Commands

Run commands from the shell as `chattree <verb>`, or inside a session as `/<command>`. Any session command also works as a shell verb (`chattree status`, `chattree history 20`). `/help [command]` lists what is available. Global options: `-C <dir>` (run as if started there), `-t <thread>`, `-y` (answer yes to questions), `--plain` (no styling or spinner), `--thinking on|brief|off`, `--tools full|brief|off`.

## Shell verbs

| Verb | Does |
|---|---|
| `init [dir]` | Start a conversation: `--provider anthropic\|openai\|compatible`, `--model`, `--base-url`, `--key-env`, `--name <first thread>`. Inside an existing repository, `--adopt` starts on the current branch (every entry then commits the working tree's pending changes; needs a clean tree) and `--force` allows a nested repository. |
| `chat [thread]` | The interactive session. `--session <id>` resumes one, `--new-session` starts another, `--plain` reads lines from standard input for scripts. |
| `run [--once]` | Run every thread that can go on without a person (subagents, forks, answered questions) until stopped. `--once` does what can be done and leaves: exit 0 nothing waiting, 3 questions waiting, 1 a thread was held after a failure. |
| `say <text>` | Send one message and print the reply (`-` reads stdin, `--attach <file>` repeats). |
| `settings [edit]` | Show or edit the user settings file. |
| `models <verb>` | The local model host: `start`, `restart`, `stop`, `status`, `list`, `info`, `pull`, `rm`, `prune`, `logs`, `update` (see [Local models](local-models.md)). |

## Session commands

**Chat.** `/say <text>` sends the draft with staged attachments (bare text does the same). `/retry` re-runs a request that failed before any reply. `/continue [text]` carries on after an interrupted reply. `/abort` stops the running request. `/attach <path>` stages a file (`/attachments` lists, `/detach` removes). `/draft`, `/drafts`, `/paste`, `/send`, `/discard` and `/edit` work on the draft and on named drafts. `/undo [n]` rewinds. `/push [remote]` pushes the code in attached repositories, then the conversation's branch if it has a remote. `/more` pages long output.

**Reading.** `/history [n]`, `/show <n|id>`, `/log`, `/status`, `/usage`, `/display` (how much reasoning and tool detail to show), `/export <file>`, `/search <query>`.

**Threads.** `/threads`, `/thread [name]`, `/thread new`, `/thread archive`, `/thread switch <name>` (give the project folder to another thread; `--snapshot` saves unsaved changes first, `--leave-ignored` keeps ignored files in place), `/fork`, `/merge`, `/runs`, `/questions`, `/compact`.

**Setup.** `/model`, `/set <key> [value]` (model settings), `/instructions`, `/rebuild`, `/skills`, `/skill`, `/mcp`, `/tools` (grant permissions), `/providers`, `/pricing [pin]`, `/accept`, `/config`, `/trust`, `/settings`.

**Housekeeping.** `/verify` checks the history, `/maintain` repacks, `/sessions` lists sessions, `/exec [command]` runs a command in the thread's worktree as you (no approval, nothing recorded), `/clear`, `/quit`.

While a request is running some commands are refused (those that would change what is being sent); they say so.

## Typing

In a terminal, Enter adds a line and a blank line sends. A trailing backslash continues a line. A paste is taken whole, blank lines included. `//text` or `/say /text` sends text that begins with a slash. Ctrl-C stops a running request, otherwise clears the draft; pressed twice within three seconds it leaves. Ctrl-D leaves. Ctrl-O sets what you are typing aside as the next numbered draft. `$VISUAL` or `$EDITOR` opens for `/edit` and `/draft`.
