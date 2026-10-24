/** Thrown when a value cannot be written in the canonical format. */
export class EmitError extends Error {
  override name = "EmitError";
}

/** Thrown when text is not a well-formed, canonical entry. */
export class ParseError extends Error {
  override name = "ParseError";
  /** 1-based line within the entry, when known. */
  line: number | undefined;
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (entry line ${line})`);
    this.line = line;
  }
}

/** Thrown when the byte stream is not a sequence of well-framed entries. */
export class FrameError extends Error {
  override name = "FrameError";
  /** Byte offset at which the problem was detected. */
  offset: number;
  constructor(offset: number, message: string) {
    super(`${message} (byte offset ${offset})`);
    this.offset = offset;
  }
}

/** Thrown when a blob referenced by an entry cannot be found or fails verification. */
export class BlobError extends Error {
  override name = "BlobError";
}

/** One validation problem. `path` is dotted/indexed text such as `blocks[1].args.command` ("" for the root). */
export interface Issue {
  path: string;
  message: string;
}

/** Thrown when a value fails schema validation or cannot be mapped to the value model. */
export class SchemaError extends Error {
  override name = "SchemaError";
  issues: Issue[];
  constructor(issues: Issue[], context?: string) {
    const first = issues[0];
    const head = first === undefined ? "invalid value" : `${first.path === "" ? "" : first.path + ": "}${first.message}`;
    const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
    super(`${context === undefined ? "" : context + ": "}${head}${more}`);
    this.issues = issues;
  }
}

/** Thrown when a git command exits non-zero, or git is missing or too old. */
export class GitError extends Error {
  override name = "GitError";
  /** The git arguments (without the `git` program name), when the error comes from a command. */
  args: readonly string[];
  exitCode: number | undefined;
  stderr: string;
  constructor(message: string, info: { args?: readonly string[]; exitCode?: number; stderr?: string } = {}) {
    super(message);
    this.args = info.args ?? [];
    this.exitCode = info.exitCode;
    this.stderr = info.stderr ?? "";
  }
}
