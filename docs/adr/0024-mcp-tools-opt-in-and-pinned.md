# ADR 24: MCP: tools only, nothing starts until accepted, every call asks

Status: accepted

## Context

A `harness.yml` can arrive with a cloned repository, and an MCP `command` is a program to run.

## Decision

Tools only over stdio and streamable HTTP (no resources, prompts, sampling or OAuth). Nothing starts until the thread accepts the configuration (`/mcp accept`). Tools join the registry as `mcp__<server>__<tool>`, every call asks, and the user may grant one tool or a whole server. Connections are pooled per process and keyed by configuration; a program starts in the thread's worktree by default. Native tools, not a gateway tool.

## Why

A gateway tool keeps the prefix stable but weakens schema adherence. Accepting on a per-thread basis protects against running code from a repository the user has not looked at.

## Notes

A server's tool list changing while connected is flagged and read again on refresh, not followed.
