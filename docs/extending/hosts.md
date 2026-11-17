# Hosts

A `Host` (`src/host.ts`) is everything the core needs from the machine it runs on: running programs and working with files. The core and the harness never import Node's process or file APIs; they use a host. That lets chattree run its git commands, file edits and tools in a container or on a remote machine, and lets tests substitute a host that injects faults.

## The contract

- `exec(argv, { cwd, env, stdin, signal })` runs a program. It takes an argv array, never a shell string.
- `spawn` (optional) keeps a process running with streaming input and output. `git cat-file --batch-command` and `git fast-import` use it; without it the same operations fall back to one process per request.
- `fs` is a file interface: read, ranged read, stat, atomic write, durable append, exclusive create, truncate, rename, remove, mkdir, readdir. Durable append (write, then fsync) and exclusive create (used by locks) are the two operations the transcript's crash safety rests on, so implement them with their real guarantees.
- Path helpers (join, resolve and so on) that follow the host's own conventions.

File changes and Git commands must go through the same host: a workspace that git runs in must be the one the file operations touch.

## Existing hosts

- `hosts/node.ts`: the local machine. It is the only code that imports Node.
- `hosts/busybox.ts` and `hosts/ffmpeg.ts`: helpers that fetch and run those programs through a host (busybox stands in for everyday utilities on Windows).
- Test hosts in `test/support/hosts.ts`, including one that fails the nth `exec` to test crash safety.

## Writing one

Implement the `Host` interface and run the host test suite against it (`test/hosts/`). Then pass it to `Conversation.create` / `open` and the tool set. Check specifically: argv is never reinterpreted by a shell; `signal` kills the process and its children; `exclusive create` fails if the file exists; `append` is durable when it returns.
