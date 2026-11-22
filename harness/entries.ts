/**
 * The entry types of a thread's transcript (`chat.yml`, in the canonical format of `src/`), with its format version in a
 * header entry. Everything the harness records (messages, model output, tool results, compactions,
 * setup changes, approvals) is one of these, so every reader and writer goes through this module's schemas. Objects
 * are strict: an unknown field is an error, not something to ignore, so an older build never silently drops data it
 * does not understand (see `EntryReader` for how versions gate it). Built on the generic pipeline in `src/`.
 */

import { Type, type Static } from "typebox";
import {
  Pipeline,
  Tagged,
  defineEntry,
  externalizeLarge,
  redact,
  type BlobStore,
  type DecodeResult,
  type Entry,
  type EntryType,
  type Transform,
} from "../src/index.ts";
import { pattern, strictObject } from "../src/validate.ts";
import { ULID_RE } from "./ulid.ts";

/**
 * Format version recorded in the header entry. A minor bump widens what an entry may hold (a new optional field, a new
 * entry type), so a build that reads minor N reads every file of minor N or below; a file of a higher minor may hold
 * what this build does not know, which is an error (update chattree), not something to skip. A major bump narrows or
 * changes it (a new required field), and a build reads only the majors it has entry types for (`entryTypesByMajor`).
 */
export const FORMAT = { format: "chatlog", major: 2, minor: 11 } as const;

// ---- building blocks -------------------------------------------------------------------------------------

const nonEmpty = Type.String({ minLength: 1 });
const ulid = pattern(ULID_RE, "not a ULID");
const sha256 = pattern(/^[0-9a-f]{64}$/, "not a lowercase hex SHA-256");
const count = Type.Integer({ minimum: 0 });
/** Free-form JSON-like data: tool arguments, provider round-trip data. */
const json = Type.Record(Type.String(), Type.Unknown());

/** The plain-object form of a blob reference (`!blob {...}` in the file). */
export const blobRef = strictObject({ $tag: Type.Literal("blob"), sha256, bytes: count, mime: Type.Optional(Type.String()) });
/** Text that is either inline or, once large, a blob reference. */
const text = Type.Union([Type.String(), blobRef]);

// ---- content blocks (tagged values inside entries) ---------------------------------------------------------

/** Provider round-trip data for one block (an item id that replay needs, a cache marker). Opaque to the harness. */
const blockExt = Type.Optional(json);
const textBlock = strictObject({ $tag: Type.Literal("text"), text, ext: blockExt });
const reasoningBlock = strictObject({
  $tag: Type.Literal("reasoning"),
  provider: Type.String(),
  /**
   * What the provider needs back that `visible` does not hold, as the provider's own object (an Anthropic thinking block
   * without its text, redacted thinking, an OpenAI reasoning item). Opaque to the harness; absent when `visible` is all
   * there is to replay.
   */
  payload: Type.Optional(json),
  /** Readable form of the reasoning when the provider exposes one. */
  visible: Type.Optional(text),
  ext: blockExt,
});
const toolCallBlock = strictObject({
  $tag: Type.Literal("tool_call"),
  call_id: Type.String(),
  name: Type.String(),
  /**
   * Arguments as the model gave them; a string longer than the externalizing threshold is a blob reference inside
   * (`inlineBlobs` puts it back).
   */
  args: json,
  /** The provider's original argument string, kept when it was not valid JSON. */
  args_raw: Type.Optional(text),
  ext: blockExt,
});
/**
 * A provider's own compaction of the conversation so far: opaque, replayed only to the model that made it. Not the
 * readable `compaction` entry.
 */
const providerCompactionBlock = strictObject({
  $tag: Type.Literal("provider_compaction"),
  provider: Type.String(),
  payload: text,
  ext: blockExt,
});
/**
 * `charset`: how to read the bytes of a text file that is not UTF-8 (a label such as `windows-1252`); the blob's `mime`
 * stays a bare `type/subtype`.
 */
const attachmentPart = strictObject({
  $tag: Type.Literal("attachment"),
  name: Type.Optional(Type.String()),
  charset: Type.Optional(Type.String()),
  data: blobRef,
});

const assistantBlock = Type.Union([textBlock, reasoningBlock, toolCallBlock, providerCompactionBlock]);
const userPart = Type.Union([textBlock, attachmentPart]);

// ---- entries -----------------------------------------------------------------------------------------------

