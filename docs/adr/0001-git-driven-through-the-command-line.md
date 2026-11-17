# ADR 1: Drive Git through its command line

Status: accepted

## Context

Every conversation is a Git repository: one commit per entry, forks and subagents as branches and worktrees. We needed a way to drive Git from Node that works against any shell host (local process, container, remote machine).

## Decision

Run the `git` executable through the host's `exec` (argv arrays, never shell strings), wrapped by a small typed `Git` class in `src/git/`.

## Why

- isomorphic-git is pure JS and portable, but has no `git worktree` and only basic merging. Subagents need both.
- libgit2 bindings: nodegit is unmaintained and the wasm builds are immature.
- gitoxide or writing objects ourselves: write support is partial, and hand-rolling means rebuilding refs, locking and packing.

The CLI has the right semantics and respects the user's own tooling.

## Notes

The `Git` interface is kept small so a pure-JS implementation of the read half could back a browser viewer later. `Git` uses `-z` and porcelain-v2 output, `LC_ALL=C`, and disables prompts, hooks, signing, auto-gc and autocrlf so the user's configuration cannot change behaviour.
