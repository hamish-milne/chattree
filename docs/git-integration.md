# Git integration: plan and decisions

Status: accepted. This is the decision record for how the harness stores a conversation in Git.
Implementation proceeds in the steps listed at the end; update this file when a decision changes.

## Goals

A conversation is a Git repository. Every transcript entry is a commit, forks and subagents are branches,
and every mutation is an orchestration function that combines file changes (through the codec in `src/`)
with Git operations. It must work against any shell host (local process, container, remote machine).

## Decisions

### D1. Git is driven through the command line

Alternatives considered:

- **isomorphic-git**: pure JS and portable, but no `git worktree` and only basic merging. Subagents need both.
- **libgit2 bindings**: nodegit is unmaintained; the wasm builds are immature.
- **gitoxide, or writing objects ourselves**: write support is partial, and hand-rolling means rebuilding
  refs, locking and packing.

The CLI has the right semantics and respects the user's own configuration and tooling. The `Git` interface is
kept small so a pure-JS implementation of the read half could back a browser viewer later.

### D2. Seams

- `Host` is the shell-host seam: `exec(argv, {cwd, env, stdin, signal})` (argv array, never a shell string),
  an `Fs` (read, ranged read, stat, atomic write, durable append, exclusive create, truncate, rename, remove,
  mkdir, readdir) and path helpers. File changes and git commands must go through the same host.
  A streaming `spawn` (for `cat-file --batch`, `fast-import`) is added when needed (step 6).
- `Git` is a typed wrapper over `Host.exec`. It uses `-z` and porcelain-v2 output, `LC_ALL=C`, and disables
  prompts, hooks, signing, auto-gc and autocrlf, so the user's configuration cannot change behaviour.
- Orchestration (`harness/`) knows about entries and uses `Git`.
- Layout: `src/host.ts` and `src/git/` are runtime-independent (no Node types); `hosts/node.ts` is the only
  code that imports Node; `harness/` holds the orchestration.

### D3. Mutations are transactions

Each mutation runs through one skeleton: take the per-branch lock (exclusive create, with pid and host and
stale detection), check preconditions (tail is clean, worktree is clean, tip is as expected), apply, stage,
commit, and on failure roll back by truncating the file to its previous length.

| Operation | File effect | Git effect |
|---|---|---|
| `create` / `open` | header entry, `.gitattributes`, `harness.yml` | init, repo-local config, first commit; `open` runs recovery |
| `append` (user, assistant, tool_result) | one entry, plus blobs | one commit per entry |
| `interrupt` | `interrupted` entry holding the partial output | commit |
| `compact` | `compaction` entry (history is never rewritten) | commit |
| `changeConfig` | edit `harness.yml` keeping comments, then `config_changed` with both hashes | one commit with both |
| `fork(at)` | `branch_start` on the new branch | branch from the entry's commit, new worktree |
| `spawnSubagent` | `branch_start` with a fresh-context marker | branch, worktree, commit |
| `finishSubagent` | `subagent_result` on the parent | merge the child branch into the parent (D6) |

One commit per entry makes every entry a possible fork point. A subagent branches from the parent's commit,
so full history stays on disk, and its model context starts at its `branch_start` marker.

### D4. Commit trailers

- `Chattree-Entry: <ulid>` gives an entry-to-commit index from a single `git log`.
- `Chattree-Offset: <bytes>` is the length of `chat.yml` after the entry. The file is append-only, so history
  at any commit is a byte prefix of the tip file: the UI can show any past point without git calls or
  checkouts, and `verifyHistory()` can assert the prefix property for every commit.

Author is configurable per entry kind. Default: the user for user entries, the model for assistant entries,
the harness as committer, so `git shortlog` splits by who wrote what.

### D5. Crash safety

Order of writes is append, fsync, commit. On open: a file that ends mid-entry is truncated back to the last
complete entry; complete uncommitted entries are committed in a recovery commit; a stale lock is taken over.
Tested with a fault-injecting host that fails the nth exec call, and a random-operations fuzz test against an
in-memory model. After any failure `open()` must yield a strictly valid history.

### D6. Subagent merge policy

Default: **take the trunk on any conflict, and report exactly what happened to the parent.** It keeps the
agent moving and nothing is lost: the child's branch stays reachable as the merge's second parent.
Configurable per environment later.

Mechanics: `git merge-tree --write-tree` previews the merge without touching the worktree and yields the
conflict list and messages; the merge itself resolves content conflicts with `-X ours`, and any remaining
conflict kinds (modify/delete, binary, rename) are resolved to the trunk side explicitly. `chat.yml` always
keeps the parent's side (`merge=ours` driver set in repo-local config). The report recorded in
`subagent_result` lists files merged cleanly, files where the trunk won (with the conflict kind), and child
changes that were dropped.

### D7. Minimum git version: 2.40

`git merge-tree --write-tree` (2.38) and its `--merge-base` option (2.40) let us preview a merge and compute
the conflict report without touching any worktree, which D6 relies on. `git worktree list -z` (2.36) makes
worktree parsing unambiguous, and `commit --trailer`, `branch --show-current` and `init --initial-branch`
are all older. 2.40 is from March 2023 and is below what current distributions ship (Ubuntu 24.04: 2.43),
but older LTS releases (Ubuntu 22.04: 2.34, Debian 12: 2.39) are below it and users there must install a newer
git. The version is checked on open and fails with a clear message. Raise the floor only for a concrete need.

### D8. Workspace layout

MVP: a single repository holds `chat.yml`, `harness.yml`, `blobs/` and the files the agent works on, so
forking or rewinding restores the files as well as the chat, and subagent isolation comes from worktrees.

Planned later (not MVP): a production workspace split, with transcript and scratch files in the repo and
project code in a submodule. The submodule pointer is tracked as normal, with extra metadata (branch name,
since a submodule is detached when its head moves) and a saved working-tree diff so intra-commit changes are
kept. This separates chat from final code and lets one agent flow work across several repositories.

## Build order (status)

1. `Host` and `Fs`, the Node host, the `Git` wrapper, and tests against real git. **Done.**
2. `create`, `open`, `append`, the lock, recovery and trailers. **Done** (see notes below).
3. `fork`, the entry-to-commit index, and read-at-commit.
4. Subagents: worktrees, merge, and the result entry.
5. `compact`, `changeConfig`, `interrupt`, `verifyHistory`, and fault injection.
6. Events, the index hook, and performance work (persistent `cat-file --batch`, `fast-import`).

### Notes from step 2

- A branch's lock lives in `<common git dir>/chattree/locks/<encoded branch>.lock` and is held only for the
  duration of one mutation. A crashed process's lock goes stale after 30 s (configurable); restarting sooner
  fails with `LockHeldError` naming the holder.
- `append` commits everything in the working tree (`git add --all`), so files the agent wrote since the last
  entry are snapshotted with the entry that follows them. `.gitignore` decides what is excluded.
- Recovery stages the transcript prefix for each uncommitted entry with `hash-object` and `update-index
  --cacheinfo`, so each gets its own commit (`Chattree-Recovered: true`) without touching the worktree file.
  Workspace files are not committed by recovery; they wait for the next entry.
- A failed append is undone with `git restore --staged --worktree chat.yml`, which is also correct if the
  commit had in fact landed. Blobs written for a failed entry stay as untracked files (they are content
  addressed, so harmless) and are committed with the next entry.
- The tests crash the process at every side-effecting operation of an append and check that reopening yields
  a valid, fully committed history.
