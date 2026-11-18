/**
 * The controls the settings sheet is made of. Each is bound to a place in the file (a path) and edits it through the
 * `FormModel`; what the controller says is wrong with it is shown under it. The common choices are buttons you can see
 * all of at once; the rest are small inputs with their unit beside them.
 */
import type { JSX, ComponentChildren } from "preact";
import { dotted, type FormModel } from "chattree/ui/model/form-model";
import css from "./config.module.css";
import { cn } from "../cn.ts";

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
    <div class={css.cf_issues} id={`${idOf(path)}-issues`} role="alert">
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
    <div class={css.cf_row}>
      <label class={css.cf_label} for={idOf(path)}>
        {label}
      </label>
      <div>
        {children}
        {help !== undefined && <div class={css.cf_help}>{help}</div>}
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
    <div class={css.cf_choice} role="radiogroup" id={idOf(path)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={current === o.value}
          class={cn(css.cf_option, current === o.value && css.on)}
          onClick={() => form.set(path, o.value)}
        >
          <span class={css.cf_option_label}>{o.label}</span>
          {o.hint !== undefined && <span class={css.cf_option_hint}>{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch that is not bound to a place in the file (the caller says what changing it does). */
export function Toggle({
  on,
  onChange,
  label,
  id,
  text = true,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label?: string;
  id?: string;
  text?: boolean;
}): JSX.Element {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={on}
      aria-label={label}
      class={cn(css.cf_switch, on && css.on)}
      onClick={() => onChange(!on)}
    >
      <span class={css.cf_knob} />
      {text && <span class={css.cf_switch_text}>{on ? "On" : "Off"}</span>}
    </button>
  );
}

export function Switch({ form, path, fallback = false }: { form: Form; path: readonly string[]; fallback?: boolean }): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const on = typeof raw === "boolean" ? raw : fallback;
  return <Toggle id={idOf(path)} on={on} onChange={(v) => form.set(path, v)} />;
}

export function NumberInput({
  form,
  path,
  prefix,
  suffix,
  placeholder,
  integer = false,
  scale = 1,
}: {
  form: Form;
  path: readonly string[];
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  integer?: boolean;
  /** Shown value = stored value × scale (0.8 stored as 80 %). */
  scale?: number;
}): JSX.Element {
  const raw = at(form.spec.value.value, path);
  const shown = typeof raw === "number" ? String(Math.round(raw * scale * 1e6) / 1e6) : "";
  const bad = (form.issues.value.get(dotted(path)) ?? []).length > 0;
  return (
    <span class={cn(css.cf_number, bad && css.bad)}>
      {prefix !== undefined && <span class={css.cf_adorn}>{prefix}</span>}
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
      {suffix !== undefined && <span class={css.cf_adorn}>{suffix}</span>}
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
      class={cn(css.cf_text, mono && css.mono)}
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
      class={css.mono}
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
    <section class={css.cf_section}>
      <h3>{title}</h3>
      {hint !== undefined && <p class={css.cf_hint}>{hint}</p>}
      {children}
    </section>
  );
}
