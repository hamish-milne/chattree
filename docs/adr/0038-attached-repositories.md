# ADR 38: Production code lives in attached repositories, with its uncommitted state recorded

Status: accepted (recording, restoring and per-thread checkouts are built; merging, the prompt and editor support follow)

## Context

ADR 8 put the transcript, the config and the workspace in one repository so a fork point is a whole snapshot. That suits scratch work, but production code usually has a repository of its own, with its own history, branch and remote, and the person edits it in their editor while the agent works.

## Decision

The thread's repository stays the scratch space and the transcript. Production code is a git submodule of it (an *attached repository*); the harness treats every checked-out submodule as one.

- **The commit** is recorded as git records any submodule.
- **The rest is recorded by the harness.** Git's parent repository sees nothing of a submodule's uncommitted work, so before each snapshot of the thread's worktree `syncAttached` writes `attached.yml` (path, branch checked out, HEAD, and a snapshot commit when the working tree differs from HEAD). The file is tracked, so it rewinds and forks with the files, and a change that is only uncommitted still gives the parent something to commit.
- **A snapshot is an ordinary commit** in the attached repository, built in a private per-thread index (the repository's own index and stat cache are not touched). Its parents are HEAD and the thread's previous snapshot; `refs/chattree/snapshots/<thread>` keeps the chain from being collected. Git stores it as it stores everything else: shared, compressed, fetchable. No diff format of our own.
- **Restoring** resets the branch to the recorded commit, applies the snapshot tree on top and leaves the changes uncommitted, as the person would have made them. What was there is snapshotted first, and commits the branch loses are kept under `refs/chattree/undone/<thread>/`.
- The thread in the project folder works directly on the code checked out there. Every other thread's worktree gets its own checkout of the code repository, a linked worktree of the one in the project folder, on a branch of its own (`chattree/<thread>`) cut from the recorded commit with the recorded uncommitted state applied. Removing a thread's worktree removes that checkout; the branch stays.
- Switching the project folder to another thread trades the code with it: both folders' repositories are detached and put to the state each thread recorded. The person's own branch stays with the thread that was on it, unless it has moved on since, when the thread continues on a `chattree/` branch.
- Every append commits `attached.yml` with the entry (a single `append` commits the worktree's changes together with the entry, `appendMany` snapshots first), so the record is never behind the transcript.
- The model commits in an attached repository only when the person asks (a line in their instructions can make that standing).

## Why

A submodule gives the parts git already does well: the commit pointer, cloning with the right code, a repository the editor opens as it is. The one thing it lacks, uncommitted state, is what a rewind needs and is cheap to take with git's own objects. Keeping the record in the tree, not the transcript, makes it part of every snapshot and fork without a new mechanism.

## Consequences

- The parent's `git status` must ignore dirty submodule content (`--ignore-submodules=dirty`), since that is the harness's job, not the parent's.
- Two threads that commit in the same code repository diverge in the parent's gitlink: merging a fork or a subagent has to merge in the code repository first.
- A repository cloned without the code repository's `refs/chattree/*` can restore commits but not uncommitted state; it says so.
