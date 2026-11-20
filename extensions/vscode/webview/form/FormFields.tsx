/**
 * Draws a form from the fields `ui/model/form-model.ts` derives from a schema: text, numbers, switches, choices, lists
 * of text, groups and maps of groups. It edits nothing itself: a change goes to the `FormModel`, which sends it to the
 * controller and shows the answer, including what is wrong.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Field, FormModel } from "chattree/ui/model/form-model";
import css from "./form.module.css";
import { cn, pick } from "../cn.ts";

type Form = InstanceType<typeof FormModel>;

/** A default value as the person reads it. */
const shown = (x: unknown): string =>
  typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : JSON.stringify(x);

const idOf = (path: readonly string[]): string => `f-${path.join("-")}`;

function Control({ form, field }: { form: Form; field: Field }): JSX.Element | null {
  const id = idOf(field.path);
  const invalid = field.issues.length > 0;
  const common = { id, "aria-invalid": invalid, "aria-describedby": invalid ? `${id}-issues` : undefined };
  switch (field.kind) {
    case "string":
      return (
        <input
          {...common}
          type="text"
          placeholder={typeof field.fallback === "string" ? field.fallback : "Provider default"}
          value={field.value}
          onChange={(e) => form.set(field.path, e.currentTarget.value)}
        />
      );
    case "number": {
      const { min, max } = field;
      const slider = min !== undefined && max !== undefined;
      const fallback = typeof field.fallback === "number" ? field.fallback : undefined;
      const range = slider ? max - min : 0;
      const step = field.integer ? 1 : range <= 2 ? 0.05 : 0.1;
      const set = (raw: string): void => {
        if (raw === "") form.remove(field.path);
        else form.set(field.path, Number(raw));
      };
      return (
        <span class={css.number}>
          {slider && (
            <input
              type="range"
              class={cn(css.slider, field.value === undefined && css.unset)}
              aria-label={field.label}
              min={min}
              max={max}
              step={step}
              value={field.value ?? fallback ?? min}
              onInput={(e) => set(e.currentTarget.value)}
            />
          )}
          <input
            {...common}
            type="number"
            step={field.integer ? 1 : "any"}
            min={field.min}
            max={field.max}
            placeholder={fallback === undefined ? "Default" : String(fallback)}
            value={field.value ?? ""}
            onChange={(e) => set(e.currentTarget.value)}
          />
          <Reset form={form} field={field} />
        </span>
      );
    }
    case "boolean":
      return (
        <input
          {...common}
          type="checkbox"
          class={css.switch}
          role="switch"
          checked={field.value}
          onChange={(e) => form.set(field.path, e.currentTarget.checked)}
        />
      );
    case "choice":
      return (
        <select {...common} value={field.value ?? ""} onChange={(e) => form.set(field.path, e.currentTarget.value)}>
          {field.value === undefined && (
            <option value="" disabled={!field.optional}>
              {field.fallback === undefined ? "Provider default" : `Default (${shown(field.fallback)})`}
            </option>
          )}
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "list":
      return (
        <textarea
          {...common}
          rows={Math.max(2, field.value.length + 1)}
          placeholder="one per line"
          value={field.value.join("\n")}
          onChange={(e) =>
            form.set(
              field.path,
              e.currentTarget.value
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l !== ""),
            )
          }
        />
      );
    case "pick": {
      const fallback = field.options.find((o) => JSON.stringify(o.value) === JSON.stringify(field.fallback))?.label;
      return (
        <select
          {...common}
          value={field.current ?? (field.custom ? "custom" : "")}
          onChange={(e) => {
            const option = field.options.find((o) => o.key === e.currentTarget.value);
            if (option !== undefined) form.set(field.path, option.value);
          }}
        >
          {field.current === undefined && !field.custom && (
            <option value="" disabled={!field.optional}>
              {fallback === undefined ? "Provider default" : `Default (${fallback})`}
            </option>
          )}
          {field.custom && (
            <option value="custom" disabled>
              Custom (set in harness.yml)
            </option>
          )}
          {field.options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case "json":
      return <JsonBox form={form} field={field} common={common} />;
    case "raw":
      return <pre class={css.form_raw}>{JSON.stringify(field.value, null, 2)}</pre>;
    default:
      return null;
  }
}

/** An object of anything, as JSON text: kept when it parses to an object, and a problem is said beside it until it does. */
function JsonBox({ form, field, common }: { form: Form; field: Field & { kind: "json" }; common: Record<string, unknown> }): JSX.Element {
  const [bad, setBad] = useState<string | undefined>(undefined);
  const shownText = field.value === undefined ? "" : JSON.stringify(field.value, null, 2);
  return (
    <span class={css.json}>
      <textarea
        {...common}
        rows={Math.max(2, shownText.split("\n").length)}
        spellcheck={false}
        placeholder={'{ "name": "value" }'}
        value={shownText}
        onChange={(e) => {
          const raw = e.currentTarget.value.trim();
          if (raw === "") {
            setBad(undefined);
            form.remove(field.path);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it must be an object");
            setBad(undefined);
            form.set(field.path, parsed);
          } catch (err) {
            setBad(err instanceof Error ? err.message : "not JSON");
          }
        }}
      />
      {bad !== undefined && (
        <small class={css.form_issues} role="alert">
          {bad}
        </small>
      )}
    </span>
  );
}

/** Puts an optional setting back to what the provider does when it is not set. */
function Reset({ form, field }: { form: Form; field: Field }): JSX.Element | null {
  if (!field.optional || field.kind === "group" || field.kind === "map" || field.kind === "boolean" || field.kind === "json") return null;
  const set = field.kind === "list" ? field.value.length > 0 : field.value !== undefined;
  return (
    <button
      type="button"
      class={cn("icon-button", css.reset, !set && css.reset_idle)}
      tabIndex={set ? 0 : -1}
      aria-hidden={!set}
      title="Back to the default"
      aria-label={`Reset ${field.label}`}
      onClick={() => form.remove(field.path)}
    >
      ↺
    </button>
  );
}

function FieldView({ form, field }: { form: Form; field: Field }): JSX.Element {
  const id = idOf(field.path);
  if (field.kind === "group") {
    return (
      <fieldset class={css.form_group}>
        <legend>{field.label}</legend>
        {field.description !== undefined && <p class={css.form_help}>{field.description}</p>}
        <Fields form={form} fields={field.fields} />
        <Issues id={id} issues={field.issues} />
      </fieldset>
    );
  }
  if (field.kind === "map") {
    return (
      <fieldset class={css.form_group}>
        <legend>{field.label}</legend>
        {field.description !== undefined && <p class={css.form_help}>{field.description}</p>}
        {field.entries.map((e) => (
          <fieldset key={e.key} class={cn(css.form_group, css.entry)}>
            <legend>
              {e.key}
              <button
                class="icon-button"
                title={`Remove ${e.key}`}
                aria-label={`Remove ${e.key}`}
                onClick={() => form.remove([...field.path, e.key])}
              >
                ×
              </button>
            </legend>
            <Fields form={form} fields={e.fields} />
          </fieldset>
        ))}
        <Issues id={id} issues={field.issues} />
      </fieldset>
    );
  }
  return (
    <div class={cn(css.form_field, pick(css, `kind_${field.kind}`))}>
      <label for={id}>{field.label}</label>
      <Control form={form} field={field} />
      {field.kind !== "number" && <Reset form={form} field={field} />}
      {field.description !== undefined && <p class={css.form_help}>{field.description}</p>}
      <Issues id={id} issues={field.issues} />
    </div>
  );
}

function Issues({ id, issues }: { id: string; issues: string[] }): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <p class={css.form_issues} id={`${id}-issues`} role="alert">
      {issues.join("; ")}
    </p>
  );
}

export function Fields({ form, fields }: { form: Form; fields: Field[] }): JSX.Element {
  return (
    <>
      {fields.map((f) => (
        <FieldView key={f.path.join(".")} form={form} field={f} />
      ))}
    </>
  );
}

/**
 * A whole form: its fields, the problems with no field of their own, and the save and revert buttons. `compact` sets the labels beside
 * the controls and keeps the settings the schema calls advanced behind a disclosure, for a form that sits in a corner of another view.
 * `lead` is drawn before the fields.
 */
export function FormView({ form, compact = false, lead }: { form: Form; compact?: boolean; lead?: JSX.Element | null }): JSX.Element {
  const spec = form.spec.value;
  const tree = form.tree.value;
  const main = compact ? tree.fields.filter((f) => !f.advanced) : tree.fields;
  const more = compact ? tree.fields.filter((f) => f.advanced) : [];
  return (
    <form
      class={cn(css.form, compact && css.compact)}
      onSubmit={(e) => {
        e.preventDefault();
        form.save();
      }}
    >
      {tree.unplaced.length > 0 && (
        <p class={css.form_issues} role="alert">
          {tree.unplaced.map((i) => (i.path === "" ? i.message : `${i.path} ${i.message}`)).join("; ")}
        </p>
      )}
      {lead}
      <Fields form={form} fields={main} />
      {more.length > 0 && (
        <details class={css.advanced} open={more.some((f) => f.issues.length > 0)}>
          <summary>Advanced</summary>
          <Fields form={form} fields={more} />
        </details>
      )}
      <div class={css.form_buttons}>
        <button
          type="submit"
          class="primary"
          disabled={!spec.dirty || spec.issues.length > 0}
          title={spec.issues.length > 0 ? "Fix the problems first" : undefined}
        >
          {spec.saveLabel}
        </button>
        <button type="button" class="secondary" disabled={!spec.dirty} onClick={() => form.revert()}>
          Revert
        </button>
      </div>
    </form>
  );
}
