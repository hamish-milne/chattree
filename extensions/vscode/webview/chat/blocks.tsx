/**
 * The blocks of a transcript, each drawn as one unit. A block that is committed shows a small toolbar on hover or
 * focus with fork and rewind; whether rewind applies is the model's call, and the reason it does not is the tooltip.
 */
import type { JSX } from "preact";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { AttachmentView, Block, ToolStatus } from "chattree/ui/model/transcript";
import { Icon, type IconName } from "../icons.tsx";
import { Markdown } from "../markdown.tsx";

type Model = InstanceType<typeof ChatModel>;
type Of<T extends Block["type"]> = Extract<Block, { type: T }>;

const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const ms = (n: number): string => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export function Chip({ file, onRemove }: { file: AttachmentView; onRemove?: () => void }): JSX.Element {
  return (
    <span class="chip" title={`${file.mime}, ${bytes(file.bytes)}`}>
      <Icon name={file.kind === "image" ? "image" : "file"} size={12} />
      <span class="chip-name">{file.name}</span>
      <span class="chip-size">{bytes(file.bytes)}</span>
      {onRemove !== undefined && (
        <button class="icon-button" aria-label={`Remove ${file.name}`} title="Remove" onClick={onRemove}>
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  );
}

function Actions({ model, block }: { model: Model; block: Block }): JSX.Element | null {
  const commit = block.commit;
  if (commit === undefined) return null;
  const can = model.canRewind(block);
  const why = model.busy.value ? "Stop the thread first" : commit === model.thread.value?.tip ? "This is already the latest commit" : "";
  const rewindLabel = block.type === "user" ? "Rewind and edit this message" : "Rewind to here";
  return (
    <div class="actions" role="toolbar" aria-label="Message actions">
      <button class="icon-button" title="Fork from here" aria-label="Fork from here" onClick={() => model.fork(commit)}>
        <Icon name="fork" />
      </button>
      <button
        class="icon-button"
        disabled={!can}
        title={can ? rewindLabel : `${rewindLabel}: ${why}`}
        aria-label={rewindLabel}
        onClick={() => model.rewind(commit)}
      >
        <Icon name="rewind" />
      </button>
    </div>
  );
}

function User({ model, block }: { model: Model; block: Of<"user"> }): JSX.Element {
  return (
    <section class={`block user${block.queued === true ? " queued" : ""}`} aria-label="You">
      <Actions model={model} block={block} />
      {block.from !== undefined && <div class="from">from thread {block.from}</div>}
      <div class="user-text">{block.text}</div>
      {block.attachments.length > 0 && (
        <div class="chips">
          {block.attachments.map((a, i) => (
            <Chip key={i} file={a} />
          ))}
        </div>
      )}
      {block.queued === true && <div class="queued-note">Queued: sent with the next request</div>}
    </section>
  );
}

function Assistant({ model, block }: { model: Model; block: Of<"assistant"> }): JSX.Element {
  return (
    <section class={`block assistant${block.streaming === true ? " streaming" : ""}`} aria-label="Assistant">
      <Actions model={model} block={block} />
      <Markdown source={block.markdown} />
      {block.streaming === true && block.markdown === "" && <span class="caret" aria-label="Waiting for the model" />}
    </section>
  );
}

function Reasoning({ model, block }: { model: Model; block: Of<"reasoning"> }): JSX.Element {
  const open = model.isOpen(block);
  const streaming = block.streaming === true;
  return (
    <section class={`block reasoning${open ? " open" : ""}${streaming ? " streaming" : ""}`}>
      <button class="disclosure" aria-expanded={open} onClick={() => model.toggle(block.id)}>
        <Icon name="chevron" size={12} />
        <span class={streaming ? "shimmer" : ""}>{streaming ? "Thinking…" : "Thought"}</span>
      </button>
      {open && <div class="reasoning-text">{block.text}</div>}
    </section>
  );
}

const STATUS_ICON: Record<ToolStatus, { icon: IconName | "spinner" | "dot"; label: string }> = {
  pending: { icon: "dot", label: "Starting" },
  awaiting_approval: { icon: "clock", label: "Waiting for your approval" },
  running: { icon: "spinner", label: "Running" },
  ok: { icon: "check", label: "Done" },
  error: { icon: "x", label: "Failed" },
  did_not_run: { icon: "ban", label: "Did not run" },
};

function Tool({ model, block }: { model: Model; block: Of<"tool"> }): JSX.Element {
  const open = model.isOpen(block);
  const s = STATUS_ICON[block.status];
  const asking = block.status === "awaiting_approval" && model.approval.value?.callId === block.id;
  return (
    <section class={`block tool status-${block.status}${open ? " open" : ""}`} aria-label={`Tool call: ${block.summary}`}>
      <button class="tool-head" aria-expanded={open} onClick={() => model.toggle(block.id)}>
        <span class={`tool-status ${s.icon === "spinner" ? "spin" : ""}`} role="img" aria-label={s.label} title={s.label}>
          {s.icon === "spinner" || s.icon === "dot" ? null : <Icon name={s.icon} size={12} />}
        </span>
        <span class="tool-name">{block.name}</span>
        <span class="tool-summary">{block.summary}</span>
        {block.result !== undefined && <span class="tool-ms">{ms(block.result.ms)}</span>}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div class="tool-body">
          <div class="tool-label">Arguments</div>
          <pre>{block.args}</pre>
          {block.result !== undefined && (
            <>
              <div class="tool-label">Result{block.result.truncated ? " (shortened)" : ""}</div>
              <pre class={block.status === "error" ? "error" : ""}>{block.result.text}</pre>
            </>
          )}
        </div>
      )}
      {asking && (
        <div class="approval" role="group" aria-label="Approve this call?">
          <span>Run this call?</span>
          <button class="primary" onClick={() => model.approve(true)}>
            Allow
          </button>
          <button class="secondary" onClick={() => model.approve(false)}>
            Deny
          </button>
        </div>
      )}
      {block.thread !== undefined && <div class="tool-thread">runs on thread {block.thread}</div>}
    </section>
  );
}

function Notice({ block }: { block: Of<"notice"> }): JSX.Element {
  return (
    <section class={`block notice level-${block.level}`} role={block.level === "info" ? "note" : "status"}>
      <Icon name="info" size={12} />
      <div>
        <div class="notice-title">{block.title}</div>
        {block.detail !== undefined && <div class="notice-detail">{block.detail}</div>}
      </div>
    </section>
  );
}

function TurnEnd({ block }: { block: Of<"turn_end"> }): JSX.Element {
  const parts = [
    block.usage === undefined ? undefined : `${kilo(block.usage.input)} in`,
    block.usage === undefined ? undefined : `${kilo(block.usage.output)} out`,
    block.usage === undefined || block.usage.cached === 0 ? undefined : `${kilo(block.usage.cached)} cached`,
    block.usd !== undefined ? `$${block.usd.toFixed(3)}` : block.unpriced === true ? "price unknown" : undefined,
    block.stop === "end_turn" ? undefined : block.stop,
  ].filter((p): p is string => p !== undefined);
  return <div class="block turn-end">{parts.join(" · ")}</div>;
}

export function BlockView({ model, block }: { model: Model; block: Block }): JSX.Element {
  switch (block.type) {
    case "user":
      return <User model={model} block={block} />;
    case "assistant":
      return <Assistant model={model} block={block} />;
    case "reasoning":
      return <Reasoning model={model} block={block} />;
    case "tool":
      return <Tool model={model} block={block} />;
    case "notice":
      return <Notice block={block} />;
    case "turn_end":
    default:
      return <TurnEnd block={block} />;
  }
}
