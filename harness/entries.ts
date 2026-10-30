import { z } from "zod";
import { Pipeline, defineEntry, externalizeLarge, redact, type BlobStore, type Transform } from "../src/index.ts";
import { ULID_RE } from "./ulid.ts";

/** Format version recorded in the header entry. Minor bumps only add optional fields; readers of an older minor ignore them. */
export const FORMAT = { format: "chatlog", major: 2, minor: 3 } as const;

// ---- building blocks -------------------------------------------------------------------------------------

const ulid = z.string().regex(ULID_RE, "not a ULID");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "not a lowercase hex SHA-256");
const count = z.number().int().nonnegative();
/** Free-form JSON-like data: tool arguments, provider round-trip data. */
const json = z.record(z.string(), z.unknown());

/** The plain-object form of a blob reference (`!blob {...}` in the file). */
export const blobRef = z.object({ $tag: z.literal("blob"), sha256, bytes: count, mime: z.string().optional() });
/** Text that is either inline or, once large, a blob reference. */
const text = z.union([z.string(), blobRef]);

// ---- content blocks (tagged values inside entries) ---------------------------------------------------------

/** Provider round-trip data for one block (an item id that replay needs, a cache marker). Opaque to the harness. */
const blockExt = json.optional();
const textBlock = z.object({ $tag: z.literal("text"), text, ext: blockExt });
const reasoningBlock = z.object({
  $tag: z.literal("reasoning"),
  provider: z.string(),
  /**
   * What the provider needs back that `visible` does not hold, as the provider's own object (an Anthropic thinking block without its
   * text, redacted thinking, an OpenAI reasoning item). Opaque to the harness; absent when `visible` is all there is to replay.
   */
  payload: json.optional(),
  /** Readable form of the reasoning when the provider exposes one. */
  visible: text.optional(),
  ext: blockExt,
});
const toolCallBlock = z.object({
  $tag: z.literal("tool_call"),
  call_id: z.string(),
  name: z.string(),
  /** Arguments as the model gave them; a string longer than the externalizing threshold is a blob reference inside (`inlineBlobs` puts it back). */
  args: json,
  /** The provider's original argument string, kept when it was not valid JSON. */
  args_raw: text.optional(),
  ext: blockExt,
});
/** A provider's own compaction of the conversation so far: opaque, replayed only to the model that made it (docs/providers.md, P4). Not our readable `compaction` entry. */
const providerCompactionBlock = z.object({ $tag: z.literal("provider_compaction"), provider: z.string(), payload: text, ext: blockExt });
/** `charset`: how to read the bytes of a text file that is not UTF-8 (a label such as `windows-1252`); the blob's `mime` stays a bare `type/subtype`. */
const attachmentPart = z.object({ $tag: z.literal("attachment"), name: z.string().optional(), charset: z.string().optional(), data: blobRef });

const assistantBlock = z.discriminatedUnion("$tag", [textBlock, reasoningBlock, toolCallBlock, providerCompactionBlock]);
const userPart = z.discriminatedUnion("$tag", [textBlock, attachmentPart]);

// ---- entries -----------------------------------------------------------------------------------------------

export const header = z.object({
  $tag: z.literal("header"),
  format: z.literal(FORMAT.format),
  major: count,
  minor: count,
});

export const user = z.object({
  $tag: z.literal("user"),
  id: ulid,
  content: z.array(userPart),
  /**
   * Sent while the thread was working (format 2.3). It sits wherever it was appended, which may be between a tool call and its result;
   * the model is shown it after the results that close the turn, in the next request.
   */
  queued: z.boolean().optional(),
});

export const assistant = z.object({
  $tag: z.literal("assistant"),
  id: ulid,
  provider: z.string(),
  model: z.string(),
  blocks: z.array(assistantBlock),
  stop_reason: z.string(),
  /** The id of the last entry the request that produced this one was built from (format 2.3): a user message with a later id was not seen by it. */
  context_tip: ulid.optional(),
  /** Whatever token counts the provider reports; field names differ between providers. */
  usage: z.record(z.string(), z.number()).optional(),
  /** Provider round-trip data that has no place in the blocks (response ids, item ids, cache hints). */
  ext: json.optional(),
});

