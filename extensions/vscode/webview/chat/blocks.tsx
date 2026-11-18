/**
 * The blocks of a transcript, each drawn as one unit. A block that is committed shows a small toolbar on hover or
 * focus with fork and rewind; whether rewind applies is the model's call, and the reason it does not is the tooltip.
 */
import type { JSX } from "preact";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { AttachmentView, Block, ToolStatus } from "chattree/ui/model/transcript";
import { toolView, type DiffRow, type ToolView } from "chattree/ui/model/tool-view";
import { Icon, type IconName } from "../icons.tsx";
import { Markdown } from "../markdown.tsx";
import { FileLink, FileLinkContext } from "./FileLink.tsx";

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
    <section class={`block user${block.queued === true ? " queued" : ""}`} aria-label="You" data-commit={block.commit}>
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
    <section class={`block assistant${block.streaming === true ? " streaming" : ""}`} aria-label="Assistant" data-commit={block.commit}>
      <Actions model={model} block={block} />
      <Markdown source={block.markdown} files={{ model, commit: block.commit }} />
      {block.streaming === true && block.markdown === "" && <span class="caret" aria-label="Waiting for the model" />}
    </section>
  );
}

function Reasoning({ model, block }: { model: Model; block: Of<"reasoning"> }): JSX.Element {
  const open = model.isOpen(block);
  const streaming = block.streaming === true;
  return (
    <section class={`block reasoning${open ? " open" : ""}${streaming ? " streaming" : ""}`} data-commit={block.commit}>
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

function Rows({ rows, signs }: { rows: DiffRow[]; signs: boolean }): JSX.Element {
  const width = String(Math.max(0, ...rows.map((r) => r.n ?? 0))).length;
  return (
    <div class="diff-rows" role="table">
      {rows.map((r, i) => (
        <div key={i} class={`diff-row sign-${r.sign === "…" ? "gap" : r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"}`} role="row">
          <span class="diff-n" style={{ minWidth: `${width}ch` }} aria-hidden="true">
            {r.n ?? ""}
          </span>
          {signs && (
            <span class="diff-mark" aria-label={r.sign === "+" ? "added" : r.sign === "-" ? "removed" : undefined}>
              {r.sign === " " || r.sign === "…" ? "" : r.sign}
            </span>
          )}
          <code class="diff-text">{r.text === "" && r.sign !== "…" ? " " : r.text}</code>
        </div>
      ))}
    </div>
  );
}

const Stat = ({ added, removed }: { added: number; removed: number }): JSX.Element => (
  <span class="tool-stat">
    {added > 0 && <span class="stat-add">+{added}</span>}
    {removed > 0 && <span class="stat-del">−{removed}</span>}
  </span>
);

/** The path of a file a tool call touched, as a button that opens it (at its first change, when there is one). */
function FileHead({ path, line, bare = false }: { path: string; line?: number | undefined; bare?: boolean }): JSX.Element {
  const ref = { path, ...(line === undefined ? {} : { line }) };
  const button = (
    <FileLink file={ref}>
      <span>{path}</span>
    </FileLink>
  );
  return bare ? button : <div class="file-head">{button}</div>;
}

function ToolBody({ view }: { view: ToolView }): JSX.Element {
  switch (view.kind) {
    case "edit":
      return (
        <div class="tool-body rich">
          <FileHead path={view.path} line={view.line} />
          {view.failed !== undefined && <pre class="error">{view.failed}</pre>}
          {view.hunks.map((h, i) => (
            <div key={i} class="hunk">
              {h.head !== "" && <div class="hunk-head">{h.head}</div>}
              <Rows rows={h.rows} signs />
            </div>
          ))}
          {view.note !== undefined && <div class="tool-note">{view.note}</div>}
        </div>
      );
    case "write":
      return (
        <div class="tool-body rich">
          <FileHead path={view.path} />
          {view.failed !== undefined && <pre class="error">{view.failed}</pre>}
          <div class="hunk">
            <Rows rows={view.rows} signs />
          </div>
          {view.note !== undefined && <div class="tool-note">{view.note}</div>}
        </div>
      );
    case "read":
      return (
        <div class="tool-body rich">
          <div class="file-head">
            <FileHead path={view.path} line={view.line} bare />
            {view.range !== undefined && <span class="file-meta">{view.range}</span>}
            {view.version !== undefined && <span class="file-meta">version {view.version}</span>}
          </div>
          {view.failed !== undefined && <pre class="error">{view.failed}</pre>}
          {view.rows.length > 0 && (
            <div class="hunk">
              <Rows rows={view.rows} signs={false} />
            </div>
          )}
        </div>
      );
    case "run":
      return (
        <div class="tool-body rich">
          <pre class="terminal">
            <span class="prompt">{view.shell === "script" ? "sh" : "$"} </span>
            {view.command}
          </pre>
          {view.output !== "" && <pre class={`terminal output${view.failed ? " error" : ""}`}>{view.output}</pre>}
          {view.exit !== undefined && view.exit !== 0 && <div class="tool-note exit-bad">exit code {view.exit}</div>}
        </div>
      );
    case "generic":
    default:
      return (
        <div class="tool-body">
          <div class="tool-label">Arguments</div>
          <pre>{view.args}</pre>
          {view.result !== undefined && (
            <>
              <div class="tool-label">Result{view.result.truncated ? " (shortened)" : ""}</div>
              <pre class={view.failed ? "error" : ""}>{view.result.text}</pre>
            </>
          )}
        </div>
      );
  }
}

function Tool({ model, block }: { model: Model; block: Of<"tool"> }): JSX.Element {
  const open = model.isOpen(block);
  const s = STATUS_ICON[block.status];
  const asking = block.status === "awaiting_approval" && model.approval.value?.callId === block.id;
  const view = toolView(block);
  const stat = view.kind === "edit" ? view : view.kind === "write" ? { added: view.added, removed: 0 } : undefined;
  return (
    <section
      class={`block tool call-${block.status}${open ? " open" : ""}`}
      aria-label={`Tool call: ${block.summary}`}
      data-commit={block.commit}
    >
      <button class="tool-head" aria-expanded={open} onClick={() => model.toggle(block.id)}>
        <span class={`tool-status ${s.icon === "spinner" ? "spin" : ""}`} role="img" aria-label={s.label} title={s.label}>
          {s.icon === "spinner" || s.icon === "dot" ? null : <Icon name={s.icon} size={12} />}
        </span>
        <span class="tool-name">{block.name}</span>
        <span class="tool-summary">{block.summary}</span>
        {stat !== undefined && <Stat added={stat.added} removed={stat.removed} />}
        {block.result !== undefined && <span class="tool-ms">{ms(block.result.ms)}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <FileLinkContext.Provider value={{ model, commit: block.commit }}>
          <ToolBody view={view} />
        </FileLinkContext.Provider>
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

/** Adjacent tool calls: one shape, with a single line between the calls. */
export function ToolGroup({ model, blocks }: { model: Model; blocks: Of<"tool">[] }): JSX.Element {
  return (
    <div class="tool-group" role="group" aria-label="Tool calls">
      {blocks.map((b) => (
        <Tool key={b.id} model={model} block={b} />
      ))}
    </div>
  );
}

function Notice({ block }: { block: Of<"notice"> }): JSX.Element {
  return (
    <section class={`block notice level-${block.level}`} role={block.level === "info" ? "note" : "status"} data-commit={block.commit}>
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
  return (
    <div class="block turn-end" data-commit={block.commit}>
      {parts.join(" · ")}
    </div>
  );
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
