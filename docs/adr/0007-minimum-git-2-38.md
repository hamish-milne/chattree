# ADR 7: Minimum Git version is 2.38

Status: accepted

## Context

The code uses `git merge-tree --write-tree` (2.38) to compute a merge without touching a worktree, and `git worktree list -z` (2.36).

## Decision

Require Git 2.38 and check the version on open, failing with a clear message.

## Why

It is the oldest release that has what we use; nothing below it can work. The floor was 2.40 for a day on the strength of `merge-tree --merge-base`, which nothing uses, so it was lowered. Verified by running the whole suite, including crash-injection sweeps, against 2.38.0 built from source and 2.43.0.

## Notes

Ubuntu 22.04 ships 2.34, so its users must install a newer Git. Raise the floor again only for a concrete need.
