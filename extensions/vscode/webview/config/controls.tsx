/**
 * The controls the settings sheet is made of. Each is bound to a place in the file (a path) and edits it through the
 * `FormModel`; what the controller says is wrong with it is shown under it. The common choices are buttons you can see
 * all of at once; the rest are small inputs with their unit beside them.
 */
import type { JSX, ComponentChildren } from "preact";
import { dotted, type FormModel } from "chattree/ui/model/form-model";

export type Form = InstanceType<typeof FormModel>;
export function at(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const k of path) v = typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v))[k] : undefined;
  return v;
}

const idOf = (path: readonly string[]): string => `c-${path.join("-")}`;

export function Issues({ form, path }: { form: Form; path: readonly string[] }): JSX.Element | null {
  const list = form.issues.value.get(dotted(path)) ?? [];
  if (list.length === 0) return null;
  return (
    <div class="cf-issues" id={`${idOf(path)}-issues`} role="alert">
      {list.map((m, i) => (
        <div key={i}>
          {path.at(-1)} {m}
        </div>
      ))}
    </div>
  );
}

/** A labelled control with its help line and its problems. */
export function Row({
  form,
  path,
  label,
  help,
  children,
}: {
  form: Form;
  path: readonly string[];
  label: string;
  help?: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="cf-row">
      <label class="cf-label" for={idOf(path)}>
        {label}
      </label>
      <div class="cf-control">
        {children}
        {help !== undefined && <div class="cf-help">{help}</div>}
        <Issues form={form} path={path} />
      </div>
    </div>
  );
}

/** One of a few, shown as buttons with a line each: the way to pick that should not hide its options. */
export function Choice({
  form,
  path,
  options,
  fallback,
}: {
  form: Form;
  path: readonly string[];
  options: { value: string; label: string; hint?: string }[];
  /** What counts as picked when the file says nothing (the default). */
  fallback?: string;
}): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const current = typeof raw === "string" ? raw : fallback;
  return (
    <div class="cf-choice" role="radiogroup" id={idOf(path)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={current === o.value}
          class={`cf-option${current === o.value ? " on" : ""}`}
          onClick={() => form.set(path, o.value)}
        >
          <span class="cf-option-label">{o.label}</span>
          {o.hint !== undefined && <span class="cf-option-hint">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ form, path, fallback = false }: { form: Form; path: readonly string[]; fallback?: boolean }): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const on = typeof raw === "boolean" ? raw : fallback;
  return (
    <button id={idOf(path)} role="switch" aria-checked={on} class={`cf-switch${on ? " on" : ""}`} onClick={() => form.set(path, !on)}>
      <span class="cf-knob" />
      <span class="cf-switch-text">{on ? "On" : "Off"}</span>
    </button>
  );
}

export function NumberInput({
  form,
  path,
  prefix,
  suffix,
  placeholder,
  integer = false,
  scale = 1,
  wide = false,
}: {
  form: Form;
  path: readonly string[];
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  integer?: boolean;
  /** Shown value = stored value × scale (0.8 stored as 80 %). */
  scale?: number;
  wide?: boolean;
}): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const shown = typeof raw === "number" ? String(Math.round(raw * scale * 1e6) / 1e6) : "";
  const bad = (form.issues.value.get(dotted(path)) ?? []).length > 0;
  return (
    <span class={`cf-number${wide ? " wide" : ""}${bad ? " bad" : ""}`}>
      {prefix !== undefined && <span class="cf-adorn">{prefix}</span>}
      <input
        id={idOf(path)}
        type="number"
        inputMode="decimal"
        step={integer ? 1 : "any"}
        placeholder={placeholder}
        aria-invalid={bad}
        value={shown}
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v === "") form.remove(path);
          else form.set(path, Number(v) / scale);
        }}
      />
      {suffix !== undefined && <span class="cf-adorn">{suffix}</span>}
    </span>
  );
}

export function TextInput({
  form,
  path,
  placeholder,
  mono = false,
}: {
  form: Form;
  path: readonly string[];
  placeholder?: string;
  mono?: boolean;
}): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const bad = (form.issues.value.get(dotted(path)) ?? []).length > 0;
  return (
    <input
      id={idOf(path)}
      class={`cf-text${mono ? " mono" : ""}`}
      type="text"
      placeholder={placeholder}
      aria-invalid={bad}
      value={typeof raw === "string" ? raw : ""}
      onChange={(e) => {
        const v = e.currentTarget.value;
        if (v === "") form.remove(path);
        else form.set(path, v);
      }}
    />
  );
}

/** A list of short texts, one per line. */
export function Lines({ form, path, placeholder }: { form: Form; path: readonly string[]; placeholder?: string }): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  return (
    <textarea
      id={idOf(path)}
      class="cf-lines mono"
      rows={Math.max(2, list.length + 1)}
      placeholder={placeholder ?? "one per line"}
      value={list.join("\n")}
      onChange={(e) => {
        const items = e.currentTarget.value
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "");
        if (items.length === 0) form.remove(path);
        else form.set(path, items);
      }}
    />
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }): JSX.Element {
  return (
    <section class="cf-section">
      <h3>{title}</h3>
      {hint !== undefined && <p class="cf-hint">{hint}</p>}
      {children}
    </section>
  );
}
