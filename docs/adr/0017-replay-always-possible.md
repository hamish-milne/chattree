# ADR 17: Server-side state is an optimisation, never the only copy

Status: accepted

## Context

OpenAI can chain responses by id and compact server-side; Anthropic is stateless.

## Decision

OpenAI requests are stored by default (opt out with `store: false`). Chaining with `previous_response_id` is used only if the prefix is byte-identical to what the response saw; otherwise (or if the id expired) the full context is replayed. The adapter always requests and keeps `reasoning.encrypted_content` so replay is possible. Server-side compaction items are stored as opaque provider-tagged blocks and shown as events; our own readable `compaction` entry coexists.

## Why

The transcript must stay replayable without the provider. Stored mode keeps content on OpenAI's servers for the retention period, which the provider schema documents.

## Notes

A stored response id arrives early and goes in the journal, so crash recovery can retrieve a finished response instead of recording `interrupted`.
