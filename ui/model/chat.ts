/**
 * Everything the chat view shows about one open thread besides its blocks: the header, the status bar, the composer,
 * a pending approval, the model choice. `chatState` is the snapshot a view gets when it opens a thread; events then
 * change it piece by piece (see `protocol.ts`).
 */
import { Type, type Static } from "typebox";
import { strictObject } from "../../src/validate.ts";
import { THREAD_KINDS, THREAD_STATUSES, hash } from "./graph.ts";
import { attachmentView } from "./transcript.ts";
import { block } from "./transcript.ts";
import { formSpec } from "./form.ts";

const count = Type.Integer({ minimum: 0 });

/** What the status bar shows. An unknown figure is absent, never zero. */
export const statusBar = strictObject({
  state: Type.Enum(THREAD_STATUSES),
  /** The model as a label (`Claude Sonnet 5.5`). */
  model: Type.String(),
  provider: Type.String(),
  /** How full the context is, when known. */
  context: Type.Optional(strictObject({ used: count, limit: Type.Optional(count) })),
  thinking: Type.Optional(Type.String()),
  /** What the thread has cost; absent when nothing priced yet. */
  usd: Type.Optional(Type.Number({ minimum: 0 })),
  /** Some request used a model whose price is unknown, so `usd` is a lower bound. */
  unpriced: Type.Optional(Type.Boolean()),
});
export type StatusBar = Static<typeof statusBar>;

export const composer = strictObject({
  /** What the person typed and has not sent; the controller keeps it so it survives the view being reloaded. */
  draft: Type.String(),
  /** Files staged to go with the next message. */
  attachments: Type.Array(strictObject({ id: Type.String({ minLength: 1 }), file: attachmentView })),
});
export type Composer = Static<typeof composer>;

/** A tool call that waits for a yes or a no. */
export const approval = strictObject({
  callId: Type.String({ minLength: 1 }),
  name: Type.String(),
  summary: Type.String(),
  args: Type.String(),
});
export type Approval = Static<typeof approval>;

export const modelChoice = strictObject({
  current: Type.String(),
  options: Type.Array(strictObject({ id: Type.String({ minLength: 1 }), label: Type.String(), provider: Type.String() })),
});
export type ModelChoice = Static<typeof modelChoice>;

export const chatState = strictObject({
  thread: strictObject({
    name: Type.String({ minLength: 1 }),
    kind: Type.Enum(THREAD_KINDS),
    title: Type.Optional(Type.String()),
    tip: hash,
  }),
  blocks: Type.Array(block),
  status: statusBar,
  composer,
  approval: Type.Optional(approval),
  /** The model picker and the form for its settings, which the view shows in the expandable section. */
  model: modelChoice,
  settings: Type.Optional(formSpec),
});
export type ChatState = Static<typeof chatState>;
