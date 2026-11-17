# ADR 31: Compaction is explicit, readable and provider-independent

Status: accepted

## Context

Context windows fill up, and rewriting history is not allowed.

## Decision

A `compaction` entry replaces a range `from..to` with a summary in the *context view* only. It takes effect only if both ids are visible and ordered, otherwise it is ignored; a range may contain earlier summaries whole but never start or end inside one. `trim` (by hand or automatic) drops old tool output; `auto: full` writes a summary between turns, counted in the ledger. Providers' own compaction items coexist.

## Why

History is append-only, so the full conversation is still on disk and forks from earlier points still work.

## Notes

A compaction is a rebuild for cache purposes.
