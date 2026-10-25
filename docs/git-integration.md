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
| `mergeFork` | `fork_merge` on the parent | the same merge for a fork: summary of the discussion, file changes |

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

Mechanics: `git merge-tree --write-tree` computes the merge in memory. Every path it reports as conflicted
(content, modify/delete, file/directory, add/add, ...) is reset to the trunk's version in full, and
`chat.yml` always keeps the parent's side. So conflict resolution is per file: one conflicting hunk drops the
child's whole version of that file. (A hunk-level `-X ours` is possible later; it would keep more of the
child's work but make the report less clear-cut.) The recorded report in `subagent_result` lists the files
whose child version was merged (`changed`, `added`), the files whose child version was dropped
(`discarded`), and each conflict with git's kind (`merge.conflicts`).

### D7. Minimum git version: 2.38

The floor is the oldest release that has what the code uses: `git merge-tree --write-tree` (2.38), which
computes a merge without touching a worktree, and `git worktree list -z` (2.36). Everything else
(`commit --trailer`, `branch --show-current`, `init --initial-branch`, `merge-base --is-ancestor`) is older.
Nothing below 2.38 can work, since `merge-tree --write-tree` does not exist there.

This is verified, not assumed: the whole test suite, including the crash-injection sweeps, passes against
git 2.38.0 built from source and against 2.43.0. Ubuntu 22.04 ships 2.34, below the floor, so
users on it must install a newer git. The version is checked on open and fails
with a clear message.

The floor was 2.40 for a day, justified by `merge-tree --merge-base`, which nothing uses. Raise it again only
for a concrete need (for example `--merge-base`, or `-X` strategy options on `merge-tree`, whose first release
has not been confirmed here).

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
3. `fork`, the entry-to-commit index, and read-at-commit. **Done** (see notes below).
4. Subagents: worktrees, merge, and the result entry. **Done** (see notes below).
5. `compact`, `changeConfig`, `interrupt`, `verifyHistory`, and fault injection. **Done** (see notes below).
6. Events, the index hook, and performance work (persistent `cat-file`, `fast-import`). **Done** (see notes below).

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

### Notes from step 3

- **Entry index:** one `git log --first-parent` over the trailers, then extended in memory as the handle
  appends (no further git calls). A branch's index includes the history it was forked from.
- **Reading history:** `readEntriesUpTo(ref)` slices the working-tree transcript by the `Chattree-Offset`
  of the ref, with no git calls; `readEntriesAt(rev)` reads any revision with `git cat-file`.
- **Fork is built, not checked out.** The new branch's first commit is made with plumbing in a temporary
  index (`read-tree`, `update-index`, `write-tree`, `commit-tree`): the fork point's tree plus the transcript
  extended with `branch_start`. The branch is created last, atomically, so it exists complete or not at all;
  a crash leaves at worst an unreachable commit (collected by git's normal gc) and a temporary index file
  under `.git/chattree/tmp`. The worktree checkout is a separate, optional step, and a branch without a
  worktree is a normal state (`openBranch` checks it out). If only the checkout fails, the branch remains and
  the error is reported; retry with `openBranch`, not `fork`.
- **Forking rewinds files too:** the workspace is the fork point's tree. Uncommitted changes in the source
  worktree are not carried. Forking in the middle of a turn (for example between a tool call and its result)
  is allowed; building a model context from such a branch is the agent loop's concern.
- Editing a past message is a fork before it plus appending the new message.
- Tests crash the process at every operation of a fork.

### Notes from step 4

- **Spawn** snapshots pending workspace changes as a non-entry commit (`Chattree-Snapshot: true`, no
  `Chattree-Kind`, so the entry index skips it), then branches from that commit, so the subagent sees the
  parent's current files. Its `branch_start` has `kind: subagent`, `context: fresh`, the brief and the
  spawning call id. A long brief becomes a blob that is committed inside the new branch, not left in the
  parent's worktree.
- **Finish** runs under the parent's lock: snapshot (so the worktree is clean), `merge-tree`, build the
  merged tree with conflicted paths reset to the trunk, write the `subagent_result` entry into the
  transcript, create one merge commit (parents: the parent's HEAD, then the child's tip) that is also the
  entry's commit, and `git merge --ff-only` onto it. If the child is given as a handle its uncommitted
  workspace changes are snapshotted first; if only a branch name is given, its last commit is merged as is.
- The merge commit keeps the usual `Chattree-*` trailers, so the first-parent entry index and the byte-prefix
  property still hold: the parent's transcript never contains the child's entries (they stay on its branch).
- **Crash window:** between creating the merge commit (unreachable until the move) and the fast-forward
  finishing there is nothing to repair. If the process dies inside git's own fast-forward, reopening commits
  the already-written transcript entry as a recovery commit: the history is valid but that one commit lacks
  the child as a second parent. The tests crash the process at every operation of spawn and finish.
- The format minor version is now 1: `subagent_result` gained the optional `merge` object.
- Not yet done: removing a finished child's worktree, and a per-environment merge policy.

### Notes: merging a fork

- `mergeFork` shares all of `finishSubagent`'s machinery (D6, the notes for step 4) and records a `fork_merge`
  entry (format 1.2): the fork's branch and tip, `merge.base` (where it diverged, or where it was last
  merged), the caller's summary of what was discussed and decided, and the per-file report.
