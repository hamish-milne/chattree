/**
 * The shell-host seam. Everything that touches the outside world during git integration goes through a
 * `Host`: running programs and reading or writing files. A host may be the local machine, a container, a
 * remote machine over a bridge, or a test double. Git commands and file changes must use the same host, or a
 * remote host would split the two.
 *
 * Paths are host paths: absolute strings in whatever syntax the host uses. Use `host.path` to build them.
 */

export interface ExecOptions {
  /** Working directory (a host path). */
  cwd: string;
  /** Environment variables added to (and overriding) the host's base environment. */
  env?: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  signal?: AbortSignal;
  /** Fail if stdout or stderr grows beyond this many bytes (each). Default: host-defined. */
  maxOutput?: number;
}

export interface ExecResult {
  /** Process exit code. A process killed by a signal reports a non-zero code. */
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** A long-running program started with `Host.spawn`: its input stays open until `closeInput`, its output is streamed. */
export interface HostProcess {
  /** Write to the program's stdin. */
  write(data: Uint8Array): Promise<void>;
  /** Close stdin, which tells most programs to finish. */
  closeInput(): Promise<void>;
  /** The program's stdout as it arrives. Iterate it once. */
  readonly output: AsyncIterable<Uint8Array>;
  /** Stop the program. `exit` still settles. */
  kill(): void;
  /** Settles when the program has ended. */
  readonly exit: Promise<{ exitCode: number; stderr: Uint8Array }>;
}

export interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  /** Last modification time, if the host can tell. Used only to leave recent files alone when tidying up. */
  mtimeMs?: number;
}

export interface Fs {
  /** Whole file. Rejects if it does not exist. */
  read(path: string): Promise<Uint8Array>;
  /** `length` bytes from `offset`; shorter (possibly empty) if the file ends first. Rejects if the file does not exist. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Undefined if the path does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
  /** Replace the file's content atomically (write a temporary file, flush, rename), creating parent directories. */
  writeAtomic(path: string, data: Uint8Array): Promise<void>;
  /** Append bytes, creating the file (and parent directories) if needed. With `sync`, flush to stable storage before resolving. */
  append(path: string, data: Uint8Array, opts?: { sync?: boolean }): Promise<void>;
  /** Create the file with this content only if it does not exist (the basis of lock files). Resolves false if it exists. */
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  /** Shrink the file to `length` bytes, flushing the change. */
  truncate(path: string, length: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file. Resolves false if it did not exist. */
  remove(path: string): Promise<boolean>;
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Names (not paths) of a directory's entries. Rejects if it does not exist. */
  readdir(path: string): Promise<string[]>;
}

export interface PathOps {
  join(...segments: string[]): string;
  dirname(path: string): string;
}

export interface Host {
  /** Run a program with an argument array (never through a shell). Resolves for any exit code; rejects only if it cannot be started, is aborted, or exceeds `maxOutput`. */
  exec(program: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult>;
  /**
   * Start a program and keep it running, for protocols that go back and forth (`git cat-file --batch`).
   * Optional: without it callers fall back to `exec`, one process per request.
   */
  spawn?(program: string, args: readonly string[], opts: Pick<ExecOptions, "cwd" | "env">): Promise<HostProcess>;
  readonly fs: Fs;
  readonly path: PathOps;
  /** The path git should treat as "no directory" (`/dev/null`, or `NUL` on Windows). */
  readonly nullDevice: string;
}
