/** The expandable section for the thread's model: which model, how much it thinks, and its settings. Applying adds an entry to the thread. */
import type { JSX } from "preact";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { humanize } from "chattree/ui/model/form-model";
import { FormView } from "../form/FormFields.tsx";
import css from "./chat.module.css";
import formCss from "../form/form.module.css";

type Model = InstanceType<typeof ChatModel>;

export function ModelSettings({ model }: { model: Model }): JSX.Element | null {
  if (!model.settingsOpen.value) return null;
  const choice = model.models.value;
  const form = model.settings.value;
  const level = model.thinking.value;
  const levels = choice?.levels;
  const lead = (
    <>
      {choice !== undefined && (
        <div class={formCss.form_field}>
          <label for="model-select">Model</label>
          <select id="model-select" value={choice.current} onChange={(e) => model.chooseModel(e.currentTarget.value)}>
            {choice.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.provider})
              </option>
            ))}
          </select>
        </div>
      )}
      {levels !== undefined && (
        <div class={formCss.form_field}>
          <label for="thinking-select">Thinking</label>
          <select
            id="thinking-select"
            value={level ?? ""}
            onChange={(e) => model.setThinking(e.currentTarget.value === "" ? undefined : e.currentTarget.value)}
          >
            <option value="">Provider default</option>
            {levels.map((l) => (
              <option key={l.name} value={l.name}>
                {humanize(l.name)}
                {l.name === choice?.defaultLevel ? " (recommended)" : ""}
              </option>
            ))}
            {level === "custom" && (
              <option value="custom" disabled>
                Custom
              </option>
            )}
          </select>
        </div>
      )}
    </>
  );
  return (
    <section class={css.model_settings} id="model-settings" aria-label="Model settings">
      {form === undefined ? lead : <FormView form={form} compact lead={lead} />}
    </section>
  );
}
