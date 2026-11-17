# ADR 9: The format version is the state of a read; no forward compatibility

Status: accepted

## Context

Transcripts live in Git for a long time and are read by builds of different ages. We first considered lenient reading of newer files.

## Decision

The `header` entry gives `major.minor`. A read starts with the version unknown; a header sets it after a check; every later entry is read by the entry types of the current major (`entryTypesByMajor`). An entry before any header is an error, and a header may appear again, so a transcript can pass from one version to a later one. Minor means backwards compatibility only: a build reads every file of its minor or below, and a higher minor is an error ("update chattree"), never skipped. Major is for breaking changes; a build reads only the majors it has types for. Entries are strict (`additionalProperties: false`) on read and write.

## Why

Lenient reading means silently dropping data a newer build wrote. Strictness on both sides guarantees nothing the code writes can differ from its schema. Folding the version into reader state also allows several majors in one transcript later.

## Notes

The check runs at `open` (so an unreadable thread is refused, not read as empty) and in `EntryReader`, used by `readEntries`, `verifyHistory` and other processes' appends. A build adding to a file whose last header has a lower minor appends its own header first. Branch starts and merges are committed straight into Git and do not yet do this.
