/**
 * The chat for one thread: header, transcript, the model settings section, the message box and the status bar. All
 * state is in the `ChatModel`; this draws it. The transcript follows new content only while the person is at the
 * bottom of it, so scrolling up to read is not undone by a streaming reply.
 */
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { ConfigModel } from "chattree/ui/model/config-model";
import { ConfigView } from "../config/ConfigView.tsx";
import { Icon } from "../icons.tsx";
import type { Block } from "chattree/ui/model/transcript";
import { BlockView, ToolGroup } from "./blocks.tsx";
import { Composer } from "./Composer.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { StatusBar } from "./StatusBar.tsx";

type Model = InstanceType<typeof ChatModel>;

type Item = { key: string; block: Block } | { key: string; tools: Extract<Block, { type: "tool" }>[] };

/** The blocks as the transcript draws them: runs of tool calls become one group. */
function items(blocks: readonly Block[]): Item[] {
  const out: Item[] = [];
  for (const b of blocks) {
    const last = out.at(-1);
    if (b.type !== "tool") out.push({ key: b.id, block: b });
    else if (last !== undefined && "tools" in last) last.tools.push(b);
    else out.push({ key: b.id, tools: [b] });
  }
  return out;
}

/** Scroll the transcript (and only it) to a block and draw the eye to it for a moment. */
function ping(scroller: HTMLElement, el: HTMLElement): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTo({ top: Math.max(0, top - (scroller.clientHeight - el.offsetHeight) / 2), behavior: reduce ? "auto" : "smooth" });
  el.classList.remove("ping");
  void el.offsetWidth;
  el.classList.add("ping");
  setTimeout(() => el.classList.remove("ping"), 1600);
}

function Transcript({ model }: { model: Model }): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const blocks = model.blocks.value;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && stuck) el.scrollTop = el.scrollHeight;
  });
  const reveal = model.reveal.value;
  useLayoutEffect(() => {
    if (reveal === undefined) return;
    const sc = scroller.current;
    // Several blocks can share a commit (a reply and its tool calls); the last is the one the commit ended at.
    const el = sc === null ? undefined : [...sc.querySelectorAll<HTMLElement>(`[data-commit="${CSS.escape(reveal.commit)}"]`)].at(-1);
    if (sc === null || el === undefined) return;
    setStuck(false);
    ping(sc, el);
  }, [reveal]);
  const jump = (): void => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    setStuck(true);
  };
  return (
    <div class="transcript-wrap">
      <div
        class="transcript"
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label="Conversation"
        tabIndex={0}
        onScroll={(e) => setStuck(e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 48)}
      >
        <div class="transcript-inner">
          {blocks.length === 0 && <p class="empty">Nothing here yet. Say something below.</p>}
          {items(blocks).map((item) =>
            "tools" in item ? (
              <ToolGroup key={item.key} model={model} blocks={item.tools} />
            ) : (
              <BlockView key={item.key} model={model} block={item.block} />
            ),
          )}
        </div>
      </div>
      {!stuck && (
        <button class="jump" title="Jump to the latest" aria-label="Jump to the latest" onClick={jump}>
          <Icon name="down" />
        </button>
      )}
    </div>
  );
}

export function ChatView({ model, config }: { model: Model; config: InstanceType<typeof ConfigModel> }): JSX.Element {
  const thread = model.thread.value;
  const editing = config.open.value;
  if (thread === undefined && !editing) return <div class="chat chat-empty">Pick a thread in the graph to chat in it.</div>;
  return (
    <div class="chat">
      <header class="chat-head">
        {editing ? (
          <>
            <button class="icon-button" title="Back to the chat" aria-label="Back to the chat" onClick={() => config.close()}>
              <Icon name="back" />
            </button>
            <span class="chat-title">harness.yml</span>
            <span class="spacer" />
          </>
        ) : (
          <>
            <span class="chat-title">{thread?.title ?? thread?.name}</span>
            <span class={`thread-name kind-${thread?.kind ?? ""}`}>{thread?.name}</span>
            <span class="spacer" />
          </>
        )}
        <button
          class={`icon-button${editing ? " pressed" : ""}`}
          aria-pressed={editing}
          title={editing ? "Close harness.yml" : "Edit harness.yml"}
          aria-label="Edit harness.yml"
          onClick={() => config.toggle()}
        >
          <Icon name="gear" />
          {config.dirty.value && <span class="unsaved-dot" aria-label="Unsaved changes" />}
        </button>
      </header>
      {editing ? (
        <ConfigView model={config} />
      ) : (
        <>
          <Transcript model={model} />
          <ModelSettings model={model} />
          <Composer model={model} />
          <StatusBar model={model} />
        </>
      )}
    </div>
  );
}
