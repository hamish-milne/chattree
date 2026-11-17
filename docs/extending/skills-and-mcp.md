# Skills and MCP servers

Two ways to give a thread more capability without writing chattree code. Both are *pinned* in the thread's setup, so what the model was given is part of the history.

## Skills

A skill is a directory with a `SKILL.md`: the Agent Skills layout. Frontmatter holds `name` (lowercase letters, digits and hyphens, equal to the directory name) and `description`; other keys are kept as metadata. The body is what the model reads when it uses the skill.

Where chattree looks, later winning on a name so a project's skill replaces the user's:

1. the user's directory (`CHATTREE_SKILLS_DIR`, else `chattree/skills` under `$XDG_CONFIG_HOME` or `~/.config`, or `%APPDATA%` on Windows)
2. `.agents/skills` in the project
3. `.chattree/skills` in the project

The model sees a one-line catalogue (name and description) after its instructions, and a `skill` tool that returns a skill's body. You can also run one yourself: `/skill <name> [what to do]`. `/skills` lists them and shows what differs on disk; `/skills sync` pins what is on disk.

Skills are treated as untrusted input: each file is read up to 64 KiB, links that leave the skill's directory are not followed, frontmatter is bounded and parsed without anchors, aliases or tags, and a skill that fails any check is skipped and reported rather than failing the scan.

## MCP servers

An MCP server is an external program (or an HTTP endpoint) that offers tools. chattree supports tools only, over stdio and streamable HTTP. Configure servers under `mcp:` in `harness.yml`: a program with `command`, `args`, `env`; or a `url` with `headers`. Secrets are named by environment variable (`env_from`, `bearer_env`, `header_env`), never written in the file.

- Nothing starts until the thread accepts the configuration with `/mcp accept`, because a `harness.yml` can arrive with a cloned repository and a `command` is a program to run.
- A server's tools appear as `mcp__<server>__<tool>`. Every call asks for approval; you can grant one tool or a whole server.
- A server whose tools change is not followed silently: the loop refuses until you accept the change, which stops a description being swapped after approval.
- A program starts in the thread's worktree by default (`scope: thread`); `scope: project` runs it once for all threads.
- Subagents inherit the thread's servers by default (`subagent.mcp: inherit`, or `none`, or a list of names).
- On Windows, a program that is a `.cmd` (such as `npx`) needs `command: cmd` and `args: ["/c", "npx", ...]`.

`/mcp` lists servers, `/mcp show <server> [tool]` shows what a model would be given, and `/mcp refresh` reads the tools again.
