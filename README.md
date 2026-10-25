# chattree

Model-neutral agent harness whose conversation history lives in Git. **The MVP is complete**; what was deliberately left out is in `docs/parking-lot.md`. This repository holds: the transcript codec (`src/`), the harness schemas (`harness/`) and tests.

The codec is a proof of concept: a strict, append-only YAML-subset codec for git-backed conversation transcripts, with tagged entries, a generic schema pipeline and a config-file layer.
Format spec: [docs/format.md](./docs/format.md).

```
pnpm install
pnpm test        # 515 tests: codec, fuzz, framing, tags, cross-check against `yaml`, blobs, schema pipeline, harness schemas, config, host, git, lock, conversation, fork and subagents with crash injection, compaction/config events, history verification, random-operation fuzzing, batched git reads and fast-import, events and the index cache, an end-to-end lifecycle test, and housekeeping (blob GC, worktrees, crash debris, processes) (needs git >= 2.38 on PATH)
pnpm typecheck   # src is checked with no Node types; tests and bench with @types/node
pnpm bench       # strings vs bytes, see below
```

Needs Node >= 22.18 (native type stripping, no build step). Written against the Node 26 target;
developed on 22.23 because that is what the sandbox had.

## Layout

`src/` is the runtime-independent core library, `hosts/` the host implementations, `harness/` holds the harness-specific schemas built on it, `test/core` and `test/harness` mirror them, `docs/` has the format spec and the git integration plan.

| File | Role |
|---|---|
| `src/value.ts` | Value model (`Map`-based, order preserving), `BlobRef`, equality |
| `src/scalar.ts` | Which string form to use; quoting and escaping; strict quoted-string scanner |
| `src/emit.ts` | The one canonical emitter |
| `src/parse.ts` | Line-structured parser, then a re-emit-and-compare canonical check |
| `src/frame.ts` | Byte-level framing, truncation detection, tail checks, safe append |
| `src/blobs.ts` | `externalize` / `resolve` over a `BlobStore` interface (+ in-memory store) |
| `src/standard-schema.ts` | The Standard Schema v1 types (types only, no validator dependency) |
| `src/schema.ts` | Plain-object bridge (`$tag`, `$value`), `defineEntry`, `Pipeline` |
| `src/transforms.ts` | `mapStrings`, `wellFormed`, `redact`, `externalizeLarge` |
| `src/hash.ts` | Canonical, key-sorted hashing of values |
| `src/config.ts` | Config files: lenient comment-preserving read and edit, same schemas and hash (`./config` export; the only file that needs `yaml`) |
| `src/host.ts` | The `Host` seam: run programs (argv only) and file operations, for local, remote or test hosts |
| `src/git/` | `Git`: a typed wrapper over the git command line with fixed safety settings (see docs/git-integration.md) |
| `src/lock.ts` | Lock files with stale takeover, over `Fs.createExclusive` |
| `hosts/node.ts` | The local-machine `Host`; the only code that imports Node |
| `harness/` | The harness schemas (zod): entries, blocks, ULIDs, config; `Conversation` (create, open with crash recovery, append, entry index, fork, subagents, fork merge, compact, interrupt, config changes), the context view (`contextEntries`), `appendMany`, `onEvent` events, the entry-index cache, `gcBlobs`, `pruneWorktrees`, `close`, `verifyHistory`, `readCommitGraph`/`toMermaid` (see `docs/lifecycle-graph.md`), and the file-backed blob store |

`src/` uses only web-standard globals (`TextEncoder`, `TextDecoder`, `crypto.subtle`), so it should run
unchanged on Node, Deno, Bun and browsers. Its tsconfig has `types: []` to enforce that.

## Tags and the schema pipeline

Entry types are YAML tags (`- !assistant`), the same mechanism as `!blob`. A `Pipeline` is built from entry
types (a tag plus any Standard Schema validator: zod, valibot, arktype, or a hand-written one; the library
imports none of them) and a list of transforms.

- **Writing is strict.** `encode(obj)` validates, rejects fields the schema would silently drop, converts to
  the value model in schema-defined field order, runs the transforms (redaction before externalization),
  then decodes the result again so nothing undecodable is ever written.
- **Reading is lenient and never throws.** `decode(entry)` returns the value, or an `unknown-tag` / `invalid` /
  `untagged` result with issue paths and the raw entry, which can be written back unchanged. Fields added by a
  newer minor version are ignored; unknown entry types survive a rewrite.
