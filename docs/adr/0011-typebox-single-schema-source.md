# ADR 11: TypeBox is the single source of truth for schemas and validation

Status: accepted

## Context

Schemas were split across `zod` (entries, config, settings) and `ajv` (tool arguments), with a Standard Schema seam between the library and callers.

## Decision

Use TypeBox: JSON Schema built with type inference, validated through `src/validate.ts` (`typebox/compile`). A schema describes the final data; defaulted fields are optional in the schema but typed present. Reads go Clone, Default, Check, Decode. Entry and config objects are strict. Tool-argument validation uses TypeBox too (`harness/tool-schema.ts`), with a golden corpus recording the known wording differences from ajv. `zod`, `ajv` and `ajv-formats` were removed.

## Why

JSON Schema is also what providers and editors consume, so one description serves validation, the editor schema generated for `harness.yml`, and tool projection to endpoints. One library is less to keep current. Wire data is validated, not asserted: `typescript/no-unsafe-type-assertion` is a lint error.

## Notes

Accepted differences from ajv: wording for `not`/`minProperties`/`contains`/`propertyNames`, `dependentRequired` is enforced, `if`/`then` names only `then`, and `nullable: true` is not supported.