export const header = strictObject({
  $tag: Type.Literal("header"),
  format: Type.Literal(FORMAT.format),
  major: count,
  minor: count,
});

export const user = strictObject({
  $tag: Type.Literal("user"),
  id: ulid,
  content: Type.Array(userPart),
  /**
   * Sent while the thread was working (format 2.3). It sits wherever it was appended, which may be between a tool call and its result;
   * the model is shown it after the results that close the turn, in the next request.
   */
  queued: Type.Optional(Type.Boolean()),
  /**
   * The thread that sent it (format 2.6), for a message one thread wrote to another with `thread_send`; absent for what a person typed. The
   * text itself starts with a line naming the sender, so the model reads it the same way (renderers are frozen and know
   * nothing of this field).
   */
  from: Type.Optional(Type.String()),
});

export const assistant = strictObject({
  $tag: Type.Literal("assistant"),
  id: ulid,
  provider: Type.String(),
  model: Type.String(),
  blocks: Type.Array(assistantBlock),
  stop_reason: Type.String(),
  /**
   * The id of the last entry the request that produced this one was built from (format 2.3): a user message with a later
   * id was not seen by it.
   */
  context_tip: Type.Optional(ulid),
  /**
   * Pictures and sound the request sent in another format than the thread holds, and what converted them: what the model
   * was shown, where it differs from the entries before this one.
   */
  converted: Type.Optional(
    Type.Array(strictObject({ name: Type.Optional(Type.String()), from: Type.String(), to: Type.String(), converter: Type.String() })),
  ),
  /** Whatever token counts the provider reports; field names differ between providers. */
  usage: Type.Optional(Type.Record(Type.String(), Type.Number())),
  /** Provider round-trip data that has no place in the blocks (response ids, item ids, cache hints). */
  ext: Type.Optional(json),
});

export const toolResult = strictObject({
  $tag: Type.Literal("tool_result"),
  id: ulid,
  call_id: Type.String(),
  is_error: Type.Boolean(),
  content: text,
  truncated: Type.Optional(Type.Boolean()),
  /** When `content` was cut short, the whole output (format 1.3). A reference, so the blob is kept for as long as the entry is. */
  full: Type.Optional(blobRef),
  /** Pictures, sound or documents the tool gave the model besides its text (format 2.7); each blob has its media type. */
  media: Type.Optional(Type.Array(strictObject({ name: Type.Optional(Type.String()), data: blobRef }))),
});

export const compaction = strictObject({
  $tag: Type.Literal("compaction"),
  id: ulid,
  replaces: strictObject({ from: ulid, to: ulid }),
  summary: text,
  /** The model that wrote the summary, when one did. */
  model: Type.Optional(Type.String()),
  /** What writing it used (format 2.5, normalised names as in `assistant.usage`): counted in the ledger like a response. */
  usage: Type.Optional(Type.Record(Type.String(), Type.Number())),
  /** Who asked for it (format 2.5): the user, or the harness at the configured threshold. Absent on older entries (the user). */
  by: Type.Optional(Type.Enum(["user", "auto"])),
});

/**
 * What a trim leaves out of the entries it covers (format 2.5). Each part is optional; an absent part leaves that kind of content whole.
 * Sizes are UTF-8 bytes. The words of the user and of the model are never touched, nor are tool names and the shape of the arguments.
 */
export const trimRule = strictObject({
  /** Leave out the output of tool calls of at least this many bytes (the model is told how large it was). */
  tool_results: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Leave out text values of at least this many bytes inside the arguments of tool calls (a file written, a patch). */
  tool_args: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Leave out the model's reasoning. */
  reasoning: Type.Optional(Type.Boolean()),
});

/**
 * A trim (format 2.5): from this point on, the model is shown the entries up to and including `upto` with the bulky parts `rule` names left
 * out. Nothing is rewritten or deleted (see `contextEntries` and `trimRules`); several trims add up, the strictest part of each applying.
 * Like a compaction it rewrites the prefix of the history, so it folds lagging appends in and loses the cache once.
 */
export const trim = strictObject({
  $tag: Type.Literal("trim"),
  id: ulid,
  upto: ulid,
  rule: trimRule,
  /** Who asked for it: the user (`/compact trim`) or the harness at the configured threshold. */
  by: Type.Enum(["user", "auto"]),
});

// ---- agent_setup: the agent's state, folded per branch -----------------------------------------------------

