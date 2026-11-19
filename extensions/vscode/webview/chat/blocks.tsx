/**
 * The blocks of a transcript, each drawn as one unit. A block that is committed shows a small toolbar on hover or
 * focus with fork and rewind; whether rewind applies is the model's call, and the reason it does not is the tooltip.
 */
import type { JSX } from "preact";
import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { AttachmentView, Block, ToolStatus } from "chattree/ui/model/transcript";
import { toolView, type DiffRow, type ToolView } from "chattree/ui/model/tool-view";
import { Icon, type IconName } from "../icons.tsx";
import { Markdown } from "../markdown.tsx";
import { FileLink, FileLinkContext } from "./FileLink.tsx";
import css from "./chat.module.css";
import { cn, pick } from "../cn.ts";

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
  const can = model.rewindable.value.has(block.id);
  const mine = block.type === "user";
  const why = model.busy.value ? "Stop the thread first" : commit === model.thread.value?.tip ? "This is already the latest commit" : "";
  const rewindLabel = mine ? "Rewind to before this message and edit it" : "Rewind to here";
  const forkLabel = mine ? "Fork from before this message and edit it" : "Fork from here";
  return (
    <div class={css.actions} role="toolbar" aria-label="Message actions">
      <button class="icon-button" title={forkLabel} aria-label={forkLabel} onClick={() => model.fork(commit, mine)}>
        <Icon name="fork" />
      </button>
      <button
        class="icon-button"
        disabled={!can}
        title={can ? rewindLabel : `${rewindLabel}: ${why}`}
        aria-label={rewindLabel}
        onClick={() => model.rewind(commit, mine)}
      >
        <Icon name="rewind" />
      </button>
    </div>
  );
}

function User({ model, block }: { model: Model; block: Of<"user"> }): JSX.Element {
  return (
    <section class={cn(css.block, css.user, block.queued === true && css.queued)} aria-label="You" data-commit={block.commit}>
      <Actions model={model} block={block} />
      {block.from !== undefined && <div class={css.from}>from thread {block.from}</div>}
      <div class={css.user_text}>{block.text}</div>
      {block.attachments.length > 0 && (
        <div class="chips">
          {block.attachments.map((a, i) => (
            <Chip key={i} file={a} />
          ))}
        </div>
      )}
      {block.queued === true && <div class={css.queued_note}>Queued: sent with the next request</div>}
    </section>
  );
}

function Assistant({ model, block }: { model: Model; block: Of<"assistant"> }): JSX.Element {
  return (
    <section class={cn(css.block, css.assistant)} aria-label="Assistant" data-commit={block.commit}>
      <Actions model={model} block={block} />
      <Markdown source={block.markdown} files={{ model, commit: block.commit }} caret={block.streaming === true} />
      {block.streaming === true && block.markdown === "" && <span class={css.caret} aria-label="Waiting for the model" />}
    </section>
  );
}

function Reasoning({ model, block }: { model: Model; block: Of<"reasoning"> }): JSX.Element {
  const open = model.openBlocks.value.has(block.id);
  const streaming = block.streaming === true;
  return (
    <section class={cn(css.block, css.reasoning, open && css.open)} data-commit={block.commit}>
      <button class={css.disclosure} aria-expanded={open} onClick={() => model.toggle(block.id)}>
        <Icon name="chevron" size={12} />
        <span class={streaming ? css.shimmer : ""}>{streaming ? "Thinking…" : "Thought"}</span>
      </button>
      {open && <div class={css.reasoning_text}>{block.text}</div>}
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
    <div class={css.diff_rows} role="table">
      {rows.map((r, i) => (
        <div
          key={i}
          class={cn(css.diff_row, pick(css, `sign_${r.sign === "…" ? "gap" : r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"}`))}
          role="row"
        >
          <span class={css.diff_n} style={{ minWidth: `${width}ch` }} aria-hidden="true">
            {r.n ?? ""}
          </span>
          {signs && (
            <span class={css.diff_mark} aria-label={r.sign === "+" ? "added" : r.sign === "-" ? "removed" : undefined}>
              {r.sign === " " || r.sign === "…" ? "" : r.sign}
            </span>
          )}
          <code class={css.diff_text}>{r.text === "" && r.sign !== "…" ? " " : r.text}</code>
        </div>
      ))}
    </div>
  );
}

const Stat = ({ added, removed }: { added: number; removed: number }): JSX.Element => (
  <span class={css.tool_stat}>
    {added > 0 && <span class={css.stat_add}>+{added}</span>}
    {removed > 0 && <span class={css.stat_del}>−{removed}</span>}
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
  return bare ? button : <div class={css.file_head}>{button}</div>;
}

