# ADR 8: One repository holds transcript, config, blobs and workspace files

Status: accepted

## Context

Forking or rewinding a conversation should restore the files the agent worked on as well as the chat.

## Decision

A single repository holds `chat.yml`, `harness.yml`, `blobs/` and the workspace. Subagent isolation comes from worktrees.

## Why

Putting files and chat in one history makes fork points whole snapshots. Forking builds the fork point's tree, so uncommitted changes in the source worktree are not carried.

## Notes

A production split (transcript and scratch in the repo, project code in a submodule with extra metadata and a saved diff) is planned, not built.
