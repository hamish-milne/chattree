# ADR 15: Provider adapters are stateless functions from context to an event stream

Status: accepted

## Context

Anthropic, OpenAI (Responses and Chat Completions), Gemini and local servers differ in request shape, streaming, state and caching.

## Decision

A `ProviderAdapter` has a `$tag`, a provider schema, a settings schema per model, `catalog()`, `pricing()`, `classify()`, `estimate()` and `stream()`. `stream` is an async generator that yields neutral events (`started`, `text.delta`, `reasoning.delta`, `tool_call.start/.delta`, `block.done`, `usage`, `observed`), returns `Completed` or throws `ProviderError { kind, retryable, partial }`. Exactly one terminal state per stream. A pure context builder (`buildContext`) comes first: it renders entries with no provider equivalent as text with fixed wording.

## Why

The adapter owns what the provider knows; the harness only asks through the interface. Opaque payloads are kept exactly as sent so they can be replayed.

## Notes

An interrupted partial never replays as a live tool call. Reasoning is replayed only to the model that produced it.