export const toolResult = z.object({
  $tag: z.literal("tool_result"),
  id: ulid,
  call_id: z.string(),
  is_error: z.boolean(),
  content: text,
  truncated: z.boolean().optional(),
  /** When `content` was cut short, the whole output (format 1.3). A reference, so the blob is kept for as long as the entry is. */
  full: blobRef.optional(),
});

export const compaction = z.object({
  $tag: z.literal("compaction"),
  id: ulid,
  replaces: z.object({ from: ulid, to: ulid }),
  summary: text,
  model: z.string().optional(),
});

// ---- agent_setup: the agent's state, folded per branch (see docs/providers.md, P8) -----------------------------

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
const changeKind = z.enum(CHANGE_KINDS);

/** A pinned definition (tool, instructions, skill, MCP server): the hash of its canonical form and where the bytes live. */
export const pinnedDefinition = z.object({
  hash: sha256,
  /** `blob`: the canonical bytes are in `blobs/`. `external`: only the hash is here and the host's source serves the bytes. */
  store: z.enum(["blob", "external"]),
  /** For `external`: the host's locator (a path in a shared submodule, say). */
  ref: z.string().optional(),
});
const definitionDelta = z.object({
  set: z.record(z.string(), pinnedDefinition).optional(),
  remove: z.array(z.string()).optional(),
});

export const agentSetup = z.object({
  $tag: z.literal("agent_setup"),
  id: ulid,
  /** `provider` and `resolved` are written when a response reports a different model than the setup says. */
  reason: z.enum(["user", "fork", "subagent", "provider", "resolved"]),
  /** Always complete when present: the whole model block replaces the previous one. */
  model: z
    .object({
      provider: z.string().min(1),
      /** What was asked for; may be an alias. */
      id: z.string().min(1),
      /** The dated model the provider reported serving; requests use it once known. */
      resolved: z.string().min(1).optional(),
      settings: json.optional(),
    })
    .optional(),
  tools: definitionDelta.optional(),
  instructions: pinnedDefinition.optional(),
  skills: definitionDelta.optional(),
  mcp: definitionDelta.optional(),
  /** The renderer that turns structured entries into text for the model (`chattree-english-v1`); immutable per id. Unset means the default. */
  renderer: z.string().min(1).optional(),
  /** The hash of the price table this agent is costed under. */
  pricing: z.object({ table: sha256 }).optional(),
  /** Change kinds the caller allowed for this mutation. */
  allow: z.array(changeKind).optional(),
  /** For `provider` and `resolved` entries: the kinds the observed change would have been classified as. */
  changes: z.array(changeKind).optional(),
  /** Provider-observed `agent_setup` entries this one accepts. */
  acknowledges: z.array(ulid).optional(),
});

export const branchStart = z.object({
  $tag: z.literal("branch_start"),
  id: ulid,
  kind: z.enum(["fork", "subagent"]),
  from: z.object({ branch: z.string(), commit: z.string() }),
  context: z.enum(["inherit", "fresh"]),
  /** For a subagent: the task it was given. */
  brief: text.optional(),
  /** For a subagent: the tool call in the parent that started it. */
  call_id: z.string().optional(),
});

/**
 * What reached the parent in a merge: `changed` and `added` are files whose child version was merged;
 * `discarded` are files the child changed whose version was dropped because the parent's version won a conflict.
 */
const mergedFiles = z.object({ changed: z.array(z.string()), added: z.array(z.string()), discarded: z.array(z.string()) });

/** How a merge went. With policy "trunk" every conflict was resolved to the parent's version. */
const mergeReport = z.object({
  policy: z.literal("trunk"),
  /** The commit the child branch diverged from (or was last merged at). */
  base: z.string(),
  conflicts: z.array(z.object({ path: z.string(), kind: z.string() })),
});

