export { BlobError, EmitError, FrameError, GitError, ParseError, SchemaError, type Issue } from "./errors.ts";
export { BlobData, BlobRef, MAX_DEPTH, TAG_NAME, Tagged, fromPlain, toPlain, valueEquals, type Entry, type Value } from "./value.ts";
export { emitEntry } from "./emit.ts";
export { parseEntry, type ParseOptions } from "./parse.ts";
export {
  appendEntry,
  decodeSpan,
  decodeStrict,
  encodeEntry,
  endsCleanly,
  lastCompleteSpan,
  parseFile,
  peekTag,
  scan,
  type ParsedFile,
  type ScanResult,
  type Span,
} from "./frame.ts";
export {
  MemoryBlobStore,
  TEXT_MIME,
  externalize,
  externalizeValue,
  resolve,
  sha256Hex,
  type BlobStore,
  type ExternalizeOptions,
  type ResolveOptions,
} from "./blobs.ts";
export type { StandardIssue, StandardResult, StandardSchemaV1 } from "./standard-schema.ts";
export {
  Pipeline,
  TAG_KEY,
  VALUE_KEY,
  defineEntry,
  findDropped,
  objectToValue,
  valueToObject,
  type DecodeResult,
  type EntryType,
  type PipelineOptions,
} from "./schema.ts";
export { externalizeLarge, mapStrings, mapValueStrings, redact, wellFormed, type Transform } from "./transforms.ts";
export { canonicalText, hashValue, sortKeysDeep } from "./hash.ts";
export type { ExecOptions, ExecResult, FileStat, Fs, Host, HostProcess, PathOps } from "./host.ts";
export * from "./git/index.ts";
export { LockHeldError, acquireLock, withLock, type Lock, type LockInfo, type LockOptions } from "./lock.ts";
