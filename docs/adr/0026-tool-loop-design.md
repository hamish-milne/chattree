# ADR 26: The tool loop: one result per commit, ordered, did-not-run on recovery

Status: accepted

## Context

A turn can be aborted or the process can crash between tool calls.

## Decision

A turn is a user entry followed by requests until the model answers without a tool call. Foreground calls run in order, one at a time, and each result is appended and committed straight away. Calls without a result after an abort, a crash or a limit are answered with a did-not-run error. A call that may have half-finished is never re-run automatically. Limits are checked before every request. The loop lives in `harness/loop.ts`, yields events, and the CLI renders them.

## Why

A crash after the second of three calls leaves two results and one unanswered call, which the context builder already answers. Only the model, with the error in front of it, may decide to retry.

## Notes

No separate snapshot step: appending an entry commits workspace changes with it, so each `tool_result` commit holds the files as the call left them.
