/**
 * The messages between the controller and the views. The controller sends events (what the world looks like now and
 * how it changed); a view sends intents (what the person asked for). Both are validated where they arrive: a view
 * runs in a separate context and the controller does not trust what it sends. An intent names what the person did,
 * not how to do it: rewinding, forking and merging are carried out by the controller through the conversation.
 */
import { Type, type Static } from "typebox";
import { safeParse, strictObject, type ParseResult } from "../../src/validate.ts";
import { THREAD_STATUSES, graphData, hash, repoList } from "./graph.ts";
import { approval, chatState, chatThread, composer, modelChoice, statusBar } from "./chat.ts";
import { formSpec } from "./form.ts";
import { block } from "./transcript.ts";

export const VIEWS = ["graph", "chat", "config"] as const;
export type ViewName = (typeof VIEWS)[number];

const name = Type.String({ minLength: 1 });
const ev = <T extends string, P extends Parameters<typeof strictObject>[0]>(type: T, properties: P) =>
  strictObject({ type: Type.Literal(type), ...properties });

// ---- controller to view ------------------------------------------------------------------------------------

export const event = Type.Union([
  /** The whole graph; sent when a view opens and when threads or commits change shape. */
  /** The repositories of the workspace and which one the graph shows. */
  ev("graph.repos", { repos: repoList }),
  ev("graph.data", { data: graphData }),
  /** A thread started or stopped working. */
  ev("graph.status", { thread: name, status: Type.Enum(THREAD_STATUSES) }),
  /** The thread the graph highlights as open in the chat. */
  ev("graph.selected", { thread: Type.Optional(name), commit: Type.Optional(hash) }),
  /** A thread was opened in the chat: everything about it, replacing what was shown. */
  ev("chat.open", { state: chatState }),
  /** Blocks were added at the end. */
  ev("chat.append", { blocks: Type.Array(block) }),
  /** A block changed (its stream ended, a tool finished): it replaces the block with the same id. */
  ev("chat.update", { block }),
  /** Text arrived for a streaming assistant or reasoning block: it is added to the end of its text. */
  ev("chat.delta", { id: name, delta: Type.String() }),
  /** The thread's header changed (a new commit moved its tip, it was renamed). */
  ev("chat.thread", { thread: chatThread }),
  ev("chat.status", { status: statusBar }),
  /** The model choice changed: which is selected, or which are on offer. */
  ev("chat.models", { models: modelChoice }),
  /** Bring a block into view and draw the eye to it: the person picked its commit in the graph. */
  ev("chat.reveal", { commit: hash }),
  ev("chat.composer", { composer }),
  /** A tool call is waiting for an answer; absent when none is. */
  ev("chat.approval", { approval: Type.Optional(approval) }),
  /** A form's new state: after an edit (with its issues), a save, or when it first opens. */
  ev("form.set", { form: formSpec }),
  /** A message for the person that is not part of any thread (a toast). */
  ev("notice", { level: Type.Enum(["info", "warning", "error"]), message: Type.String() }),
]);
export type UiEvent = Static<typeof event>;

// ---- view to controller ------------------------------------------------------------------------------------

export const intent = Type.Union([
  /** A view has loaded and wants its snapshot. */
  ev("ready", { view: Type.Enum(VIEWS) }),
  /** Show another repository's conversations; the answer is a fresh `graph.data` (and the chat follows). */
  ev("repo.select", { id: name }),
  ev("commit.copy", { commit: hash }),
  /** Remove a thread's branch; its commits stay until git collects garbage, so it can be recovered from the reflog. */
  ev("thread.delete", { thread: name }),
  ev("thread.open", { thread: name, commit: Type.Optional(hash) }),
  /** Start a new thread from `commit` on `thread`; the controller picks a name when none is given. */
  ev("thread.fork", { thread: name, commit: hash, name: Type.Optional(name) }),
  /** Take `thread` back to `commit`; the old tip is kept under a ref (the conversation's own rewind). */
  ev("thread.rewind", { thread: name, commit: hash }),
  ev("thread.merge", { from: name, into: name }),
  ev("chat.send", { text: Type.String(), queued: Type.Optional(Type.Boolean()) }),
  ev("chat.stop", {}),
  ev("chat.draft", { text: Type.String() }),
  /** Ask the host to let the person pick files; the staged files come back in `chat.composer`. */
  ev("chat.attach", {}),
  ev("chat.detach", { id: name }),
  ev("chat.approve", { callId: name, allow: Type.Boolean() }),
  ev("chat.model", { model: name }),
  /** An edited value for a form; the answer is a `form.set` with the issues found. */
  ev("form.edit", { id: name, value: Type.Record(Type.String(), Type.Unknown()) }),
  ev("form.save", { id: name }),
  ev("form.revert", { id: name }),
]);
export type UiIntent = Static<typeof intent>;

export const parseEvent = (raw: unknown): ParseResult<UiEvent> => safeParse(event, raw);
export const parseIntent = (raw: unknown): ParseResult<UiIntent> => safeParse(intent, raw);
