# ADR 29: A subagent's cost counts toward the parent's turn limit

Status: accepted

## Context

Subagent fan-out can multiply spend.

## Decision

A child's spend is recorded on its branch, summarised on the merge entry and counted toward the parent's turn limit; `max_subagent_usd` is set in the subagent tool's configuration. `subagent` has `auto` and `review` modes in `harness.yml`.

## Why

Budgets must survive forks and merges, and the parent is what the user is billed against.

## Notes

The allowed models appear as an enum in the tool's input schema and are enforced in code, because model output is never trusted.
