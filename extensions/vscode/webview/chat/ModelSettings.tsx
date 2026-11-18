/** The expandable section for the thread's model: which model, and its settings. Applying either adds an entry to the thread. */
import type { JSX } from "preact";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { FormView } from "../form/FormFields.tsx";

type Model = InstanceType<typeof ChatModel>;

export function ModelSettings({ model }: { model: Model }): JSX.Element | null {
  if (!model.settingsOpen.value) return null;
  const choice = model.models.value;
  const form = model.settings.value;
  return (
    <section class="model-settings" id="model-settings" aria-label="Model settings">
      {choice !== undefined && (
        <div class="form-field">
          <label for="model-select">Model</label>
          <select id="model-select" value={choice.current} onChange={(e) => model.chooseModel(e.currentTarget.value)}>
            {choice.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.provider})
              </option>
            ))}
          </select>
          <p class="form-help">Changing the model starts using it from the next request. Both changes are recorded on the thread.</p>
        </div>
      )}
      {form !== undefined && <FormView form={form} />}
    </section>
  );
}
