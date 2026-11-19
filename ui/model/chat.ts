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
  /**
   * The thread stopped partway, and a `chat.resume` carries on with no word from the person: this says why, in words (a message nobody
   * answered, a tool result the model has not seen, a failed request). Absent when the thread is finished, working, or held elsewhere.
   */
  stalled: Type.Optional(Type.String()),
});
export type StatusBar = Static<typeof statusBar>;

export const composer = strictObject({
  /** What the person typed and has not sent; the controller keeps it so it survives the view being reloaded. */
  draft: Type.String(),
  /** Files staged to go with the next message. */
  attachments: Type.Array(strictObject({ id: Type.String({ minLength: 1 }), file: attachmentView })),
});
export type Composer = Static<typeof composer>;

export const ACTIVITY_PHASES = ["preparing", "waiting", "streaming", "retrying", "tool", "blocked"] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];

/**
 * What a working thread is doing right now, for the line at the end of the transcript. `preparing`: getting the request ready;
 * `waiting`: the request is sent and nothing has come back; `streaming`: the model is answering (`detail` says `thinking` while it
 * reasons); `retrying`: the last attempt failed and the next one starts at `until` (`detail` says why); `tool`: a call is running
 * (`detail` is its summary); `blocked`: the thread has handed work to other threads and waits for them (`detail` names them, separated by
 * commas; no request is going on here). `since` is when the phase began, in milliseconds since the epoch, so the view can show how long it has
 * lasted without being told every second.
 */
export const activity = strictObject({
  phase: Type.Enum(ACTIVITY_PHASES),
  since: Type.Integer({ minimum: 0 }),
  detail: Type.Optional(Type.String()),
  /** For `retrying`: when the next attempt starts. */
  until: Type.Optional(Type.Integer({ minimum: 0 })),
  /** For `waiting` after a failure and for `retrying`: which attempt this is (the first is 1). */
  attempt: Type.Optional(Type.Integer({ minimum: 1 })),
  /** For `streaming`: how many characters have arrived. */
  chars: Type.Optional(count),
});
export type Activity = Static<typeof activity>;

/** A tool call that waits for a yes or a no. */
export const approval = strictObject({
  callId: Type.String({ minLength: 1 }),
  name: Type.String(),
  summary: Type.String(),
  args: Type.String(),
});
export type Approval = Static<typeof approval>;

/**
 * A question some other thread is waiting on, shown in the threads that wait for it (a subagent's parent, and its parent): the person
 * is told something below needs them, and goes to that thread to answer.
 */
export const forwardedQuestion = strictObject({
  thread: Type.String({ minLength: 1 }),
  callId: Type.String({ minLength: 1 }),
  tool: Type.String(),
  summary: Type.String(),
});
export type ForwardedQuestion = Static<typeof forwardedQuestion>;

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
  /**
   * The agent was changed by something other than the person (the provider reported another model, say, or the repository was edited
   * outside): `changes` says what, in words, and `before` is the commit the thread was at just before the change, to go back to.
   */
  strictObject({ kind: Type.Literal("unusual_change"), changes: Type.Array(Type.String()), before: Type.String() }),
]);
export type ChatBanner = Static<typeof chatBanner>;

export const chatState = strictObject({
  thread: chatThread,
  blocks: Type.Array(block),
  status: statusBar,
  composer,
  approval: Type.Optional(approval),
  forwarded: Type.Optional(Type.Array(forwardedQuestion)),
  activity: Type.Optional(activity),
  banner: Type.Optional(chatBanner),
  /** The model picker and the form for its settings, which the view shows in the expandable section. */
  model: modelChoice,
  settings: Type.Optional(formSpec),
});
export type ChatState = Static<typeof chatState>;
