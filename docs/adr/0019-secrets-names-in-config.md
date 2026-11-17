# ADR 19: Config stores names of secrets; values come from a source that cannot be committed

Status: accepted

## Context

`harness.yml` is committed and may arrive with a cloned repository.

## Decision

Config holds the *name* of an environment variable (`api_key_env`). The core never reads `process.env`; an injected `SecretSource` does. The Node entry supplies the process environment, then `<git-common-dir>/chattree/env`. A dotfile in the worktree is read only if `git check-ignore` says it is ignored. Every resolved secret is registered with the redactor, so it cannot reach the transcript, journal, logs or errors. A missing variable is an error at `open`.

## Why

The file lives inside `.git/`, shared by all worktrees and not committable by `git add -A` or `-f`.

## Notes

The CLI never prints or stores a key.
