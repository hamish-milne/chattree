# ADR 10: The transcript is a strict, canonical YAML subset that only chattree writes

Status: accepted

## Context

Transcripts live in Git, are read in `git log -p`, and are replayed to providers, where prompt caching depends on byte-identical history.

## Decision

Entries are an append-only sequence of tagged maps in a YAML subset with exactly one valid spelling of any value. `parseEntry` succeeds only if re-emitting the parse gives back the same text, so a hand edit that is still valid YAML (other quoting, spacing, comments, anchors) is rejected. Only the codec in `src/` writes the file; other YAML tools are for inspection. An entry ends with a blank line, the only truly empty line in a valid file, which is the completion marker. Large values (over 4096 bytes) and binary values become content-addressed `!blob` references.

## Why

A single spelling makes replayed history byte-stable. The blank-line terminator lets a reader detect an interrupted write from the bytes alone, without decoding UTF-8. Writers must check `endsCleanly()` before appending, because a raw append onto a damaged tail can graft the new entry onto the broken one and still look valid (about 3% of cut points in the test corpus).

## Notes

A reader that does not know a tag keeps the value and writes it back byte for byte. `{ canonical: false }` skips the check for trusted hot paths. The byte-level format is described in the project map for `src/`.
