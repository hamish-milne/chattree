# ADR 27: `run` takes a bash-like command line that we parse; no shell

Status: accepted

## Context

A model's commands should behave the same on Linux, macOS and Windows and not depend on a user shell.

## Decision

`run` parses a bash-like command line itself (`$VAR` only for names in `tools.env`, globs expanded as in a shell), with busybox standing in for the everyday utilities on Windows. `script` (POSIX sh) is the escape hatch. `read`, `write` and `edit` take lists; `edit` replaces or inserts by line number, guarded by the version `read` shows.

## Why

Parsing ourselves lets the approval keys describe the program and arguments precisely, and avoids shell injection through quoting.

## Notes

Approvals are `allow` maps of key to expiry in `harness.yml`; `read`, `write` and `edit` start allowed, everything else asks.
