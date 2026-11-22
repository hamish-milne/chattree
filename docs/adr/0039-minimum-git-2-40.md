# ADR 39: Minimum Git version is 2.40

Status: accepted (supersedes ADR 7)

## Context

ADR 7 set the floor at 2.38 and noted that it had briefly been 2.40 for `git merge-tree --merge-base`, which nothing used. Attached repositories (ADR 38) now do: merging the state of the code in two threads is a three-way merge with a base that is not the commits' common ancestor (the snapshot chain links commits that are not a real history).

## Decision

Require Git 2.40. The check on open is unchanged.

## Why

`--merge-base` is the one way to merge two commits in memory against a base we choose. It is over three years old and in every current distribution's stable release except the oldest LTS ones, whose users already needed a newer Git for 2.38.

## Notes

Verified with the whole suite against 2.43. `--merge-base` takes commits, not trees: every code state is a commit (a snapshot, or HEAD when clean), so none is made up for the purpose.
