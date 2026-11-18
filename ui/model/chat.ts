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

/** The open thread's header. `tip` is its newest commit: what a rewind may not go back to. */
export const chatThread = strictObject({
  name: Type.String({ minLength: 1 }),
  kind: Type.Enum(THREAD_KINDS),
  title: Type.Optional(Type.String()),
  tip: hash,
});
export type ChatThread = Static<typeof chatThread>;

/**
 * Why the thread cannot take a message yet, and what the person does about it. `no_provider`: nothing says where models
 * come from (a conversation that was just started): add a provider in the settings. `untrusted`: the thread's
 * `harness.yml` is not the one the person approved (`unknown`: never approved, as after a clone; `changed`: it was
 * edited since), and the harness will not use it (its keys, tools and commands) until they say so.
 */
export const chatBanner = Type.Union([
  strictObject({ kind: Type.Literal("no_provider") }),
  strictObject({ kind: Type.Literal("untrusted"), state: Type.Enum(["unknown", "changed"]) }),
]);
export type ChatBanner = Static<typeof chatBanner>;

export const chatState = strictObject({
  thread: chatThread,
  blocks: Type.Array(block),
  status: statusBar,
  composer,
  approval: Type.Optional(approval),
  banner: Type.Optional(chatBanner),
  /** The model picker and the form for its settings, which the view shows in the expandable section. */
  model: modelChoice,
  settings: Type.Optional(formSpec),
});
export type ChatState = Static<typeof chatState>;
