# ADR 30: The CLI is a thin host over the library

Status: accepted

## Context

We want other hosts (a UI, a service) to reuse the engine.

## Decision

The harness library knows nothing of terminals. The CLI has an engine and command registry (`cli/engine.ts`, `cli/commands/`), a terminal layer over `node:readline` (`cli/terminal.ts`), prompt rules with no terminal in them (`cli/prompt.ts`), and a plain line-oriented mode. Sessions are YAML files that point at threads; archive is a zero-diff commit; abort is a marker file. `ChangeNotAllowed` and `LimitExceeded` are shown with the figures and the line to edit.

## Why

Keeping the prompt rules and the engine free of the tty makes most of the CLI testable through a fake terminal.

## Notes

In user mode Enter adds a line and a blank line sends; a trailing backslash continues; a paste is taken whole. `readline` was enough for bracketed paste (probed on Node 22.23).
