export { BlobError, EmitError, FrameError, ParseError, SchemaError, type Issue } from "./errors.ts";
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
