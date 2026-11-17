# ADR 12: Entries are strict on read and write

Status: accepted

## Context

Whether a build should skip fields or entry types it does not know when reading a newer file.

## Decision

No. Every entry is checked against its schema as authored (`additionalProperties: false`), for reading and writing. See ADR 9 for how versions work.

## Why

Skipping means silently dropping data. Widening is a minor bump, narrowing a major bump, and a build refuses what it cannot fully read.

## Notes

This is a development-stage stance: a format bump is not a reason to avoid a change.