function ToolBody({ view }: { view: ToolView }): JSX.Element {
  switch (view.kind) {
    case "edit":
      return (
        <div class={cn(css.tool_body, css.rich)}>
          <FileHead path={view.path} line={view.line} />
          {view.failed !== undefined && <pre class={css.error}>{view.failed}</pre>}
          {view.hunks.map((h, i) => (
            <div key={i} class={css.hunk}>
              {h.head !== "" && <div class={css.hunk_head}>{h.head}</div>}
              <Rows rows={h.rows} signs />
            </div>
          ))}
          {view.note !== undefined && <div class={css.tool_note}>{view.note}</div>}
        </div>
      );
    case "write":
      return (
        <div class={cn(css.tool_body, css.rich)}>
          <FileHead path={view.path} />
          {view.failed !== undefined && <pre class={css.error}>{view.failed}</pre>}
          <div class={css.hunk}>
            <Rows rows={view.rows} signs />
          </div>
          {view.note !== undefined && <div class={css.tool_note}>{view.note}</div>}
        </div>
      );
    case "read":
      return (
        <div class={cn(css.tool_body, css.rich)}>
          <div class={css.file_head}>
            <FileHead path={view.path} line={view.line} bare />
            {view.range !== undefined && <span class={css.file_meta}>{view.range}</span>}
            {view.version !== undefined && <span class={css.file_meta}>version {view.version}</span>}
          </div>
          {view.failed !== undefined && <pre class={css.error}>{view.failed}</pre>}
          {view.rows.length > 0 && (
            <div class={css.hunk}>
              <Rows rows={view.rows} signs={false} />
            </div>
          )}
        </div>
      );
    case "run":
      return (
        <div class={cn(css.tool_body, css.rich)}>
          <pre class={css.terminal}>
            <span class={css.prompt}>{view.shell === "script" ? "sh" : "$"} </span>
            {view.command}
          </pre>
          {view.output !== "" && <pre class={cn(css.terminal, css.output, view.failed && css.error)}>{view.output}</pre>}
          {view.exit !== undefined && view.exit !== 0 && <div class={cn(css.tool_note, css.exit_bad)}>exit code {view.exit}</div>}
        </div>
      );
    case "generic":
    default:
      return (
        <div class={css.tool_body}>
          <div class={css.tool_label}>Arguments</div>
          <pre>{view.args}</pre>
          {view.result !== undefined && (
            <>
              <div class={css.tool_label}>Result{view.result.truncated ? " (shortened)" : ""}</div>
              <pre class={view.failed ? css.error : ""}>{view.result.text}</pre>
            </>
          )}
        </div>
      );
  }
}

function Tool({ model, block }: { model: Model; block: Of<"tool"> }): JSX.Element {
  const open = model.openBlocks.value.has(block.id);
  const s = STATUS_ICON[block.status];
  const asking = block.status === "awaiting_approval" && model.approval.value?.callId === block.id;
  const view = useMemo(() => toolView(block), [block]);
  const stat = view.kind === "edit" ? view : view.kind === "write" ? { added: view.added, removed: 0 } : undefined;
  return (
    <section
      class={cn(css.block, css.tool, pick(css, `call_${block.status}`), open && css.open)}
      aria-label={`Tool call: ${block.summary}`}
      data-commit={block.commit}
    >
      <button class={css.tool_head} aria-expanded={open} onClick={() => model.toggle(block.id)}>
        <span class={cn(css.tool_status, s.icon === "spinner" && css.spin)} role="img" aria-label={s.label} title={s.label}>
          {s.icon === "spinner" || s.icon === "dot" ? null : <Icon name={s.icon} size={12} />}
        </span>
        <span class={css.tool_name}>{block.name}</span>
        <span class={css.tool_summary}>{block.summary}</span>
        {stat !== undefined && <Stat added={stat.added} removed={stat.removed} />}
        {block.result?.ms !== undefined && <span class={css.tool_ms}>{ms(block.result.ms)}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <FileLinkContext.Provider value={{ model, commit: block.commit }}>
          <ToolBody view={view} />
        </FileLinkContext.Provider>
      )}
      {asking && (
        <div class={css.approval} role="group" aria-label="Approve this call?">
          <span>Run this call?</span>
          <button class="primary" onClick={() => model.approve(true)}>
            Allow
          </button>
          <button class="secondary" onClick={() => model.approve(false)}>
            Deny
          </button>
        </div>
      )}
      {block.thread !== undefined && <div class={css.tool_thread}>runs on thread {block.thread}</div>}
    </section>
  );
}

/** Adjacent tool calls: one shape, with a single line between the calls. */
function ToolGroupView({ model, blocks }: { model: Model; blocks: Of<"tool">[] }): JSX.Element {
  return (
    <div class={css.tool_group} role="group" aria-label="Tool calls">
      {blocks.map((b) => (
        <Tool key={b.id} model={model} block={b} />
      ))}
    </div>
  );
}

function Notice({ block }: { block: Of<"notice"> }): JSX.Element {
  return (
    <section
      class={cn(css.block, css.notice, pick(css, `level_${block.level}`))}
      role={block.level === "info" ? "note" : "status"}
      data-commit={block.commit}
    >
      <Icon name="info" size={12} />
      <div>
        <div class={css.notice_title}>{block.title}</div>
        {block.detail !== undefined && <div class={css.notice_detail}>{block.detail}</div>}
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
    <div class={cn(css.block, css.turn_end)} data-commit={block.commit}>
      {parts.join(" · ")}
    </div>
  );
}

function BlockContent({ model, block }: { model: Model; block: Block }): JSX.Element {
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

// The transcript draws only the blocks near the view and redraws as it scrolls: a block whose data has not changed is not drawn again.
// (What a block reads from a signal, such as whether it is open, still updates it.)
export const BlockView = memo(BlockContent, (a, b) => a.model === b.model && a.block === b.block);
export const ToolGroup = memo(
  ToolGroupView,
  (a, b) => a.model === b.model && a.blocks.length === b.blocks.length && a.blocks.every((x, i) => x === b.blocks[i]),
);
