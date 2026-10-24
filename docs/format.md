# Transcript file format (v0 draft, with tags)

A transcript file is an append-only sequence of **entries**. It is a valid YAML document (one block
sequence of maps) and is meant to be readable in `git log -p`, but **only this library may write it**.
Other YAML tools are for inspection. The parser accepts exactly what the emitter produces.

## File

- UTF-8, LF line endings, no byte order mark. CR, BOM and invalid UTF-8 are errors.
- Zero or more entries, back to back. Nothing before the first entry, nothing between entries.
- Set `-text` / `-diff` style attributes so git never rewrites line endings:
  `*.yml -text` (or `* -text` in the conversation repository).

## Entry

```
- !user
  id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D"
  content:
  - !text
    text: |-
      Fix the failing test.

      It fails with:
        expected `a`
<blank line>
```

- An entry starts with `- ` in **column 0**. No other construct may put `- ` in column 0.
- An entry ends with a **blank line** (`\n\n` after its last line). This is the completion marker.
- The terminator is the **only truly empty line** in a valid file. Empty lines inside block scalars are
  written as indentation-only lines (`      `), so the marker can never be confused with content.
- The entry value is a map (possibly empty, written `- {}`), optionally **tagged**: `- !user` with the fields
  two columns in. The tag is the entry type. An empty tagged entry is `- !tag {}`.

## Framing and truncation (byte level)

Framing needs no UTF-8 decoding:

1. Entry starts are the offsets where `- ` follows a line feed (or start the file). A lone `-` at the end
   of the file counts as the start of a cut-off entry.
2. An entry is **complete** if its last two bytes are LF LF. Every non-final entry must be complete,
   otherwise the file is damaged (`FrameError`).
3. If the final chunk is incomplete it is a **truncated tail** (an interrupted write). `scan()` reports
   `validLength`; truncating there removes the tail and nothing else.
4. A tail is only accepted as "merely truncated" if it could be a prefix of a valid entry: no control
   bytes other than LF and TAB, no blank line inside it. Otherwise it is damage and is not discarded.

**Appending.** A raw append onto a damaged tail can graft the new entry onto the broken one and still
yield valid canonical text (about 3% of cut points in the test corpus). So writers must check
`endsCleanly()` (file is empty or ends with LF LF; two bytes to read) before appending, and repair
(truncate to `validLength`) first if it does not. `appendEntry()` enforces this.

## Values

Maps preserve insertion order. Keys and values may be nested to depth 64 (the entry's own map is depth 1).

| Value | Written as |
|---|---|
| null, booleans | `null`, `true`, `false` |
| numbers | JS shortest round-trip form: `-5`, `0.5`, `1e+21`. No NaN, Infinity or negative zero. |
| empty list / map | `[]` / `{}` |
| string | one of three forms below |
| blob reference | `!blob {sha256: "<64 hex>", bytes: N}` with optional `, mime: "type/subtype"` |
| tagged value | `!name` before a map, list or string (see Tags) |

### Strings

1. **Bare** if it matches `[A-Za-z_][A-Za-z0-9_.-]*` and is not a word some YAML parser would read as
   another type: `y n yes no true false on off null` (any case) or anything starting with `e`/`E` and a digit
   (the YAML 1.1 float rule in the `yaml` package reads `e5` as NaN).
2. **Literal block scalar** (`|` clip, `|-` strip) if it contains a newline, no raw control or Unicode line
   separator characters, does not end with two newlines, and its first line is non-empty and does not start
   with a space or tab. Content is indented two columns past its key (or `-`). Lines are written verbatim,
   trailing spaces included.
3. **Double-quoted** otherwise, always on one line. Escapes: `\"` `\\` `\n` `\r` `\t`, and `\uXXXX` (lowercase
   hex) for other C0 controls, DEL and C1 controls, U+2028, U+2029, U+FEFF, U+FFFE, U+FFFF. Astral and other
   printable characters stay raw. The empty string is `""`.

Strings must be well-formed Unicode: a lone surrogate cannot be encoded as UTF-8 and is an `EmitError`.
Sanitize with `toWellFormed()` where data enters the harness.

### Keys

Same bare/quoted rule as strings (never block form). Longer than 4096 characters is an error.

### Layout

- Map under a key: next line, two columns deeper.
- List under a key: next line, **same column as the key** ("compact"); each item is `- `.
- Map inside a list item: first key on the `- ` line, remaining keys two columns past the dash.
- List inside a list: `-` alone on its line, items two columns deeper.

## Tags

A tag names the schema of the value it precedes. Entries use them for their type (`- !user`), and content
blocks inside entries use them for theirs (`- !text`, `- !tool_call`). A tag may wrap only a **map, list or
string**, never a number, boolean or null. Names match `[A-Za-z][A-Za-z0-9_./-]*`, at most 128 characters.
`blob` is reserved for blob references.

| Where | Written as |
|---|---|
| entry | `- !user` then the fields at column 2 |
| under a key, map | `key: !tag` then the fields two columns deeper |
| under a key, list | `key: !tag` then the items at the key's column (compact) |
| under a key, string | `key: !tag "text"` or `key: !tag |-` followed by the block |
| list item, map | `- !tag` then the fields two columns past the dash (never compact) |

A reader that does not know a tag keeps the value and writes it back byte for byte. Because the tag is
the first token of an entry, `peekTag()` reads an entry's type from the bytes without parsing it.
Schemas, validation and transforms are applied by the `Pipeline` (see README), not by the codec.

## Canonical form

`parseEntry(text)` succeeds only if `emitEntry(parse(text)) === text`. There is exactly one valid
spelling of any value, so a hand edit that is still valid YAML (different quoting, spacing, comments,
anchors) is rejected rather than silently normalised. This makes replayed history byte-stable, which
prompt caching depends on. `{ canonical: false }` skips the check for trusted hot paths.

## Large values

`externalize()` replaces any string over a byte threshold (default 4096) and any binary value with a
`!blob` reference to content-addressed storage (SHA-256 of the raw bytes). `mime: "text/plain"` means
UTF-8 text and resolves back to a string. `resolve()` verifies size and hash.
