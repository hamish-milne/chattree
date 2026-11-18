/**
 * The chat for one thread: header, transcript, the model settings section, the message box and the status bar. All
 * state is in the `ChatModel`; this draws it. The transcript follows new content only while the person is at the
 * bottom of it, so scrolling up to read is not undone by a streaming reply.
 */
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { Icon } from "../icons.tsx";
import { BlockView } from "./blocks.tsx";
import { Composer } from "./Composer.tsx";
import { ModelSettings } from "./ModelSettings.tsx";
import { StatusBar } from "./StatusBar.tsx";

type Model = InstanceType<typeof ChatModel>;

function Transcript({ model }: { model: Model }): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const blocks = model.blocks.value;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el !== null && stuck) el.scrollTop = el.scrollHeight;
  });
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
          {blocks.map((b) => (
            <BlockView key={b.id} model={model} block={b} />
          ))}
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

export function ChatView({ model }: { model: Model }): JSX.Element {
  const thread = model.thread.value;
  if (thread === undefined) return <div class="chat chat-empty">Pick a thread in the graph to chat in it.</div>;
  return (
    <div class="chat">
      <header class="chat-head">
        <span class="chat-title">{thread.title ?? thread.name}</span>
        <span class={`thread-name kind-${thread.kind}`}>{thread.name}</span>
      </header>
      <Transcript model={model} />
      <ModelSettings model={model} />
      <Composer model={model} />
      <StatusBar model={model} />
    </div>
  );
}
