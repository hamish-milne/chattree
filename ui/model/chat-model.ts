/**
 * The chat view's state as a signal model: the open thread's blocks, status bar, composer, pending approval and model
 * settings, with the small derived values a view needs (busy, how full the context is, whether a block is open).
 * It follows the controller's events and sends intents; it knows nothing of VS Code or the DOM.
 */
import { computed, createModel, signal } from "@preact/signals-core";
import type { Approval, ChatState, Composer, ModelChoice, StatusBar } from "./chat.ts";
import { FormModel } from "./form-model.ts";
import type { UiEvent, UiIntent } from "./protocol.ts";
import type { Block } from "./transcript.ts";

type Thread = ChatState["thread"];

/** Whether a block is open when the person has not touched it: reasoning while it streams, a call that needs a decision or failed. */
const openByDefault = (b: Block): boolean =>
  b.type === "reasoning" ? b.streaming === true : b.type === "tool" ? b.status === "error" || b.status === "awaiting_approval" : false;

export const ChatModel = createModel((send: (intent: UiIntent) => void) => {
  const thread = signal<Thread | undefined>(undefined);
  const blocks = signal<readonly Block[]>([]);
  const status = signal<StatusBar | undefined>(undefined);
  const composer = signal<Composer>({ draft: "", attachments: [] });
  const approval = signal<Approval | undefined>(undefined);
  const models = signal<ModelChoice | undefined>(undefined);
  const settings = signal<InstanceType<typeof FormModel> | undefined>(undefined);
  /** Blocks whose open state is the opposite of their default. */
  const toggled = signal<ReadonlySet<string>>(new Set());
  const settingsOpen = signal(false);
  /** The block to scroll to and ping. `n` counts, so asking for the same commit again still shows. */
  const reveal = signal<{ commit: string; n: number } | undefined>(undefined);

  const busy = computed(() => status.value?.state === "running" || status.value?.state === "awaiting");
  const canSend = computed(() => composer.value.draft.trim() !== "" || composer.value.attachments.length > 0);
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
    settings,
    settingsOpen,
    reveal,
    busy,
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
        case "chat.approval":
          approval.value = e.approval;
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
    chooseModel(id: string): void {
      if (id !== models.peek()?.current) send({ type: "chat.model", model: id });
    },
    /** Rewinding needs a commit that is not the tip and a thread that is not working. */
    canRewind(b: Block): boolean {
      return b.commit !== undefined && b.commit !== thread.value?.tip && !busy.value;
    },
    rewind(commit: string): void {
      const t = name();
      if (t !== undefined) send({ type: "thread.rewind", thread: t, commit });
    },
    fork(commit: string): void {
      const t = name();
      if (t !== undefined) send({ type: "thread.fork", thread: t, commit });
    },
    isOpen(b: Block): boolean {
      return toggled.value.has(b.id) !== openByDefault(b);
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
