/**
 * The chat view's state as a signal model: the open thread's blocks, status bar, composer, pending approval and model
 * settings, with the small derived values a view needs (busy, how full the context is, whether a block is open).
 * It follows the controller's events and sends intents; it knows nothing of VS Code or the DOM.
 */
import { computed, createModel, signal } from "@preact/signals-core";
import type { Activity, Approval, ChatBanner, ChatState, Composer, ModelChoice, StatusBar } from "./chat.ts";
import { FormModel } from "./form-model.ts";
import type { UiEvent, UiIntent } from "./protocol.ts";
import type { FileRef } from "./file-ref.ts";
import type { Block } from "./transcript.ts";

type Thread = ChatState["thread"];

/** Whether a block is open when the person has not touched it: reasoning while it streams, a call that needs a decision or failed. */
const openByDefault = (b: Block): boolean =>
  b.type === "reasoning" ? b.streaming === true : b.type === "tool" ? b.status === "error" || b.status === "awaiting_approval" : false;

/** What clicking a file reference does: open it as it is now, or as the thread had it after the change the reference is in. */
export type FileClick = "current" | "after";

/** A file reference with a menu open on it, and the commit of the block it is in (absent while that block is arriving). */
export interface FileMenu {
  ref: FileRef;
  commit: string | undefined;
  x: number;
  y: number;
}

