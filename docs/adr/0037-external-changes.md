# ADR 37: Files changed outside the chat are told to the model

Status: accepted

## Context

The person edits a file the model has read, or a program or one of the model's own commands changes it. The model's next edit then fails on a stale version, or worse, works from content that is no longer there. Re-reading everything every step is wasteful; ignoring changes is confusing.

## Decision

The file tools (`read`, `write`, `edit`) report the files they touched (`ToolOutput.touched`: path and version). The loop records each as a hidden `file_touch` entry holding the version and the git blob id of the content the model saw. Before each request, `syncExternalFiles` compares every tracked file with the disk. A change becomes an `injection` entry (key `external-changes`) holding a fenced, line-numbered diff against the recorded blob, labelled as file content and not instructions, together with the new version; a `file_touch` then records the new state. Every append already snapshots the worktree into its own commit first, so the change has a commit before the entry that reports it.

A file is no longer tracked, and the model is only told its version is invalid, when the diff is over `max_diff_bytes`, the file is binary or deleted, a compaction or trim has happened since the touch, or the touch is further back than `window_share` of the context window. A change that leaves no diff (line endings) is reported as a changed version. `edit`'s stale-version error carries the same diff. Forks inherit the tracked set through shared history. Settings are `injections.external_changes` in `harness.yml`.

## Why

Recording the blob, not a commit, makes detection independent of how the person commits or stages. The transcript stays the record of what the model was told, so replays see the same thing. Expiry follows what the model can still remember: a diff against content that was compacted away is of no use.

## Notes

The VS Code extension adds `chattree.saveBeforeSend` (default on) to save open files before a message is sent, so the person's latest edits are on disk when the check runs.
