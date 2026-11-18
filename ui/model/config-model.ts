/**
 * The state of the settings sheet: whether it is open (in place of the transcript), which page it is on, the commit
 * message for saving `harness.yml`, and what the controller reports that is not in the file: whether each provider can
 * be reached, the models each offers, and the thread's instruction files. The file itself is a `FormModel`, made when
 * the controller first sends it, so edits are applied at once and validated by the controller like any form.
 */
import { createModel, computed, signal } from "@preact/signals-core";
import { issueCounts, type PageId } from "./config-sheet.ts";
import { FormModel } from "./form-model.ts";
import type { UiEvent, UiIntent } from "./protocol.ts";
import type { InstructionState, ProviderModels, ProviderStatus } from "./settings.ts";

type Json = Record<string, unknown>;
const providersOf = (value: Json): Record<string, unknown> => {
  const p = value["providers"];
  return typeof p === "object" && p !== null && !Array.isArray(p) ? Object.fromEntries(Object.entries(p)) : {};
};

/** A provider's check, and the provider's settings as they were when it was made (a change makes it stale). */
export interface CheckedStatus extends ProviderStatus {
  of: string;
}

export const ConfigModel = createModel((send: (intent: UiIntent) => void, clock: () => Date = () => new Date()) => {
  const open = signal(false);
  const page = signal<PageId>("providers");
  const message = signal("");
  const form = signal<InstanceType<typeof FormModel> | undefined>(undefined);
  const statuses = signal<Record<string, CheckedStatus>>({});
  const models = signal<Record<string, ProviderModels>>({});
  const instructions = signal<InstructionState>({ files: [], found: [] });
  let asked = false;
  /** What was asked for already, so moving between pages does not ask again. */
  const tested = new Set<string>();
  const listed = new Set<string>();

  const counts = computed(() => issueCounts(form.value?.spec.value.issues ?? []));
  const configOf = (name: string): string => JSON.stringify(providersOf(form.peek()?.spec.peek().value ?? {})[name] ?? null);

  const test = (name: string): void => {
    tested.add(name);
    send({ type: "provider.test", provider: name });
  };
  const list = (name: string): void => {
    listed.add(name);
    send({ type: "provider.models", provider: name });
  };
  /** Ask for what the page showing needs and has not been asked for. */
  const ensure = (): void => {
    if (!open.peek() || form.peek() === undefined) return;
    const names = Object.keys(providersOf(form.peek()?.spec.peek().value ?? {}));
    if (page.peek() === "providers") for (const n of names) if (!tested.has(n)) test(n);
    if (page.peek() === "subagents") for (const n of names) if (!listed.has(n)) list(n);
  };

  return {
    open,
    /** The time the editor judges expiry by. */
    now: clock,
    page,
    message,
    form,
    counts,
    statuses,
    models,
    instructions,
    dirty: computed(() => form.value?.spec.value.dirty === true),
    problems: computed(() => form.value?.spec.value.issues.length ?? 0),
    apply(e: UiEvent): void {
      switch (e.type) {
        case "form.set": {
          if (e.form.id !== "harness") return;
          const f = form.peek();
          if (f === undefined) form.value = new FormModel(e.form, send);
          else f.apply(e);
          if (!e.form.dirty) message.value = "";
          ensure();
          return;
        }
        case "provider.status":
          statuses.value = { ...statuses.peek(), [e.provider]: { ...e.status, of: configOf(e.provider) } };
          return;
        case "provider.models":
          models.value = { ...models.peek(), [e.provider]: e.list };
          return;
        case "instructions.set":
          instructions.value = e.state;
          return;
        default:
          return;
      }
    },
    /** Whether a provider's check was made with the settings it has now. */
    isStale(name: string): boolean {
      const s = statuses.value[name];
      return (
        s !== undefined && s.state !== "checking" && s.of !== JSON.stringify(providersOf(form.value?.spec.value.value ?? {})[name] ?? null)
      );
    },
    /** Try a provider again (also the way to look again after changing it). */
    test,
    /** List a provider's models again. */
    list,
    /** Open or close the sheet; the first time the file is asked for. */
    toggle(): void {
      open.value = !open.value;
      if (open.value && !asked) {
        asked = true;
        send({ type: "ready", view: "config" });
      }
      ensure();
    },
    close(): void {
      open.value = false;
    },
    setPage(p: PageId): void {
      page.value = p;
      ensure();
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
    addInstruction(path: string): void {
      const p = path.trim();
      if (p !== "") send({ type: "instructions.add", path: p });
    },
    enableInstruction(path: string, on: boolean): void {
      send({ type: "instructions.enable", path, on });
    },
    removeInstruction(path: string): void {
      send({ type: "instructions.remove", path });
    },
  };
});

const problemsOf = (f: InstanceType<typeof FormModel> | undefined): number => f?.spec.peek().issues.length ?? 0;