- A fork can be merged again after it moves on; each merge reports only what is new since the last. Merging
  a fork with nothing new is refused ("already merged").
- Presenting it to a model ("the user forked this conversation here, discussed X, changed Y") is a context
  builder's job; the entry carries the data for it. Producing the summary is the caller's job too, so the
  primitive stays free of model calls.

### Notes from step 5

- **Context view.** `contextEntries(entries)` (harness/context.ts) is the one definition of what the model sees:
  a compaction replaces `from..to` with its summary; it takes effect only if both ids are visible at that
  point and ordered, otherwise it is ignored. `compact` enforces the same rule up front, so a range can
  contain earlier summaries whole but never start or end inside one.
- **Config.** `harness.yml` is validated before it is written; `config_changed` records the hashes of the
  validated data (comments and layout do not count), so a comment-only edit records nothing. Hand edits show
  up as drift in `configStatus()` and are recorded by `setConfigText`/`changeConfig`. If the append fails the
  file is restored. After a crash the file may differ from the record; the next call catches it up.
- **Batched reads.** `Git.objectInfo` and `Git.readObjects` read many objects with one `cat-file --batch`
  process each, which `verifyHistory` uses so a check costs a handful of processes, not one per commit.
- **`verifyHistory(conv, {rev?, deep?})`** returns problems rather than throwing. It checks the tip transcript,
  every first-parent commit's `Chattree-Offset`/`Kind`/`Entry` trailers against the entry at that offset,
  one commit per entry, merge parents and fork points against the entries that name them, compactions,
  the config hash chain, and blob references. `deep` also compares every historical `chat.yml` and blob byte
  for byte; cheap checks cannot see an edit that preserves length. Anything that is merely odd (a recovered
  merge, a broken config chain, an ignored compaction) is a warning, not an error.
- **Random-operation test.** `test/harness/random-ops.test.ts` runs seeded sequences of appends, snapshots,
  subagents, forks and merges, compactions, config changes, interrupts and reopens against a model of the
  expected transcript, and runs a deep `verifyHistory` on every branch. Corrupted repositories are covered
  separately in `verify.test.ts`.

### Notes from step 6

Measured first (200 appends): an append cost three git processes (`add`, `commit`, and `rev-parse` to learn
the new hash), about 15 ms each.

- **Two processes per append.** `git commit` prints the new commit's hash when abbreviation is off
  (`core.abbrev=no`), so the `rev-parse` is gone (falling back to it if the output is not as expected).
  A test pins the cost at two. 200 appends went from 3.1 s to 2.4 s.
- **`Host.spawn` and `CatFileSession`.** An optional host method keeps a process running; `Git.catFile()` uses it
  for one `git cat-file --batch-command` that answers `info` and `contents` requests. Requests are written
  without waiting for earlier answers (git answers in order), so a burst costs one round trip; verifying deep
  uses windows of 32. Without `spawn` the same interface falls back to one process per request. Honest numbers:
  at 200 commits deep verification is about the same speed as the previous one-shot batches, with fewer
  processes and bounded memory; the session pays off for interleaved reads and long histories.
- **`appendMany` via `fast-import`.** N entries in a fixed number of processes (snapshot, `fast-import`,
  `reset`). Same crash story as `append`: all entries are written to the transcript first, so a crash before
  the branch moves leaves them for `open` to commit (the crash sweep checks every failure point: all or none
  survive, history verifies). The ref moves once, when the stream ends. Each blob arrives with the first
  entry that refers to it. Commits bypass the index, so `git reset --mixed` realigns it afterwards (best
  effort: the next staging heals it). Pending workspace changes go into a snapshot commit first.
- **Events.** `ConversationOptions.onEvent` receives `entry`, `snapshot`, `branch`, `merge` and `recovery`
  events after the change is committed, in order, through a per-handle queue. A slow or throwing handler never
  delays or fails the operation (`onEventError` hears of it); `flushEvents()` waits for delivery. Handles for
  forks and subagents inherit the handler. Entries `open` recovers are reported as `recovered` entry events.
- **Index cache (the hook).** The entry index is derived data. `IndexCache` is the interface; the default
  `FileIndexCache` keeps one JSON file per branch under the git directory (never committed). On a cold
  open the cached index is extended with only the commits newer than its tip; a damaged, unknown or
  non-ancestor cache is ignored and the index rebuilt. `flushIndex()` saves on demand.
- **Lifecycle test and graph.** `test/integration/lifecycle.test.ts` runs one conversation through everything
  (work with large blobs, bulk import, compaction, config change, interruption, a fork merged with a
  conflict, an abandoned fork, two subagents, a crash mid-append and recovery), then checks every branch with
  deep `verifyHistory`, `git fsck --strict`, events against history, and the cache against a rebuild. The graph
  is in `docs/lifecycle-graph.md`.
- **Not done:** orphaned-blob GC, removing finished child worktrees, and a persistent `fast-import` process
  (a single batch already makes bulk writes constant-cost; per-append use would need the index kept in step).
