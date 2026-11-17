# ADR 5: Crash safety: append, fsync, commit, then recover on open

Status: accepted

## Context

A process can die at any point of an append. Reopening must always yield a strictly valid history.

## Decision

Write order is append, fsync, commit. On open: a file ending mid-entry is truncated to the last complete entry, complete uncommitted entries are committed in recovery commits (`Chattree-Recovered: true`), a stale lock is taken over, and crash debris (our own `*.tmp-<hex>` files, old temporary indexes, set-aside locks) is removed.

## Why

Ordering makes every crash state recoverable by a rule rather than a guess. Recovery stages each uncommitted entry's transcript prefix with `hash-object` and `update-index --cacheinfo`, so it gets its own commit without touching the worktree file. Workspace files are not committed by recovery; they wait for the next entry.

## Notes

Verified by a fault-injecting host that fails the nth exec call at every side-effecting operation, and a seeded random-operations test against a model. Fork is built with plumbing in a temporary index and the branch is created last, so it exists complete or not at all.
