/** Above the composer: why this thread cannot take a message yet, and the way out (add a provider, or approve its `harness.yml`). */
import type { JSX } from "preact";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { ConfigModel } from "chattree/ui/model/config-model";
import { Icon } from "../icons.tsx";
import css from "./chat.module.css";

export function Banner({
  model,
  config,
}: {
  model: InstanceType<typeof ChatModel>;
  config: InstanceType<typeof ConfigModel>;
}): JSX.Element | null {
  const b = model.banner.value;
  if (b === undefined) return null;
  return (
    <div class={css.banner} role="alert">
      <Icon name="info" size={14} />
      <div class={css.banner_text}>
        {b.kind === "no_provider" ? (
          <>
            <strong>No provider yet</strong>
            <span>Add one, so the agent has a model to talk to.</span>
          </>
        ) : b.kind === "unusual_change" ? (
          <>
            <strong>The agent was changed without you</strong>
            <span>
              {b.changes.map((c, i) => (i === 0 ? c.charAt(0).toUpperCase() + c.slice(1) : c)).join("; ")}. Go back to before the change, or
              keep it.
            </span>
          </>
        ) : (
          <>
            <strong>
              {b.state === "unknown"
                ? "This thread’s harness.yml has not been approved"
                : "This thread’s harness.yml has changed since you approved it"}
            </strong>
            <span>
              It decides which keys, tools and commands the agent can use, and a cloned or edited repository can change it. Review it first.
            </span>
          </>
        )}
      </div>
      <div class={css.banner_buttons}>
        {b.kind === "no_provider" ? (
          <button class="primary" onClick={() => config.show("providers")}>
            Add a provider
          </button>
        ) : b.kind === "unusual_change" ? (
          <>
            <button class="secondary" onClick={() => model.undoChange()}>
              Go back
            </button>
            <button class="primary" onClick={() => model.accept()}>
              Keep the change
            </button>
          </>
        ) : (
          <>
            <button class="secondary" onClick={() => config.show("providers")}>
              Review settings
            </button>
            <button class="primary" onClick={() => model.trust()}>
              Trust and continue
            </button>
          </>
        )}
      </div>
    </div>
  );
}
