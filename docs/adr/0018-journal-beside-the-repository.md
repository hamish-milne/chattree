# ADR 18: Streaming is journalled beside the repository, not committed

Status: accepted

## Context

A crash in mid-stream must not lose paid output or leave an unreadable state.

## Decision

Turn events are tee'd into an append-only JSON-lines journal per branch under the git directory, flushed in small batches. It starts with a record naming the request and ends before the commit: the `assistant` entry is committed and the journal deleted, or an `interrupted` entry is built from completed blocks. On `open`, a journal without a matching commit becomes an `interrupted` entry with `by: error`.

## Why

The `assistant` entry is itself the "response complete" record, so no new entry type is needed. The journal is not canonical YAML and not content-addressed, and other processes can follow it.

## Notes

Complete text and reasoning blocks are kept; a partial tool call is recorded as text. Continuing from where it stopped is an explicit later action.
