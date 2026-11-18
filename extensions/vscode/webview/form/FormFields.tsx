/**
 * Draws a form from the fields `ui/model/form-model.ts` derives from a schema: text, numbers, switches, choices, lists
 * of text, groups and maps of groups. It edits nothing itself: a change goes to the `FormModel`, which sends it to the
 * controller and shows the answer, including what is wrong.
 */
import type { JSX } from "preact";
import type { Field, FormModel } from "chattree/ui/model/form-model";
import css from "./form.module.css";
import { cn, pick } from "../cn.ts";

type Form = InstanceType<typeof FormModel>;

const idOf = (path: readonly string[]): string => `f-${path.join("-")}`;

function Control({ form, field }: { form: Form; field: Field }): JSX.Element | null {
  const id = idOf(field.path);
  const invalid = field.issues.length > 0;
  const common = { id, "aria-invalid": invalid, "aria-describedby": invalid ? `${id}-issues` : undefined };
  switch (field.kind) {
    case "string":
      return <input {...common} type="text" value={field.value} onChange={(e) => form.set(field.path, e.currentTarget.value)} />;
    case "number":
      return (
        <input
          {...common}
          type="number"
          step={field.integer ? 1 : "any"}
          min={field.min}
          max={field.max}
          value={field.value ?? ""}
          onChange={(e) => {
            const raw = e.currentTarget.value;
            if (raw === "") form.remove(field.path);
            else form.set(field.path, Number(raw));
          }}
        />
      );
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
            <option value="" disabled>
              (not set)
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
    case "raw":
      return <pre class={css.form_raw}>{JSON.stringify(field.value, null, 2)}</pre>;
    default:
      return null;
  }
}

function FieldView({ form, field }: { form: Form; field: Field }): JSX.Element {
  const id = idOf(field.path);
  if (field.kind === "group") {
    return (
      <fieldset class={css.form_group}>
        <legend>{field.key}</legend>
        {field.description !== undefined && <p class={css.form_help}>{field.description}</p>}
        <Fields form={form} fields={field.fields} />
        <Issues id={id} issues={field.issues} />
      </fieldset>
    );
  }
  if (field.kind === "map") {
    return (
      <fieldset class={css.form_group}>
        <legend>{field.key}</legend>
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
      <label for={id}>{field.key}</label>
      <Control form={form} field={field} />
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

/** A whole form: its fields, the problems with no field of their own, and the save and revert buttons. */
export function FormView({ form }: { form: Form }): JSX.Element {
  const spec = form.spec.value;
  const tree = form.tree.value;
  return (
    <form
      class={css.form}
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
      <Fields form={form} fields={tree.fields} />
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
