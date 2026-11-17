# Tools and approvals

## What the model can do

| Tool | Does |
|---|---|
| `read`, `write`, `edit` | Read files (several at once, with line numbers and a version), write files, and edit by line number guarded by the version `read` showed. They work inside the workspace only. |
| `mm_read` | Look at an image, hear a sound or read a PDF, for models that accept them. |
| `run`, `script` | Run a command line, or a POSIX `sh` script. `run` parses the command itself rather than using your shell, so it behaves the same on Linux, macOS and Windows (where busybox stands in for everyday utilities). `$VAR` is expanded only for names listed in `tools.env`. |
| `search` | Search this thread's history, or its family's, or the project's. |
| `thread_read`, `thread_send` | Read and message the parent, children and (when allowed) siblings. |
| `subagent`, `fork` | Start a subagent or a fork. |
| `skill` | Load a skill's instructions. |
| `jobs`, `job_output`, `job_stop` | Manage background jobs. |
| `mcp__<server>__<tool>` | Tools from MCP servers you accepted. |

## Approvals

`read`, `write` and `edit` are allowed from the start. Everything else asks. When a call asks, you can allow it once, or allow the same kind of call for 5 minutes, an hour or indefinitely (the grant is recorded as a key and an expiry under the tool in `harness.yml`). For `run`, the key describes the program, so allowing `git status` does not allow `rm`. A pipeline asks for each stage that is not covered. Review the grants with `/tools`.

Approvals are yours to give: the model cannot grant itself anything, and an MCP server's tools always ask until you grant them. A subagent works with the thread's approvals as they were when it started.

## Long output and background jobs

Output over about 30 KB is cut to its start and end with a note saying how to ask for more; the full text is kept in the history. A tool that can take a while can be started in the background; you are told when it finishes, and the model reads the result on its next request (or, if `background.resume` is on, the thread picks up by itself).

## When something is stopped

`/abort` or Ctrl-C stops the running tool (a command's whole process group is killed), records that it was stopped, and ends the turn. After a crash, calls that never got an answer are answered with "did not run" and the model decides whether to try again; chattree never re-runs a call that may have half-finished.
