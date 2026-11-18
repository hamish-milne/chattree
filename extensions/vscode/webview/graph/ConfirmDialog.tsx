/**
 * The confirmation before a thread is deleted: a modal over the graph with the words the model gives it. Cancel has
 * the focus, so a stray Enter does not delete; Escape and a click outside cancel.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { GraphModel } from "chattree/ui/model/graph-model";

type Model = InstanceType<typeof GraphModel>;

export function ConfirmDialog({ model }: { model: Model }): JSX.Element | null {
  const c = model.confirmation.value;
  const cancel = useRef<HTMLButtonElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (c !== undefined) cancel.current?.focus();
  }, [c?.title]);
  if (c === undefined) return null;
  return (
    <div class="dialog-scrim" onClick={() => model.cancelDelete()}>
      <div
        class="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            model.cancelDelete();
          } else if (e.key === "Tab") {
            // Two buttons: keep the focus between them.
            e.preventDefault();
            (document.activeElement === cancel.current ? ok : cancel).current?.focus();
          }
        }}
      >
        <h2 id="dialog-title">{c.title}</h2>
        {c.lines.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
        <div class="dialog-buttons">
          <button class="secondary" ref={cancel} onClick={() => model.cancelDelete()}>
            Cancel
          </button>
          <button class="danger" ref={ok} onClick={() => model.confirmDelete()}>
            {c.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
