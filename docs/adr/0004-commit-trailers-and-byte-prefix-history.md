# ADR 4: Commit trailers record the entry and the file offset

Status: accepted

## Context

The UI and verification need an entry-to-commit index and a way to show any past point without checkouts.

## Decision

Every entry commit carries `Chattree-Entry: <ulid>` and `Chattree-Offset: <bytes>` (the length of `chat.yml` after the entry). Author is configurable per entry kind: the user for user entries, the model for assistant entries, the harness as committer.

## Why

The transcript is append-only, so history at any commit is a byte prefix of the tip file. With the offset, any past point is a slice of the working-tree file with no Git calls, and `verifyHistory()` can assert the prefix property for every commit. One `git log` over the trailers builds the entry index. Splitting authorship means `git shortlog` shows who wrote what.

## Notes

Non-entry commits (snapshots, GC) carry other markers (`Chattree-Snapshot`, `Chattree-Gc`) and no `Chattree-Kind`, so the index skips them.
