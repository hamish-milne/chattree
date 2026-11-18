/**
 * The state of the `harness.yml` editor: whether it is open (in place of the transcript), which page it is on, and the
 * commit message for saving. The file itself is a `FormModel`, made when the controller first sends it, so edits are
 * applied at once and validated by the controller like any form.
 */
import { createModel, computed, signal } from "@preact/signals-core";
import { issueCounts, type PageId } from "./config-sheet.ts";
import { FormModel } from "./form-model.ts";
import type { UiEvent, UiIntent } from "./protocol.ts";

export const ConfigModel = createModel((send: (intent: UiIntent) => void, clock: () => Date = () => new Date()) => {
  const open = signal(false);
  const page = signal<PageId>("providers");
  const message = signal("");
  const form = signal<InstanceType<typeof FormModel> | undefined>(undefined);
  let asked = false;

  const counts = computed(() => issueCounts(form.value?.spec.value.issues ?? []));
  return {
    open,
    /** The time the editor judges expiry by. */
    now: clock,
    page,
    message,
    form,
    counts,
    dirty: computed(() => form.value?.spec.value.dirty === true),
    problems: computed(() => form.value?.spec.value.issues.length ?? 0),
    apply(e: UiEvent): void {
      if (e.type !== "form.set" || e.form.id !== "harness") return;
      const f = form.peek();
      if (f === undefined) form.value = new FormModel(e.form, send);
      else f.apply(e);
      if (!e.form.dirty) message.value = "";
    },
    /** Open or close the editor; the first time the file is asked for. */
    toggle(): void {
      open.value = !open.value;
      if (open.value && !asked) {
        asked = true;
        send({ type: "ready", view: "config" });
      }
    },
    close(): void {
      open.value = false;
    },
    setPage(p: PageId): void {
      page.value = p;
    },
    setMessage(m: string): void {
      message.value = m;
    },
    save(): void {
      if (problemsOf(form.peek()) > 0) return;
      form.peek()?.save(message.peek().trim());
    },
    revert(): void {
      form.peek()?.revert();
    },
  };
});

const problemsOf = (f: InstanceType<typeof FormModel> | undefined): number => f?.spec.peek().issues.length ?? 0;
