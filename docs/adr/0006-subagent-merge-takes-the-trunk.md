# ADR 6: A subagent merge takes the trunk on conflict and reports it

Status: accepted

## Context

When a subagent (or a merged fork) finishes, its file changes are merged into the parent. Conflicts must not stall an agent or lose work.

## Decision

Default policy: on any conflict take the trunk's version of that path, and report exactly what happened to the parent in `subagent_result` / `fork_merge` (files merged, files discarded, each conflict with Git's kind). `git merge-tree --write-tree` computes the merge in memory; every conflicted path is reset to the trunk's version in full, and `chat.yml` always keeps the parent's side.

## Why

It keeps the agent moving and loses nothing: the child's branch stays reachable as the merge's second parent. Resolution is per file, so one conflicting hunk drops the child's whole version of that file. That is a known trade-off; hunk-level (`-X ours`) would keep more but make the report less clear-cut.

## Notes

The merge commit has the parent's HEAD then the child's tip as parents and is also the entry's commit, so the first-parent index and the byte-prefix property still hold and the parent's transcript never contains the child's entries. Per-environment and hunk-level policies are in the parking lot. Producing a fork's summary is the caller's job, so the primitive makes no model calls.
