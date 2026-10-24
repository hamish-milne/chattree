import { z } from "zod";
import { Pipeline, defineEntry, externalizeLarge, redact, type BlobStore, type Transform } from "../src/index.ts";
import { ULID_RE } from "./ulid.ts";

/** Format version recorded in the header entry. Minor bumps only add optional fields; readers of an older minor ignore them. */
export const FORMAT = { format: "chatlog", major: 1, minor: 1 } as const;

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

const textBlock = z.object({ $tag: z.literal("text"), text });
const reasoningBlock = z.object({
  $tag: z.literal("reasoning"),
  provider: z.string(),
  /** Opaque, provider-specific, replayed verbatim (Anthropic thinking signature, OpenAI encrypted reasoning, ...). */
  payload: text,
  /** Readable form of the reasoning when the provider exposes one. */
  visible: z.string().optional(),
});
const toolCallBlock = z.object({
  $tag: z.literal("tool_call"),
  call_id: z.string(),
  name: z.string(),
  args: json,
  /** The provider's original argument string, kept when it was not valid JSON. */
  args_raw: z.string().optional(),
});
const attachmentPart = z.object({ $tag: z.literal("attachment"), name: z.string().optional(), data: blobRef });

const assistantBlock = z.discriminatedUnion("$tag", [textBlock, reasoningBlock, toolCallBlock]);
const userPart = z.discriminatedUnion("$tag", [textBlock, attachmentPart]);

// ---- entries -----------------------------------------------------------------------------------------------

export const header = z.object({
  $tag: z.literal("header"),
  format: z.literal(FORMAT.format),
  major: count,
  minor: count,
});

export const user = z.object({ $tag: z.literal("user"), id: ulid, content: z.array(userPart) });

export const assistant = z.object({
  $tag: z.literal("assistant"),
  id: ulid,
  provider: z.string(),
  model: z.string(),
  blocks: z.array(assistantBlock),
  stop_reason: z.string(),
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
});

export const compaction = z.object({
  $tag: z.literal("compaction"),
  id: ulid,
  replaces: z.object({ from: ulid, to: ulid }),
  summary: text,
  model: z.string().optional(),
});

export const configChanged = z.object({ $tag: z.literal("config_changed"), id: ulid, old: sha256, new: sha256 });

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

export const subagentResult = z.object({
  $tag: z.literal("subagent_result"),
  id: ulid,
  call_id: z.string(),
  branch: z.string(),
  tip: z.string(),
  summary: text,
  /**
   * What reached the parent: `changed` and `added` are files whose child version was merged; `discarded` are
   * files the child changed whose version was dropped because the parent's version won a conflict.
   */
  files: z.object({ changed: z.array(z.string()), added: z.array(z.string()), discarded: z.array(z.string()) }),
  /** How the merge went (format 1.1). With policy "trunk" every conflict was resolved to the parent's version. */
  merge: z
    .object({
      policy: z.literal("trunk"),
      /** The commit the child branch diverged from. */
      base: z.string(),
      conflicts: z.array(z.object({ path: z.string(), kind: z.string() })),
    })
    .optional(),
});

export const interrupted = z.object({
  $tag: z.literal("interrupted"),
  id: ulid,
  by: z.enum(["user", "error"]),
  /** Blocks received before the interruption. They may be incomplete (e.g. a tool call with partial arguments). */
  partial: z.array(assistantBlock),
  error: z.string().optional(),
});

export type ChatEntry =
  | z.infer<typeof header>
  | z.infer<typeof user>
  | z.infer<typeof assistant>
  | z.infer<typeof toolResult>
  | z.infer<typeof compaction>
  | z.infer<typeof configChanged>
  | z.infer<typeof branchStart>
  | z.infer<typeof subagentResult>
  | z.infer<typeof interrupted>;

export const entryTypes = [
  defineEntry("header", header),
  defineEntry("user", user),
  defineEntry("assistant", assistant),
  defineEntry("tool_result", toolResult),
  defineEntry("compaction", compaction),
  defineEntry("config_changed", configChanged),
  defineEntry("branch_start", branchStart),
  defineEntry("subagent_result", subagentResult),
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
