# ADR 23: Injections are recorded as entries, not generated at request time

Status: accepted

## Context

Rules like near-limit warnings or the environment text must not make the context drift.

## Decision

A rule is a pure function of (entries, folded context, config, clock) that returns zero or more `{key, text}` before each request. Each result is appended as an `injection` entry. A rule's state comes from history.

## Why

The context is then identical on every later request and replays exactly. Injections are costed and audited like any message.

## Notes

The environment (system, time zone, date, workspace) is an injection, not part of the cached prefix, and is recorded only when its text would differ.
