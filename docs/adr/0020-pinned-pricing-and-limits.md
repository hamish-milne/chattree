# ADR 20: Pricing is normalised and pinned by hash; limits are enforced

Status: accepted

## Context

Cost depends on price tables that change, and history should stay reproducible.

## Decision

`adapter.pricing(model)` returns dimension tables (meters, tiers, context bands). The setup records the hash of the effective table; a mismatch is a `pricing_changed` change needing an explicit mutation. Cost is derived (usage times the pinned table), not stored per entry, and the ledger is a fold over the transcript including rolled-up child usage. Limits (`max_request_usd`, `max_turn_usd`, `max_conversation_usd`, `max_requests_per_turn`, a wall-clock cap) stop a request before it is sent; `warn_at` raises a `cost` event first. An unknown price is shown as unknown, never zero; a local server is an explicit zero.

## Why

Reproducible analytics need the table as it was. `max_output_tokens` is required so the worst case can be priced.

## Notes

The pre-flight estimate prices the input plus `max_output_tokens` as fully used.