- **Plain-object form.** Validators see `{ $tag: "user", ...fields }`, tagged lists and strings as
  `{ $tag, $value }`, blob references as `{ $tag: "blob", ... }`, so discriminated unions on `$tag` just work.
  JavaScript orders integer-like keys first, so such keys are reordered in this form.
- zod is a dev dependency, used only by `harness/`.

## Config files

Config uses the same schemas, validation and hashing but not the same codec. Comments in the transcript codec
would break its one-spelling rule (byte-stable replay, prompt caching) and cannot be told apart from damage in
a truncated tail. Config files are hand-edited, so they are read with `yaml` (comments, flow style, plain
scalars) and edited through its document model, which keeps comments (it may normalise spacing before a
trailing comment). Aliases, anchors, custom tags, duplicate keys, multiple documents, non-finite numbers and
non-string keys are rejected. The config hash is taken over the validated data with sorted keys, so comments,
quoting, style and key order do not change it, while values and list order do. `editConfig` re-validates
after every edit and returns nothing if the result is invalid.

## Strings or bytes?

Both, split by job. Measured on 20,000 realistic entries (8.7 MB, Node 22):

| | strings | bytes |
|---|---|---|
| framing only (find boundaries) | 40 ms (decode + `indexOf`) | 14 ms |
| load everything, canonical check on | 323 ms | 224 ms |
| load everything, canonical check off | 173 ms | 149 ms |
| open for append (check tail, read last entry) | 33 ms | **15 us** |

- **Framing on bytes.** It is faster, never needs to understand non-ASCII (your "opaque cookie" idea,
  applied where it is free), and it is the only way to handle a tail cut in the middle of a multi-byte
  character without a decode error. Opening a large file to append becomes independent of file size.
- **Parsing on strings, one entry at a time.** Strict UTF-8 decoding runs at about 290 MB/s, roughly
  15% of load time with the canonical check on (about 20% with it off); the rest is parsing. A byte-level
  parser could save at most part of that share while making escapes and block scalars harder to get
  right. Not worth it.
- **The canonical check is about 1/3 of load time** (it re-emits every entry). It is on by default and can
  be turned off per call. Incremental loading (only parse what the next request needs) matters more than
  either.

The synthetic corpus is 99.9% ASCII. Heavy CJK or emoji transcripts shift cost toward decoding, but not
enough to change the design.

## What the tests found

The oracle and the exhaustive cut-point test earned their keep. Real defects they caught:

1. A cut right after the first byte of the next entry's `- ` made `scan()` report zero valid bytes.
2. A CRLF file was reported as "one incomplete tail", which a repair routine would truncate to nothing.
   Tails are now sanity-checked (no stray control bytes, no blank line) and otherwise rejected as damage.
3. The `yaml` package's 1.1 schema reads the bare word `e5` as NaN. Exponent-like words are now quoted.
4. About 3% of cut points let a blind append graft onto the damaged entry and still produce valid
   canonical text. No byte-level check can detect that, hence `endsCleanly()` / `appendEntry()`.

## Differences from what we discussed

- **Bare words are allowed** (conservative allowlist, quoted if reserved or number-like) instead of
  quoting every string. This matches the schema example, where `type: user` is bare and ULIDs are
  quoted. Both YAML 1.1 and 1.2 parsers are checked against it in the tests.
- **Unrepresentable characters are escaped in a quoted string**, not diverted to blobs. That is lossless,
  keeps small values inline, and is fuzz-tested. Blobs are for size and binary data. A lone surrogate
  is the one thing that cannot be represented at all, and fails loudly.
- **Empty lines inside block scalars are indentation-only lines.** This is what makes the blank-line
  terminator unambiguous. Cost: trailing whitespace on those lines in `git diff`.
- **Strings ending in two or more newlines, or starting with whitespace, are quoted** rather than using
  keep-chomping or indentation indicators.
- **TypeScript 7.0.2 only knows `es2025`**, so tsconfig uses `lib: es2025`, not es2026.

## Not included yet

- A filesystem `BlobStore`, file locking, and the append-with-repair routine around `endsCleanly()`.
- Incremental context rebuild, git integration, git `textconv`/diff attributes.
- Streaming parse of a single huge entry (entries are expected to be small because large values
  are externalized).

## Benchmarks

The benchmark numbers above predate tags and were measured on untagged entries.

## Limits

Nesting depth 64, key length 4096 characters, numbers are IEEE doubles (integers beyond 2^53 are
written in their double form), strings must be well-formed Unicode.

## License

MIT, see [LICENSE](./LICENSE).
