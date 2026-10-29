import type { BlobStore } from "../src/index.ts";
import type { Host } from "../src/host.ts";
import { pinDefinition, type ToolDefinition } from "./definitions.ts";
import type { PinnedDefinition } from "./setup.ts";
import { checkSchema, coerceArgs, validateArgs } from "./tool-schema.ts";

/**
 * The host's tool registry (docs/tools.md, sections 3 and 4): what a tool is, how its call is checked, and how
 * its output is shaped for the transcript. Running the tools and asking again is the loop's job (`loop.ts`).
 */

/** What a tool's `execute` is given. */
export interface ToolContext {
  /** Aborted when the user stops the turn (or the job). A tool must stop what it started. */
  signal: AbortSignal;
  /** The call this execution answers. */
  callId: string;
  /** The thread's worktree: the workspace, and the root every path is relative to. */
  workspace: string;
  host: Host;
  /** The conversation's blobs, for tools that read stored output (`blob:<sha256>`). */
  blobs?: BlobStore;
}

/** What a tool may look at to decide about approvals: the workspace and the host that can inspect it. */
export interface ApprovalContext {
  workspace: string;
  host: Host;
}

export interface ToolOutput {
  content: string;
  is_error?: boolean;
  /** The tool already committed the entry that answers this call (a merge's `subagent_result`): the loop records no `tool_result`. `content` is what the host shows. */
  recorded?: boolean;
}

/** A background-capable tool that was started with `background: true`: it returns at once and finishes later. */
export interface StartedJob {
  started: {
    /** One line for the call's result (`started job j1`) and for notifications. */
    summary: string;
    /** Settles when the job is over; never rejects (a failure is an `is_error` output). */
    done: Promise<ToolOutput>;
    stop(): void;
  };
}

export interface Tool {
  definition: ToolDefinition;
  /** True when the tool can be started with `background: true` (its schema then has that argument). */
  background?: boolean;
  /**
   * Repair slips specific to this tool's shape that have one possible meaning, before the schema-guided repair and the
   * validation (for example arguments one level too flat). Pure; must leave anything it does not understand alone.
   */
  normalize?(args: unknown): unknown;
  /**
   * Approvals (docs/tools.md, section 5). The keys a grant for this call would add to the tool's `allow` map in
   * harness.yml, shown to the user as "allow all of these for 5 minutes / 1 hour / forever". Usually one; a pipeline
   * with two uncovered stages returns two. `null` (also the default) means the call can only be allowed once.
   * Called on arguments that already passed validation.
   */
  allowKeys?(args: Record<string, unknown>, ctx: ApprovalContext): string[] | null | Promise<string[] | null>;
  /**
   * Given the tool's live keys other than `all`, the ones that together cover this call, or undefined if they do not.
   * Judged jointly because one call can need several keys (each stage of a pipeline). A tool that offers keys implements
   * this and answers undefined for anything it cannot be sure of; a stored key never widens beyond what `allowKeys` could
   * have offered. Default: no key covers.
   */
  covers?(keys: readonly string[], args: Record<string, unknown>, ctx: ApprovalContext): string[] | undefined | Promise<string[] | undefined>;
  /** Why a key (one the user typed or edited) is not usable for this tool, or undefined if it is. */
  validateKey?(key: string): string | undefined;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput | StartedJob>;
}

export const isStarted = (r: ToolOutput | StartedJob): r is StartedJob => "started" in r;