/** What a merged branch cost, so budgets survive the merge: priced under the child's own pinned tables when it was merged. */
const spendRollup = z.object({
  usd: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  /** Requests whose price was unknown (`usd` leaves them out). */
  unpriced: z.number().int().nonnegative(),
});

export const subagentResult = z.object({
  $tag: z.literal("subagent_result"),
  id: ulid,
  call_id: z.string(),
  branch: z.string(),
  tip: z.string(),
  summary: text,
  files: mergedFiles,
  /** Format 1.1. */
  merge: mergeReport.optional(),
  /** What the subagent spent. */
  spend: spendRollup.optional(),
});

/**
 * A fork merged back into the branch it came from (format 1.2). `summary` is what was discussed and decided
 * in the fork; `merge.base` is where the fork diverged, or where it was last merged.
 */
export const forkMerge = z.object({
  $tag: z.literal("fork_merge"),
  id: ulid,
  /** Format 2.1: the `merge` tool call this merge answers, when the model asked for it (otherwise the entry is a user-side notice). */
  call_id: z.string().optional(),
  branch: z.string(),
  tip: z.string(),
  summary: text,
  files: mergedFiles,
  merge: mergeReport,
  /** What the fork spent since it diverged, or since it was last merged. */
  spend: spendRollup.optional(),
});

/**
 * A background job ended (format 1.4). Committed on the branch when the job finishes (or is found lost after a crash)
 * and shown to the model as a user message. `call_id` is the call that started the job, whose result said `started job <id>`.
 */
export const jobEvent = z.object({
  $tag: z.literal("job_event"),
  id: ulid,
  /** The job's id on this branch (`j1`). */
  job: z.string().min(1),
  call_id: z.string(),
  /** `completed`: it ended and succeeded; `failed`: it ended with an error or timed out; `stopped`: stopped on request; `lost`: the process that ran it ended first. */
  status: z.enum(["completed", "failed", "stopped", "lost"]),
  /** One line: what it was and how it ended. */
  summary: text,
  /** Everything it printed (a blob when large). */
  output: text.optional(),
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
export const approval = z.object({
  $tag: z.literal("approval"),
  id: ulid,
  call_id: z.string(),
  allow: z.boolean(),
  /** Why the call was declined (shown to the model). */
  reason: z.string().optional(),
  grant: z.object({ tool: z.string().min(1), keys: z.array(z.string().min(1)).min(1), until: z.string() }).optional(),
});

export const interrupted = z.object({
  $tag: z.literal("interrupted"),
  id: ulid,
  by: z.enum(["user", "error"]),
  /** Blocks received before the interruption. They may be incomplete (e.g. a tool call with partial arguments). */
  partial: z.array(assistantBlock),
  error: z.string().optional(),
  /** Tokens of the partial response, which were billed anyway (normalised names, as in `assistant.usage`). */
  usage: z.record(z.string(), z.number()).optional(),
});

export type ChatEntry =
  | z.infer<typeof header>
  | z.infer<typeof user>
  | z.infer<typeof assistant>
  | z.infer<typeof toolResult>
  | z.infer<typeof compaction>
  | z.infer<typeof agentSetup>
  | z.infer<typeof branchStart>
  | z.infer<typeof subagentResult>
  | z.infer<typeof forkMerge>
  | z.infer<typeof jobEvent>
  | z.infer<typeof approval>
  | z.infer<typeof interrupted>;

export const entryTypes = [
  defineEntry("header", header),
  defineEntry("user", user),
  defineEntry("assistant", assistant),
  defineEntry("tool_result", toolResult),
  defineEntry("compaction", compaction),
  defineEntry("agent_setup", agentSetup),
  defineEntry("branch_start", branchStart),
  defineEntry("subagent_result", subagentResult),
  defineEntry("fork_merge", forkMerge),
  defineEntry("job_event", jobEvent),
  defineEntry("approval", approval),
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
