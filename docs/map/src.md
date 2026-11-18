# `src/`: the core library

**Purpose.** The runtime-independent core: the transcript codec, schema validation, content-addressed blobs, the `Host` seam and the Git layer. It is typechecked with no Node types (`tsconfig.src.json`), so it only uses web-standard globals and could run unchanged on Deno, Bun or a browser. Everything else in the project is built on it. Public entry: `src/index.ts` (and `./config` for `src/config.ts`, the only file that needs `yaml`).

**Sits under:** `harness/`, `providers/`, `cli/`. **Depends on:** nothing in the repo; `typebox` (through `validate.ts` only) and `yaml` (`config.ts` only).

## The transcript codec

A transcript is an append-only file of tagged entries in a strict YAML subset with exactly one valid spelling. The byte-level format is in [transcript-format.md](transcript-format.md). Reasons: ADR 10.

| File | Role |
|---|---|
| `value.ts` | The value model: `Map`-based, order-preserving maps, lists, scalars, tagged values, `BlobRef`, raw binary. Free of I/O and schema knowledge. `isEntry` guards the entry shape. |
| `scalar.ts` | Which string form to use (bare, block, double-quoted); number formatting; the strict quoted-string reader. Emit and parse share these rules. |
| `emit.ts` | The one canonical emitter. Never sees raw binary or nested tags; those are blob refs by then. |
| `parse.ts` | Line-structured reader. By default re-emits the result and requires the same bytes, so a file reads back exactly or is rejected (`ParseError`). Depth is bounded. |
| `frame.ts` | Byte-level framing: entry boundaries, truncation detection (`scan`, `validLength`), `endsCleanly`, safe `appendEntry`. Never repairs a file itself. |
| `blobs.ts` | `externalize` / `resolve` over a `BlobStore`; large strings and binary become `!blob` refs keyed by SHA-256. |
| `hash.ts` | Canonical, key-sorted hashing of values; used for config identity and pins. |
| `transforms.ts` | Functions applied just before writing: `mapStrings`, `wellFormed`, `redact`, `externalizeLarge`. Order matters: redact before externalize so secrets never reach the blob store. |
| `schema.ts` | Entry types, the `Pipeline` (plain objects with `$tag`/`$value` in, canonical entries out and back), `defineEntry`. Reading never throws: a bad entry comes back with issues and its raw value. |
| `errors.ts` | One error class per layer (emit, parse, frame, blobs, schema, git), distinguishable by `name`. |

## Validation and config

| File | Role |
|---|---|
| `validate.ts` | The one place TypeBox schemas are run: `safeParse`, `parse`, strict objects, defaults (`withDefault`), rules, readable issue messages. A schema describes final data; reads go Clone, Default, Check, Decode. Used for settings, `harness.yml`, price tables, provider config, entries, session files. ADR 11. |
| `config.ts` | Hand-edited config files: read with `yaml` (comments, flow style), edited through its comment-preserving document, validated with the same schemas and hash. Rejects anchors, aliases, custom tags, duplicate keys, multiple documents. |
| `json.ts` | Reading JSON from outside: `isJson`, `asString`, `jsonOr` and friends; each value is checked where received. |
| `nth.ts` | Item at a position the caller knows exists, without a cast. |
| `stream.ts` | Web stream chunks as `for await`. |

## The seams

| File | Role |
|---|---|
| `host.ts` | `Host`: `exec(argv, ...)`, optional streaming `spawn`, an `Fs`, path helpers. Git commands and file changes must use the same host. ADR 2. |
| `lock.ts` | Cross-process lock files over `Fs.createExclusive`, with heartbeat and stale takeover (a lock file that cannot be parsed is given a short grace to finish being written before it counts as stale). Advisory: only helps where every writer takes it. |
| `git/git.ts` | `Git`: a typed wrapper over the git command line (`-z`, porcelain v2, `LC_ALL=C`; prompts, hooks, signing, auto-gc and autocrlf off), including `switchBranch`, `detach` and `ignoredTopLevel` for swapping branches between worktrees. ADR 1. |
| `git/cat-file.ts` | A long-running `git cat-file --batch-command` session that answers many object questions with one process. |
| `git/version.ts` | Parsing `git version`; the minimum is 2.38 (ADR 7). |
| `git/index.ts` | Public surface of the git layer. Import git through it. |

## Invariants

- The parser accepts exactly what the emitter produces (canonical form). Change both together, with the fuzz and cross-check tests (`test/core/`).
- Entries are strict on read and write; there is no forward compatibility (ADR 9, ADR 12).
- Nothing in `src/` imports Node. A new need for the machine is a method on `Host`.
- A transcript is append-only. Writers check `endsCleanly()` before appending.

## To change X

- *Add a field to an entry or a new entry type:* the entry schemas live in `harness/entries.ts` (see [harness.md](harness.md)), not here; bump the format minor there.
- *Change how a value is written:* `scalar.ts` and `emit.ts`, then `parse.ts` in step, and the format doc.
- *Add a git operation:* a method on `Git` in `git/git.ts`, with a test against real git in `test/core/git.test.ts`. Keep it going through `Host.exec`.
- *Add a validation helper:* `validate.ts`; keep it generic (no harness knowledge).
