# ADR 16: A shared, replaceable HTTP base; a provider is three small functions

Status: accepted

## Context

The HTTP layer is the part most likely to change under us, and we need raw payloads to replay.

## Decision

Raw `fetch` (injectable) with replaceable pieces (`auth`, `retry`, `timeouts`, `sse`, `limiter`, `redact`, `hooks`). A provider supplies `buildRequest`, `onEvent` and `finish`. The base retries only before the first content event. A fixture recorder captures a real stream, redacts it and writes the SSE file tests replay; a conformance suite runs every adapter.

## Why

Retrying after content has streamed would repeat paid output, so the caller decides. When an API changes, the workflow is re-record, diff fixtures, fix the three functions, run the conformance suite.

## Notes

Documented in the extension guide.
