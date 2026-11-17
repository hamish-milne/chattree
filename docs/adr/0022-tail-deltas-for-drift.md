# ADR 22: Instruction and skill edits are appended at the tail by default

Status: accepted

## Context

Rebuilding the context costs no CPU; changing the bytes of a cached prefix costs money.

## Decision

`agent_setup.apply` is `append` or `rebuild`. Edited instructions and added or changed skills are append (a notice at the point of change; the prefix keeps the old text). Tools, MCP, model and renderer changes are rebuild. Nothing is cached before the first request, so a first change goes straight into the prefix. A change that loses the cache anyway also folds lagging text in for free. `/rebuild` does it on request.

## Why

Most edits can be made as deltas at the tail instead of edits to the prefix.

## Notes

A fork inherits the lag; a subagent writes a complete first setup, which is a rebuild.
