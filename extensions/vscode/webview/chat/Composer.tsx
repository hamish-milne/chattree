/** The message box: text, staged files, and the send (or queue, or stop) button. */
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { Icon } from "../icons.tsx";
import { Chip } from "./blocks.tsx";

type Model = InstanceType<typeof ChatModel>;

export function Composer({ model }: { model: Model }): JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null);
  const c = model.composer.value;
  const busy = model.busy.value;
  // Grows with the text up to a limit, and shrinks when the text is sent.
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  });
  return (
    <div class="composer">
      {c.attachments.length > 0 && (
        <div class="chips">
          {c.attachments.map((a) => (
            <Chip key={a.id} file={a.file} onRemove={() => model.detach(a.id)} />
          ))}
        </div>
      )}
      <textarea
        ref={box}
        rows={2}
        value={c.draft}
        placeholder={busy ? "Message to queue for the next request…" : "Message chattree…  (Enter to send, Shift+Enter for a new line)"}
        aria-label="Message"
        onInput={(e) => model.setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            model.send();
          }
        }}
      />
      <div class="composer-row">
        <button class="icon-button" title="Attach files" aria-label="Attach files" onClick={() => model.attach()}>
          <Icon name="attach" />
        </button>
        <span class="spacer" />
        {busy && (
          <button class="stop" title="Stop the request" aria-label="Stop" onClick={() => model.stop()}>
            <Icon name="stop" size={12} />
            <span>Stop</span>
          </button>
        )}
        <button
          class="send"
          disabled={!model.canSend.value}
          title={busy ? "Queue this message" : "Send"}
          aria-label={busy ? "Queue message" : "Send"}
          onClick={() => model.send()}
        >
          <Icon name="send" size={14} />
          {busy && <span>Queue</span>}
        </button>
      </div>
    </div>
  );
}
