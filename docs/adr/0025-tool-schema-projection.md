# ADR 25: A tool keeps the schema its author wrote; each model is shown a projection

Status: accepted

## Context

Endpoints differ in which JSON Schema keywords they accept; MCP servers write arbitrary schemas.

## Decision

Validation uses the full schema as written (`harness/tool-schema.ts`). What a model is shown is decided per model at request time (`harness/schema-project.ts`): the full schema, or a portable subset, with the model's own info, then the adapter's, then the portable subset as the order of precedence. A schema that cannot be compiled (such as a reference to another document) is not offered.

## Why

Validation stays strict and the same for everyone while projection adapts to what an endpoint will take.

## Notes

`/mcp show` says what a portable-only model would lose.
