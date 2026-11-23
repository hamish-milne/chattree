# ADR 38: Production code lives in attached repositories, with its uncommitted state recorded

Status: accepted (recording, restoring, per-thread checkouts, merging and the model's note are built; the editor opens an attached folder as its conversation and shows what could not be restored)

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

- **Merging** goes by what the thread did to its code, not by a mode it was given. Each state (a snapshot, or HEAD when clean) is a commit, so the states can be merged with `git merge-tree --merge-base` (hence ADR 39).
  1. No commits since the thread began: the code is merged as files are (three ways, the parent's version kept in a conflict) and lands uncommitted in the parent. Always allowed for a thread started with `integrate: share` (the default); `attached.merge.state` can turn it off for others.
  2. Commits and nothing uncommitted, in a parent with nothing uncommitted: a fast-forward, which is the thread rebasing onto the parent first. If the thread is behind, the merge stops and says `git rebase <parent branch>`. `attached.merge.rebase` can turn it off, and `integrate: parent` skips it.
  3. Otherwise (the parent is mid-work, or 2 is off): the merge changes no code. The thread's commits are left on a branch (the thread's own, or `<attached.branch_prefix>/<thread>`), and the parent's note gives the git commands, stash and pop included.
  4. Commits and uncommitted changes together are an error with commands for committing or folding the commits into the changes.
  `integrate` (`share`, `thread`, `parent`) is recorded in `branch_start` and is mostly an instruction to the thread. A subagent's own `merge` tool checks 2 and 4 before handing back, so it can fix its side.
- **The model is told** by an `attached-repos` injection (not the system prompt, whose git line now says only that git is fine in the repositories a note names): the repositories, that the workspace is scratch space and the repositories are where work that ships goes, that commits wait for the user to ask, and, for a fork or subagent, what its `integrate` asks of it. `attached.note` and `attached.guidance` switch the parts off.
- Every snapshot of the chain also keeps the repository's HEAD reachable, so commits a rebase or reset left behind survive the person's `git gc`.

## Why

A submodule gives the parts git already does well: the commit pointer, cloning with the right code, a repository the editor opens as it is. The one thing it lacks, uncommitted state, is what a rewind needs and is cheap to take with git's own objects. Keeping the record in the tree, not the transcript, makes it part of every snapshot and fork without a new mechanism.

## Consequences

- The parent's `git status` must ignore dirty submodule content (`--ignore-submodules=dirty`), since that is the harness's job, not the parent's.
- Two threads that commit in the same code repository diverge in the parent's gitlink: merging a fork or a subagent has to merge in the code repository first.
- A repository cloned without the code repository's `refs/chattree/*` can restore commits but not uncommitted state; it says so.
