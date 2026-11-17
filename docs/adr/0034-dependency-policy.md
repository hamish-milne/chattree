# ADR 34: Dependencies are few, justified and pinned

Status: accepted

## Context

Every dependency is code to trust and keep current.

## Decision

Runtime dependencies are `typebox`, `yaml` and `file-type` (exact version). Packages are managed with pnpm, pinned by `packageManager`; the lockfile is committed and CI uses `--frozen-lockfile`. Node is `>=22.18` (native type stripping, no build step). Adding one requires saying what it does that the platform or an existing dependency cannot. Downloading or running third-party packages needs approval.

## Why

The platform has most of what we need. `yaml` is the only library that keeps comments on edit; `file-type` replaces a hand-kept signature table.

## Notes

Dependabot proposes weekly updates; GitHub Actions are referenced by major tag with the installs in one composite action.
