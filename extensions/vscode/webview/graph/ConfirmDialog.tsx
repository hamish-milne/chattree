/**
 * The confirmation before a thread is deleted: a modal over the graph with the words the model gives it. Cancel has
 * the focus, so a stray Enter does not delete; Escape and a click outside cancel.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { GraphModel } from "chattree/ui/model/graph-model";
import css from "./graph.module.css";

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
    <div class={css["dialog-scrim"]} onClick={() => model.cancelDelete()}>
      <div
        class={css.dialog}
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
        <div class={css["dialog-buttons"]}>
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

/**
 * Asked when switching the workspace would leave files the person changed by hand in the project folder: they are kept as
 * a snapshot on the thread they are on, so nothing is lost; the question is whether to ask every time.
 */
export function SwitchDialog({ model }: { model: Model }): JSX.Element | null {
  const s = model.switching.value;
  const [remember, setRemember] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (s !== undefined) {
      setRemember(false);
      cancel.current?.focus();
    }
  }, [s?.thread]);
  if (s === undefined) return null;
  const shown = s.files.slice(0, 6);
  return (
    <div class={css["dialog-scrim"]} onClick={() => model.cancelSwitch()}>
      <div
        class={css.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="switch-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            model.cancelSwitch();
          }
        }}
      >
        <h2 id="switch-title">Switch to “{s.thread}”?</h2>
        <p>
          You have {s.files.length} {s.files.length === 1 ? "file" : "files"} changed in your workspace that{" "}
          {s.files.length === 1 ? "is" : "are"} not saved in “{s.from}” yet:
        </p>
        <ul class={css["dialog-files"]}>
          {shown.map((f) => (
            <li key={f}>{f}</li>
          ))}
          {s.files.length > shown.length && <li class="dim">and {s.files.length - shown.length} more</li>}
        </ul>
        <p>They will be saved as a snapshot on “{s.from}”, so you can come back to them by switching back.</p>
        <label class={css["dialog-check"]}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
          Do this every time, without asking
        </label>
        <div class={css["dialog-buttons"]}>
          <button class="secondary" ref={cancel} onClick={() => model.cancelSwitch()}>
            Cancel
          </button>
          <button class="primary" onClick={() => model.confirmSwitch(remember)}>
            Save snapshot and switch
          </button>
        </div>
      </div>
    </div>
  );
}
