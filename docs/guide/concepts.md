# Concepts

## The conversation is a repository

A project is a Git working tree that contains `harness.yml`. Each *thread* is a branch with its own worktree (under `.chattree/threads/`). In a worktree, `chat.yml` is the transcript: an append-only file of entries (your messages, the model's replies, tool calls and results, setup changes). Every entry is its own commit, so every entry is a point you can go back to or branch from. Large outputs and attachments are stored by content hash under `blobs/`.

The workspace files the model edits live in the same repository. Going back to an earlier entry restores the files as they were, and forking from it gives the new thread those files.

You do not edit `chat.yml` by hand: chattree is the only writer, and it refuses a file it cannot read exactly. That strictness is what lets it replay history to a provider byte for byte (which keeps prompt caching working) and trust what it reads back.

## Threads, forks and merges

- A **thread** is a branch. `chattree chat <thread>` opens it, `/thread` shows or switches, `/thread new <name> [--from <entry>]` starts one, `/threads` lists them, and `/thread archive` hides one you have finished with.
- A **fork** (`/fork [<entry>] [name]`) is a side conversation from an earlier point. Editing a past message is a fork before it with the new message appended.
- **`/merge`** brings a fork back: the model's side of the discussion becomes a summary entry in the parent, and the fork's file changes are merged in. If the same file changed in both, the parent's version wins and the report says which files were dropped. A fork can be merged again after it has moved on.
- **`/undo`** takes a thread back to before your last message and puts the message back in your draft. The old tip is kept under a ref, so nothing is lost.

## Subagents

The model can start a *subagent* for a self-contained job. It begins with fresh context (just its brief), works on its own branch and worktree, and hands back a report; its file changes merge into the parent the same way a fork's do. A subagent's cost counts towards the parent's limits. Whether subagents start on their own or ask you first is set in `harness.yml`. `/runs` shows the ones working in the background.

## Agent setup

What the model *is* (its model, settings, tools, instructions, skills and the price table it is costed under) is recorded in the thread as setup entries, so history says exactly what ran. Changing any of it is an explicit action. If a change would cost money or discard the provider's prompt cache (a model switch, a tool change), chattree describes what would happen and asks you to confirm.

## Cost and limits

The ledger is computed from the conversation: usage times the pinned prices. `harness.yml` can set limits (per request, per turn, per conversation) and chattree will not send a request that would pass one. An unknown price is shown as unknown, never as zero.

## Drafts and sessions

What you have typed but not sent lives in your *session*, not in the history: the half-typed message, named drafts, staged attachments. Several sessions can work on one project, and a crashed terminal resumes with its draft.

## Context management

A long conversation can outgrow the model's context window. `/compact trim` leaves old tool output and reasoning out of what the model sees; `/compact <from> <to>` replaces a range with a summary. Both can happen automatically (set in `harness.yml`). The full history stays in Git either way.

## Code in an attached repository

Production code can live in a git submodule of the thread's repository. The thread's repository is then the scratch space and the transcript, and the submodule holds the code that is to ship. The model is free to use git inside it.

- Whatever is uncommitted in the code is recorded with every snapshot (in `attached.yml`), so rewinding or forking a thread brings the code back as it was.
- A thread other than the one in the project folder gets its own checkout of the code, detached at the commit it started from.
- Merging a fork or a subagent merges its code by what it finds. A thread that made no commits has its changes merged as files are, arriving uncommitted. One with commits that has been rebased onto a parent with nothing uncommitted is fast-forwarded in. Otherwise its commits are left on a branch, with the git commands to bring them in. A thread with both commits and uncommitted changes is told to commit or fold them first. A subagent is told this when it hands back, while it can still fix it.
