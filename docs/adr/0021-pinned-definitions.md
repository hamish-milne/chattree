# ADR 21: Tools, instructions, skills and MCP are pinned by hash

Status: accepted

## Context

Changing a tool description or schema changes behaviour and cache bytes.

## Decision

A canonical internal tool format, hashed with the canonical emitter (covering schema, description and implementation identity). The setup records `name -> {hash, store, ref?}`; `store: blob` copies bytes into `blobs/`, `store: external` records only the hash and the host's locator. A skill is pinned as its whole `SKILL.md` in canonical JSON. MCP servers' configuration (without secrets) is pinned too.

## Why

Pinning makes replay byte-for-byte checkable by `verifyHistory` and stops a description being swapped after approval.

## Notes

`syncTools` never follows an MCP server silently: a new, changed or missing tool makes the loop refuse (`ToolsOutOfSync`) until the user accepts.
