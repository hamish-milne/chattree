# ADR 2: A `Host` seam; only one file imports Node

Status: accepted

## Context

File changes and Git commands must go through the same host, whether that is the local machine, a container or a remote machine. The core library should also be usable where Node types are not available.

## Decision

`Host` (`src/host.ts`) is the seam: `exec(argv, {cwd, env, stdin, signal})`, an `Fs` (read, ranged read, stat, atomic write, durable append, exclusive create, truncate, rename, remove, mkdir, readdir), path helpers, and an optional streaming `spawn`. `src/` and `src/git/` are runtime-independent (checked with no Node types). `hosts/node.ts` is the only code that imports Node. Orchestration lives in `harness/`.

## Why

Routing both file and process operations through one object means a remote or sandboxed host gets consistent behaviour for free, and tests can substitute a fault-injecting host that fails the nth call.

## Notes

`tsconfig.src.json` enforces the no-Node-types rule for `src/`. Tests and bench use `@types/node`.
