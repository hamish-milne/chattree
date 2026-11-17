# ADR 3: Every mutation is a locked transaction

Status: accepted

## Context

Each transcript entry is a commit and several operations combine file edits with Git operations. A crash or a concurrent process must not leave a history that cannot be read.

## Decision

Each mutation runs one skeleton: take the per-branch lock (exclusive create, with pid, host and stale detection), check preconditions (tail clean, worktree clean, tip as expected), apply, stage, commit, and on failure roll back by truncating the file to its previous length.

## Why

One commit per entry makes every entry a possible fork point, and the lock keeps two processes from interleaving appends to one branch. Rolling back by truncation (and `git restore --staged --worktree chat.yml`, which is also correct if the commit had landed) is simple and safe because the transcript is append-only.

## Notes

A branch's lock lives under the common git directory and is held only for one mutation. A crashed process's lock goes stale after 30 s (configurable); restarting sooner fails with `LockHeldError` naming the holder. A subagent branches from the parent's commit so full history stays on disk; its model context starts at its `branch_start` marker.