export class ToolError extends Error {
  override name = "ToolError";
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const t of tools) this.add(t);
  }

  /** Register a tool. Its name must be valid for every provider and its schema must be in the portable subset. */
  add(tool: Tool): this {
    const { name, description, input_schema } = tool.definition;
    if (!NAME_RE.test(name)) throw new ToolError(`tool name ${JSON.stringify(name)} must be letters, digits, _ and -, starting with a letter, at most 64 long`);
    if (this.#tools.has(name)) throw new ToolError(`tool ${name} is registered twice`);
    if (description.trim() === "") throw new ToolError(`tool ${name} needs a description`);
    const problems = checkSchema(input_schema);
    if (problems.length > 0) throw new ToolError(`tool ${name}: ${problems.join("; ")}`);
    this.#tools.set(name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** The definitions, sorted by name (the order they are rendered in must never depend on registration order). */
  definitions(): ToolDefinition[] {
    return this.names().map((n) => (this.#tools.get(n) as Tool).definition);
  }

  /** The pins for an `agent_setup` change: each definition's canonical bytes go into `blobs/`. */
  async pin(blobs: BlobStore): Promise<Record<string, PinnedDefinition>> {
    const out: Record<string, PinnedDefinition> = {};
    for (const t of this.definitions()) out[t.name] = await pinDefinition("tool", t, { store: "blob", blobs });
    return out;
  }

  /** Check a call the model made. Returns the tool, or the message to send back as an error result. */
  check(call: { name: string; args: unknown; args_raw?: string | undefined }): { tool: Tool; args: Record<string, unknown> } | { error: string } {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) return { error: `there is no tool called ${call.name}; the tools are: ${this.names().join(", ")}` };
    if (call.args_raw !== undefined) return { error: `the arguments for ${call.name} were not valid JSON: ${call.args_raw.length > 200 ? `${call.args_raw.slice(0, 200)}...` : call.args_raw}` };
    const args = coerceArgs(tool.definition.input_schema, tool.normalize === undefined ? call.args : tool.normalize(call.args));
    const problems = validateArgs(tool.definition.input_schema, args);
    if (problems.length > 0) return { error: `${call.name}: ${problems.join("; ")}` };
    return { tool, args: args as Record<string, unknown> };
  }
}

// ---- result shaping ----------------------------------------------------------------------------------------

export const DEFAULT_RESULT_LIMIT = 30_000;

export interface ShapeOptions {
  /** The most bytes of a result the model is shown. Default 30,000. */
  limit?: number;
  /**
   * Called with the full output when it is cut; returns where the model can read it (for example `blob:<sha256>`),
   * named in the marker. Without it the marker only says how much was left out.
   */
  keep?: (full: Uint8Array) => Promise<string>;
}

export interface ShapedResult {
  content: string;
  is_error: boolean;
  truncated: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Move `i` to a UTF-8 character boundary at or before it. */
const boundaryBefore = (b: Uint8Array, i: number): number => {
  while (i > 0 && i < b.length && ((b[i] as number) & 0xc0) === 0x80) i--;
  return i;
};
/** Move `i` to a UTF-8 character boundary at or after it. */
const boundaryAfter = (b: Uint8Array, i: number): number => {
  while (i < b.length && ((b[i] as number) & 0xc0) === 0x80) i++;
  return i;
};

/**
 * The transcript form of a tool's output. Output over the limit is cut to its head and tail (the start says what
 * ran, the end says how it finished) with a marker between them, and `truncated` is set.
 */
export async function shapeResult(output: ToolOutput, opts: ShapeOptions = {}): Promise<ShapedResult> {
  const limit = opts.limit ?? DEFAULT_RESULT_LIMIT;
  const is_error = output.is_error === true;
  const bytes = enc.encode(output.content);
  if (bytes.length <= limit) return { content: output.content, is_error, truncated: false };
  const where = opts.keep === undefined ? undefined : await opts.keep(bytes);
  const headEnd = boundaryBefore(bytes, Math.floor(limit * 0.7));
  const tailStart = boundaryAfter(bytes, bytes.length - (limit - Math.floor(limit * 0.7)));
  const omitted = tailStart - headEnd;
  const marker = `\n... ${omitted} of ${bytes.length} bytes omitted${where === undefined ? "" : `; the full output is ${where}`} ...\n`;
  return { content: dec.decode(bytes.subarray(0, headEnd)) + marker + dec.decode(bytes.subarray(tailStart)), is_error, truncated: true };
}
