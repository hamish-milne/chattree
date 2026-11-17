# ADR 28: Background jobs report through `job_event` entries

Status: accepted

## Context

A long command should not block a turn.

## Decision

A tool that declares itself background-capable can run with `background: true`. The call returns a job handle at once; when the job finishes a `job_event` entry is committed (shown to the model as a user message). Mid-loop it is delivered with the next request; when idle it is committed and the user is told, with `background.resume: true` also sending a request. `jobs`, `job_output` and `job_stop` manage jobs. After a crash, recovery marks each job lost.

## Why

Making it an entry keeps the transcript the source of truth and replayable. Resuming an idle thread costs money, so it is opt-in.

## Notes

A fork inherits a still-running parent's "started job" result; recovery on the fork marks it lost but says the parent owns it.