/** What a change to an agent's setup would do. Which of these a given change causes is the provider adapter's call. */
export const CHANGE_KINDS = [
  "model_changed",
  "provider_changed",
  "cache_break",
  "cost_increase",
  "context_overflow",
  "reasoning_dropped",
  "capability_loss",
  "mid_loop",
  "tools_changed",
  "instructions_changed",
  "pricing_changed",
  "resolved_model_changed",
  "renderer_changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
const changeKind = Type.Enum(CHANGE_KINDS);

/** A pinned definition (tool, instructions, skill, MCP server): the hash of its canonical form and where the bytes live. */
export const pinnedDefinition = strictObject({
  hash: sha256,
  /** `blob`: the canonical bytes are in `blobs/`. `external`: only the hash is here and the host's source serves the bytes. */
  store: Type.Enum(["blob", "external"]),
  /** For `external`: the host's locator (a path in a shared submodule, say). */
  ref: Type.Optional(Type.String()),
});
const definitionDelta = strictObject({
  set: Type.Optional(Type.Record(Type.String(), pinnedDefinition)),
  remove: Type.Optional(Type.Array(Type.String())),
});

export const agentSetup = strictObject({
  $tag: Type.Literal("agent_setup"),
  id: ulid,
  /** `provider` and `resolved` are written when a response reports a different model than the setup says. */
  reason: Type.Enum(["user", "fork", "subagent", "provider", "resolved"]),
  /** Always complete when present: the whole model block replaces the previous one. */
  model: Type.Optional(
    strictObject({
      provider: nonEmpty,
      /** What was asked for; may be an alias. */
      id: nonEmpty,
      /** The dated model the provider reported serving; requests use it once known. */
      resolved: Type.Optional(nonEmpty),
      settings: Type.Optional(json),
    }),
  ),
  tools: Type.Optional(definitionDelta),
  instructions: Type.Optional(pinnedDefinition),
  /**
   * Instruction files (format 2.8): canonical path to the SHA-256 of the file's content, which is in `blobs/`. A relative path is a
   * file of the repository, which the harness looks at before each request and records here when it differs; any other
   * path is a file the host passed in (absolute), which is only ever what it was when it was given. Only the paths that change
   * are written: `null` removes one, and a path that is not mentioned keeps what it had.
   */
  files: Type.Optional(Type.Record(nonEmpty, Type.Union([sha256, Type.Null()]))),
  skills: Type.Optional(definitionDelta),
  mcp: Type.Optional(definitionDelta),
  /**
   * The renderer that turns structured entries into text for the model (`chattree-english-v1`); immutable per id. Unset
   * means the default.
   */
  renderer: Type.Optional(nonEmpty),
  /** The hash of the price table this agent is costed under. */
  pricing: Type.Optional(strictObject({ table: sha256 })),
  /** Change kinds the caller allowed for this mutation. */
  allow: Type.Optional(Type.Array(changeKind)),
  /** For `provider` and `resolved` entries: the kinds the observed change would have been classified as. */
  changes: Type.Optional(Type.Array(changeKind)),
  /** Provider-observed `agent_setup` entries this one accepts. */
  acknowledges: Type.Optional(Type.Array(ulid)),
  /**
   * How a change to the instructions (or skills, or instruction files) reaches the model (format 2.4). `append`: the cached prefix keeps the text it had, and the
   * model is told of the change at this point in the conversation, so nothing before it is re-read. `rebuild`: the prefix
   * is rewritten from the
   * setup as it is after this entry, and earlier `append` changes are folded into it. Absent on entries that change neither (and on entries
   * from before 2.4, where a change to the instructions always rewrote the prefix).
   */
  apply: Type.Optional(Type.Enum(["append", "rebuild"])),
});

/**
 * Text the harness put in front of the model (format 2.4): a usage warning, a reminder every N turns, a rule's output. Recorded, not
 * generated at request time, so the context is the same on every later request, replays exactly, and is paid for and
 * audited like any message.
 * `key` names the rule that wrote it, so "every N turns" can be answered from the history alone.
 */
export const injection = strictObject({
  $tag: Type.Literal("injection"),
  id: ulid,
  key: nonEmpty,
  text,
});

/**
 * Which files the model has seen, and at what version (format 2.10). Bookkeeping: the model is not shown it. A tool that read or wrote
 * a file adds a line for it (`files`); before each request the harness compares those versions with the files as they are now. When it
 * has told the model of a change (an `injection` under `external-changes`) it adds the new versions here, and names in `dropped` the
 * files whose version it could not give (too large, deleted, or no longer relevant), which the model must read again.
 * `version` is the 8 hex digits the file tools show; `blob` is the git object id of the same bytes, so the old text can be found again
 * for a diff whatever happened to the history in between.
 */
export const fileTouch = strictObject({
  $tag: Type.Literal("file_touch"),
  id: ulid,
  files: Type.Optional(
    Type.Array(
      strictObject({
        path: nonEmpty,
        version: Type.String({ pattern: "^[0-9a-f]{8}$" }),
        blob: Type.String({ pattern: "^[0-9a-f]{40}([0-9a-f]{24})?$" }),
      }),
      { minItems: 1 },
    ),
  ),
  dropped: Type.Optional(Type.Array(nonEmpty, { minItems: 1 })),
});

export const branchStart = strictObject({
  $tag: Type.Literal("branch_start"),
  id: ulid,
  kind: Type.Enum(["fork", "subagent"]),
  from: strictObject({ branch: Type.String(), commit: Type.String() }),
  context: Type.Enum(["inherit", "fresh"]),
  /** For a subagent: the task it was given. */
  brief: Type.Optional(text),
  /** For a subagent: the tool call in the parent that started it. */
  call_id: Type.Optional(Type.String()),
  /**
   * How code in attached repositories is meant to come back (format 2.11, ADR 38). `share`, or none: the changes stay uncommitted and merge
   * as the files do. `thread`: the thread commits and rebases onto its parent's code before merging. `parent`: the thread commits and its
   * parent integrates the branch. Mostly an instruction to the thread; `merge` goes by what it finds.
   */
  integrate: Type.Optional(Type.Enum(["share", "thread", "parent"])),
});

/**
 * What reached the parent in a merge: `changed` and `added` are files whose child version was merged;
 * `discarded` are files the child changed whose version was dropped because the parent's version won a conflict.
 */
const mergedFiles = strictObject({
  changed: Type.Array(Type.String()),
  added: Type.Array(Type.String()),
  discarded: Type.Array(Type.String()),
});

/**
 * What happened to the code of one attached repository in a merge (format 2.11, ADR 38). `note` is what the parent is told: what
 * landed, or where the commits are and the git commands to bring them in.
 */
const codeMerge = strictObject({
  path: Type.String(),
  outcome: Type.Enum(["merged_state", "fast_forward", "left"]),
  /** For `left`: the branch that holds the thread's commits. */
  branch: Type.Optional(Type.String()),
  note: text,
});

/** How a merge went. With policy "trunk" every conflict was resolved to the parent's version. */
const mergeReport = strictObject({
  policy: Type.Literal("trunk"),
  /** The commit the child branch diverged from (or was last merged at). */
  base: Type.String(),
  conflicts: Type.Array(strictObject({ path: Type.String(), kind: Type.String() })),
});

/** What a merged branch cost, so budgets survive the merge: priced under the child's own pinned tables when it was merged. */
const spendRollup = strictObject({
  usd: Type.Number({ minimum: 0 }),
  requests: Type.Integer({ minimum: 0 }),
  /** Requests whose price was unknown (`usd` leaves them out). */
  unpriced: Type.Integer({ minimum: 0 }),
});

export const subagentResult = strictObject({
  $tag: Type.Literal("subagent_result"),
  id: ulid,
  call_id: Type.String(),
  branch: Type.String(),
  tip: Type.String(),
  summary: text,
  files: mergedFiles,
  /** Format 1.1. */
  merge: Type.Optional(mergeReport),
  /** What came of the code in attached repositories (format 2.11). Absent when none changed. */
  code: Type.Optional(Type.Array(codeMerge)),
  /** What the subagent spent. */
  spend: Type.Optional(spendRollup),
});

/**
 * A fork merged back into the branch it came from (format 1.2). `summary` is what was discussed and decided
 * in the fork; `merge.base` is where the fork diverged, or where it was last merged.
 */
export const forkMerge = strictObject({
  $tag: Type.Literal("fork_merge"),
  id: ulid,
  /** Format 2.1: the `merge` tool call this merge answers, when the model asked for it (otherwise the entry is a user-side notice). */
  call_id: Type.Optional(Type.String()),
  branch: Type.String(),
  tip: Type.String(),
  summary: text,
  files: mergedFiles,
  merge: mergeReport,
  /** What came of the code in attached repositories (format 2.11). Absent when none changed. */
  code: Type.Optional(Type.Array(codeMerge)),
  /** What the fork spent since it diverged, or since it was last merged. */
  spend: Type.Optional(spendRollup),
});

/**
 * A background job ended (format 1.4). Committed on the branch when the job finishes (or is found lost after a crash)
 * and shown to the model as a user message. `call_id` is the call that started the job, whose result said `started job <id>`.
 */
export const jobEvent = strictObject({
  $tag: Type.Literal("job_event"),
  id: ulid,
  /** The job's id on this branch (`j1`). */
  job: nonEmpty,
  call_id: Type.String(),
  /**
   * `completed`: it ended and succeeded; `failed`: it ended with an error or timed out; `stopped`: stopped on request;
   * `lost`: the process that ran it ended first.
   */
  status: Type.Enum(["completed", "failed", "stopped", "lost"]),
  /** One line: what it was and how it ended. */
  summary: text,
  /** Everything it printed (a blob when large). */
  output: Type.Optional(text),
  /**
   * Who stopped it, for `stopped` (format 2.9). `user`: the person stopped it from the jobs list. The model is shown the entry with its
   * next request like any other, but the entry alone does not ask for a request.
   */
  by: Type.Optional(Type.Literal("user")),
});

/**
 * The answer to "may this call run?" (format 2.2), for a call that no stored grant covered. It is what lets the question be asked in one
 * place and answered in another: a thread whose last call has no result and no `approval` is waiting for one, and whoever appends it
 * (the terminal that was asked, another session, a headless host) is seen by every reader of the thread. A call a live grant already
 * covers needs no entry: that is decided by the grants and the clock, not by anything recorded.
 *
 * `grant` is a grant held by the thread: it covers matching calls later in this thread and in every branch forked from it afterwards,
 * and nowhere else. A grant for the whole project is a change to `harness.yml` instead, and the entry then says nothing of it, so
 * each grant is kept in one place only.
 */
export const approval = strictObject({
  $tag: Type.Literal("approval"),
  id: ulid,
  call_id: Type.String(),
  allow: Type.Boolean(),
  /** Why the call was declined (shown to the model). */
  reason: Type.Optional(Type.String()),
  grant: Type.Optional(strictObject({ tool: nonEmpty, keys: Type.Array(nonEmpty, { minItems: 1 }), until: Type.String() })),
});

export const interrupted = strictObject({
  $tag: Type.Literal("interrupted"),
  id: ulid,
  by: Type.Enum(["user", "error"]),
  /** Blocks received before the interruption. They may be incomplete (e.g. a tool call with partial arguments). */
  partial: Type.Array(assistantBlock),
  error: Type.Optional(Type.String()),
  /** Tokens of the partial response, which were billed anyway (normalised names, as in `assistant.usage`). */
  usage: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

export type ChatEntry =
  | Static<typeof header>
  | Static<typeof user>
  | Static<typeof assistant>
  | Static<typeof toolResult>
  | Static<typeof compaction>
  | Static<typeof trim>
  | Static<typeof agentSetup>
  | Static<typeof branchStart>
  | Static<typeof subagentResult>
  | Static<typeof forkMerge>
  | Static<typeof jobEvent>
  | Static<typeof approval>
  | Static<typeof injection>
  | Static<typeof fileTouch>
  | Static<typeof interrupted>;

export const entryTypes = [
  defineEntry("header", header),
  defineEntry("user", user),
  defineEntry("assistant", assistant),
  defineEntry("tool_result", toolResult),
  defineEntry("compaction", compaction),
  defineEntry("trim", trim),
  defineEntry("agent_setup", agentSetup),
  defineEntry("branch_start", branchStart),
  defineEntry("subagent_result", subagentResult),
  defineEntry("fork_merge", forkMerge),
  defineEntry("job_event", jobEvent),
  defineEntry("approval", approval),
  defineEntry("injection", injection),
  defineEntry("file_touch", fileTouch),
  defineEntry("interrupted", interrupted),
];

export interface PipelineConfig {
  /** Where large values go. Without a store nothing is externalized. */
  store?: BlobStore;
  /** Strings larger than this many UTF-8 bytes are stored as blobs. Default 4096. */
  threshold?: number;
  /** Patterns to scrub from every string before it is stored (secrets). Applied before externalizing. */
  redact?: RegExp[];
}

/** The app's write/read pipeline: strict validation, optional redaction, optional blob externalization, verification. */
export function createPipeline(config: PipelineConfig = {}): Pipeline<ChatEntry> {
  const transforms: Transform[] = [];
  if (config.redact !== undefined && config.redact.length > 0) transforms.push(redact(config.redact));
  if (config.store !== undefined) {
    transforms.push(externalizeLarge(config.store, config.threshold === undefined ? {} : { threshold: config.threshold }));
  }
  return new Pipeline<ChatEntry>({ types: entryTypes, transforms });
}

/** The id of an entry, for the kinds that have one. */
export const idOf = (e: ChatEntry): string | undefined => ("id" in e && typeof e.id === "string" ? e.id : undefined);

// ---- versions: the format as the state of a read ------------------------------------------------------------

export interface FormatVersion {
  major: number;
  minor: number;
}

/** The entry types of each format major this build reads. Each is checked as authored, for reading and writing alike. */
const entryTypesByMajor: ReadonlyMap<number, readonly EntryType[]> = new Map([[FORMAT.major, entryTypes]]);

/** The newest minor this build reads, for each major it reads. */
const newestMinor: ReadonlyMap<number, number> = new Map([[FORMAT.major, FORMAT.minor]]);

/** Why a header may not take effect after the version `current` (none yet for the first), or undefined when it may. */
export function versionProblem(h: FormatVersion, current: FormatVersion | undefined): string | undefined {
  const at = `${h.major}.${h.minor}`;
  const newest = newestMinor.get(h.major);
  if (newest === undefined) {
    const majors = [...newestMinor.keys()];
    return h.major > Math.max(...majors)
      ? `this thread is format ${at}, which this version of chattree cannot read (it reads format ${majors.join(", ")}); update chattree`
      : `this thread is format ${at}, which this version of chattree no longer reads (it reads format ${majors.join(", ")})`;
  }
  if (h.minor > newest)
    return `this thread is format ${at}, newer than the ${h.major}.${newest} this version of chattree reads; update chattree`;
  if (current !== undefined && current.major === h.major && h.minor < current.minor)
    return `a header says format ${at} after one that said ${current.major}.${current.minor}: the version never goes back within a major`;
  return undefined;
}

/**
 * Reads entries in file order, holding the format version as its state. Before any header the version is unknown and
 * every other entry is refused ("expected a header first"); a header is checked (see `versionProblem`) and sets the
 * version; each later entry is read by the entry types of the current major. A header may appear again (a newer build
 * writes one when it first adds to an older file). A refused entry comes back with reason `version` and no state
 * change, like any entry that does not decode.
 */
export class EntryReader {
  static readonly #headers = new Pipeline<ChatEntry>({ types: [defineEntry("header", header)] });
  static readonly #majors = new Map<number, Pipeline<ChatEntry>>();
  #version: FormatVersion | undefined;

  constructor(start?: FormatVersion) {
    this.#version = start;
  }

  /** The version the entries read so far have set; undefined before the header. */
  get version(): FormatVersion | undefined {
    return this.#version;
  }

  async decode(entry: Entry): Promise<DecodeResult<ChatEntry>> {
    const refuse = (message: string): DecodeResult<ChatEntry> => ({
      ok: false,
      reason: "version",
      tag: entry instanceof Map ? undefined : entry.tag,
      issues: [{ path: "", message }],
      raw: entry,
    });
    if (entry instanceof Tagged && entry.tag === "header") {
      const r = await EntryReader.#headers.decode(entry);
      if (!r.ok || r.value.$tag !== "header") return r;
      const problem = versionProblem(r.value, this.#version);
      if (problem !== undefined) return refuse(problem);
      this.#version = { major: r.value.major, minor: r.value.minor };
      return r;
    }
    if (this.#version === undefined) return refuse("expected a header entry first, to say which format this thread is in");
    let pipeline = EntryReader.#majors.get(this.#version.major);
    if (pipeline === undefined) {
      const types = entryTypesByMajor.get(this.#version.major);
      if (types === undefined) return refuse(versionProblem(this.#version, undefined) ?? "unsupported format");
      pipeline = new Pipeline<ChatEntry>({ types });
      EntryReader.#majors.set(this.#version.major, pipeline);
    }
    return pipeline.decode(entry);
  }
}
