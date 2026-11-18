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
import { instructionState, providerModels, providerStatus } from "./settings.ts";
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
  /**
   * Switching the workspace to a thread would leave files the person changed by hand in the project folder: ask what to
   * do with them. The answer is another `workspace.switch` carrying `uncommitted`.
   */
  ev("workspace.uncommitted", { thread: name, from: name, files: Type.Array(Type.String()) }),
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
  /** What trying a provider showed (sent first as `checking`, then the result). */
  ev("provider.status", { provider: name, status: providerStatus }),
  /** The models a provider offers, or why that could not be found out. */
  ev("provider.models", { provider: name, list: providerModels }),
  /** The thread's instruction files and the well-known ones found in the workspace. */
  ev("instructions.set", { state: instructionState }),
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
  /**
   * Check `thread` out in the project folder, in place of the thread that is there. Both must be idle. `uncommitted`
   * says what to do with changes the person made by hand: `snapshot` commits them to the thread they are on (the
   * only choice there is, as nothing is thrown away); `remember` makes that the setting from now on.
   */
  ev("workspace.switch", { thread: name, uncommitted: Type.Optional(Type.Literal("snapshot")), remember: Type.Optional(Type.Boolean()) }),
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
  /** Save a form. `message` is the commit message for one that is committed (`harness.yml`). */
  ev("form.save", { id: name, message: Type.Optional(Type.String()) }),
  ev("form.revert", { id: name }),
  /** Try a provider as it is now in the (edited) file; the answer is `provider.status`. */
  ev("provider.test", { provider: name }),
  /** List a provider's models; the answer is `provider.models`. */
  ev("provider.models", { provider: name }),
  /** Give the thread an instruction file (a path in the workspace). The answer is `instructions.set`. */
  ev("instructions.add", { path: name }),
  /** Turn a file on or off for the thread without removing it. */
  ev("instructions.enable", { path: name, on: Type.Boolean() }),
  ev("instructions.remove", { path: name }),
  /**
   * Open a file a message or a tool call named. `path` is relative to the thread's workspace; the controller resolves
   * it when this arrives (the thread may be checked out here, in a worktree of its own, or in neither). `at` asks for
   * the file as the thread had it at that commit, read-only, instead of as it is now.
   */
  ev("file.open", {
    thread: name,
    path: name,
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    at: Type.Optional(hash),
  }),
]);
export type UiIntent = Static<typeof intent>;

export const parseEvent = (raw: unknown): ParseResult<UiEvent> => safeParse(event, raw);
export const parseIntent = (raw: unknown): ParseResult<UiIntent> => safeParse(intent, raw);
