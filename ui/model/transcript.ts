/**
 * What the chat view shows of a thread's transcript: a list of blocks, each a piece the view draws as one unit. The
 * controller makes these from entries (several entries can become one block: a tool call and its result are one
 * `tool` block) and updates them as a request streams. A block that comes from a commit carries its hash, which is
 * the anchor the rewind and fork actions use.
 */
import { Type, type Static } from "typebox";
import { strictObject } from "../../src/validate.ts";
import { hash } from "./graph.ts";

const count = Type.Integer({ minimum: 0 });
const id = Type.String({ minLength: 1 });
/** Present once the block is committed; a block still streaming has none yet. */
const commit = Type.Optional(hash);

export const ATTACHMENT_KINDS = ["image", "audio", "pdf", "text", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** A file attached to a message, as a chip: the content is not sent to the view. */
export const attachmentView = strictObject({
  name: Type.String(),
  mime: Type.String(),
  kind: Type.Enum(ATTACHMENT_KINDS),
  bytes: count,
});
export type AttachmentView = Static<typeof attachmentView>;

export const userBlock = strictObject({
  type: Type.Literal("user"),
  id,
  commit,
  text: Type.String(),
  attachments: Type.Array(attachmentView),
  /** Sent while the thread was working; the model sees it in the next request. */
  queued: Type.Optional(Type.Boolean()),
  /** The thread that sent it, for a message from another thread. */
  from: Type.Optional(Type.String()),
});

export const assistantBlock = strictObject({
  type: Type.Literal("assistant"),
  id,
  commit,
  markdown: Type.String(),
  model: Type.String(),
  /** More text is coming. */
  streaming: Type.Optional(Type.Boolean()),
});

export const reasoningBlock = strictObject({
  type: Type.Literal("reasoning"),
  id,
  commit,
  text: Type.String(),
  streaming: Type.Optional(Type.Boolean()),
});

export const TOOL_STATUSES = ["pending", "awaiting_approval", "running", "ok", "error", "did_not_run"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** One tool call and, once there is one, its result. */
export const toolBlock = strictObject({
  type: Type.Literal("tool"),
  /** The call id. */
  id,
  commit,
  name: Type.String(),
  /** One line saying what the call does (`edit src/http.ts`). */
  summary: Type.String(),
  /** The arguments as formatted JSON; may be shortened. */
  args: Type.String(),
  status: Type.Enum(TOOL_STATUSES),
  result: Type.Optional(
    strictObject({
      text: Type.String(),
      /** `text` is a part of a longer output. */
      truncated: Type.Boolean(),
      ms: count,
    }),
  ),
  /** The thread a subagent call runs on, so the view can link to it. */
  thread: Type.Optional(Type.String()),
});

export const NOTICE_KINDS = [
  "setup",
  "compaction",
  "trim",
  "injection",
  "job",
  "interrupted",
  "branch",
  "subagent_result",
  "merge",
  "error",
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Something that happened to the thread that is not a message: a setup change, a compaction, an interruption. */
export const noticeBlock = strictObject({
  type: Type.Literal("notice"),
  id,
  commit,
  kind: Type.Enum(NOTICE_KINDS),
  level: Type.Enum(["info", "warning", "error"]),
  title: Type.String(),
  detail: Type.Optional(Type.String()),
});

/** The end of a request: what it used and cost. */
export const turnEndBlock = strictObject({
  type: Type.Literal("turn_end"),
  id,
  commit,
  usage: Type.Optional(strictObject({ input: count, output: count, cached: count })),
  usd: Type.Optional(Type.Number({ minimum: 0 })),
  /** The price of the model is not known, so `usd` is missing rather than zero. */
  unpriced: Type.Optional(Type.Boolean()),
  stop: Type.String(),
});

export const block = Type.Union([userBlock, assistantBlock, reasoningBlock, toolBlock, noticeBlock, turnEndBlock]);
export type Block = Static<typeof block>;