export const ChatModel = createModel((send: (intent: UiIntent) => void) => {
  const thread = signal<Thread | undefined>(undefined);
  const blocks = signal<readonly Block[]>([]);
  const status = signal<StatusBar | undefined>(undefined);
  const composer = signal<Composer>({ draft: "", attachments: [] });
  const approval = signal<Approval | undefined>(undefined);
  const activity = signal<Activity | undefined>(undefined);
  const models = signal<ModelChoice | undefined>(undefined);
  const banner = signal<ChatBanner | undefined>(undefined);
  const settings = signal<InstanceType<typeof FormModel> | undefined>(undefined);
  /** Blocks whose open state is the opposite of their default. */
  const toggled = signal<ReadonlySet<string>>(new Set());
  const settingsOpen = signal(false);
  /** The block to scroll to and ping. `n` counts, so asking for the same commit again still shows. */
  const reveal = signal<{ commit: string; n: number } | undefined>(undefined);

  /** The extension's setting for a plain click on a file reference. */
  const fileClick = signal<FileClick>("current");
  const fileMenu = signal<FileMenu | undefined>(undefined);

  const busy = computed(() => status.value?.state === "running" || status.value?.state === "awaiting");
  // What a view asks per block is a computed set, not a method: the methods of a model are actions, which a view that calls one
  // does not subscribe through, so it would never be redrawn when the answer changed.
  /** Ids of the blocks that are open: by default, or because the person toggled them. */
  const openBlocks = computed(() => new Set(blocks.value.filter((b) => toggled.value.has(b.id) !== openByDefault(b)).map((b) => b.id)));
  /** Ids of the blocks that can be rewound to: they have a commit that is not the tip, and nothing is running. */
  const rewindable = computed(
    () =>
      new Set(
        busy.value
          ? []
          : blocks.value
              // A message of the person's goes back to before itself, so the newest one may too.
              .filter((b) => b.commit !== undefined && (b.type === "user" || b.commit !== thread.value?.tip))
              .map((b) => b.id),
      ),
  );
  const canSend = computed(
    () => banner.value === undefined && (composer.value.draft.trim() !== "" || composer.value.attachments.length > 0),
  );
  /** How full the context is, 0 to 1, when the limit is known. */
  const contextFraction = computed(() => {
    const c = status.value?.context;
    return c?.limit === undefined || c.limit === 0 ? undefined : Math.min(1, c.used / c.limit);
  });
  const replace = (id: string, f: (b: Block) => Block): void => {
    blocks.value = blocks.value.map((b) => (b.id === id ? f(b) : b));
  };
  const name = (): string | undefined => thread.peek()?.name;

  return {
    thread,
    blocks,
    status,
    composer,
    approval,
    models,
    banner,
    settings,
    settingsOpen,
    activity,
    reveal,
    fileClick,
    fileMenu,
    busy,
    openBlocks,
    rewindable,
    canSend,
    contextFraction,
    /** Take in an event from the controller; false when it is not one this view follows. */
    apply(e: UiEvent): boolean {
      switch (e.type) {
        case "chat.open":
          settings.peek()?.[Symbol.dispose]();
          thread.value = e.state.thread;
          blocks.value = e.state.blocks;
          status.value = e.state.status;
          composer.value = e.state.composer;
          approval.value = e.state.approval;
          activity.value = e.state.activity;
          banner.value = e.state.banner;
          models.value = e.state.model;
          settings.value = e.state.settings === undefined ? undefined : new FormModel(e.state.settings, send);
          toggled.value = new Set();
          settingsOpen.value = false;
          reveal.value = undefined;
          return true;
        case "chat.append":
          blocks.value = [...blocks.value, ...e.blocks];
          return true;
        case "chat.update":
          if (blocks.peek().some((b) => b.id === e.block.id)) replace(e.block.id, () => e.block);
          else blocks.value = [...blocks.value, e.block];
          return true;
        case "chat.replace": {
          const at = blocks.peek().findIndex((b) => b.id === e.from);
          blocks.value = [...(at < 0 ? blocks.peek() : blocks.peek().slice(0, at)), ...e.blocks];
          return true;
        }
        case "chat.delta":
          replace(e.id, (b) =>
            b.type === "assistant"
              ? { ...b, markdown: b.markdown + e.delta }
              : b.type === "reasoning"
                ? { ...b, text: b.text + e.delta }
                : b,
          );
          return true;
        case "chat.thread":
          thread.value = e.thread;
          return true;
        case "chat.status":
          status.value = e.status;
          return true;
        case "chat.reveal":
          reveal.value = { commit: e.commit, n: (reveal.peek()?.n ?? 0) + 1 };
          return true;
        case "chat.models":
          models.value = e.models;
          return true;
        case "chat.composer":
          composer.value = e.composer;
          return true;
        case "chat.banner":
          banner.value = e.banner;
          return true;
        case "chat.approval":
          approval.value = e.approval;
          return true;
        case "chat.activity":
          activity.value = e.activity;
          return true;
        case "form.set":
          return settings.peek()?.apply(e) ?? false;
        default:
          return false;
      }
    },
    setDraft(text: string): void {
      composer.value = { ...composer.peek(), draft: text };
      send({ type: "chat.draft", text });
    },
    /** Send the draft. While the thread is working it is queued: the model sees it in its next request. */
    send(): void {
      const c = composer.peek();
      if (!canSend.peek()) return;
      send({ type: "chat.send", text: c.draft.trim(), ...(busy.peek() ? { queued: true } : {}) });
      composer.value = { ...c, draft: "" };
    },
    stop(): void {
      send({ type: "chat.stop" });
    },
    attach(): void {
      send({ type: "chat.attach" });
    },
    detach(id: string): void {
      send({ type: "chat.detach", id });
    },
    approve(allow: boolean): void {
      const a = approval.peek();
      if (a !== undefined) send({ type: "chat.approve", callId: a.callId, allow });
    },
    /** Carry on a stalled thread: the model runs on it as it is. */
    resume(): void {
      if (status.peek()?.stalled !== undefined) send({ type: "chat.resume" });
    },
    /** Approve the thread's `harness.yml` as it is. */
    trust(): void {
      const t = name();
      if (t !== undefined && banner.peek()?.kind === "untrusted") send({ type: "thread.trust", thread: t });
    },
    /** Keep the unusual change the banner names. */
    accept(): void {
      const t = name();
      if (t !== undefined && banner.peek()?.kind === "unusual_change") send({ type: "thread.accept", thread: t });
    },
    /** Go back to just before the unusual change the banner names. */
    undoChange(): void {
      const b = banner.peek();
      if (b?.kind === "unusual_change") this.rewind(b.before);
    },
    chooseModel(id: string): void {
      if (id !== models.peek()?.current) send({ type: "chat.model", model: id });
    },
    /** `before`: go back to just before the entry the commit holds, its text into the composer. */
    rewind(commit: string, before = false): void {
      const t = name();
      if (t !== undefined) send({ type: "thread.rewind", thread: t, commit, ...(before ? { before } : {}) });
    },
    fork(commit: string, before = false): void {
      const t = name();
      if (t !== undefined) send({ type: "thread.fork", thread: t, commit, ...(before ? { before } : {}) });
    },
    /** Open a file a message or a tool call named. `how` says which version; a click uses the setting. */
    openFile(ref: FileRef, commit: string | undefined, how: FileClick = fileClick.peek()): void {
      const t = name();
      if (t === undefined) return;
      fileMenu.value = undefined;
      // A block that has no commit yet cannot be asked for "after"; the current file is the honest answer.
      const at = how === "after" ? commit : undefined;
      send({
        type: "file.open",
        thread: t,
        path: ref.path,
        ...(ref.line === undefined ? {} : { line: ref.line }),
        ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
        ...(at === undefined ? {} : { at }),
      });
    },
    openFileMenu(ref: FileRef, commit: string | undefined, x: number, y: number): void {
      fileMenu.value = { ref, commit, x, y };
    },
    closeFileMenu(): void {
      fileMenu.value = undefined;
    },
    toggle(id: string): void {
      const next = new Set(toggled.peek());
      if (!next.delete(id)) next.add(id);
      toggled.value = next;
    },
    toggleSettings(): void {
      settingsOpen.value = !settingsOpen.peek();
    },
  };
});
