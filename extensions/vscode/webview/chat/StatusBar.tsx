/** The line under the message box: what the thread is doing, the model (which opens its settings), the context and the cost. */
import type { JSX } from "preact";
import type { ThreadStatus } from "chattree/ui/model/graph";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { Icon } from "../icons.tsx";
import css from "./chat.module.css";
import { cn, pick } from "../cn.ts";

type Model = InstanceType<typeof ChatModel>;

const STATE: Record<ThreadStatus, string> = {
  idle: "Ready",
  running: "Working…",
  awaiting: "Waiting for you",
  error: "Stopped by an error",
  elsewhere: "Open in another window",
};
const kilo = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export function StatusBar({ model }: { model: Model }): JSX.Element | null {
  const s = model.status.value;
  if (s === undefined) return null;
  const frac = model.contextFraction.value;
  const open = model.settingsOpen.value;
  return (
    <div class={css.status_bar}>
      <span class={cn(css.state, pick(css, `state_${s.stalled !== undefined ? "error" : s.state}`))} title={s.stalled}>
        <span class={css.state_dot} aria-hidden="true" />
        {s.stalled !== undefined ? "Stopped partway" : STATE[s.state]}
      </span>
      <button
        class={cn(css.model_chip, open && css.open)}
        aria-expanded={open}
        aria-controls="model-settings"
        title="Model and its settings"
        onClick={() => model.toggleSettings()}
      >
        <Icon name="sliders" size={12} />
        <span>{s.model}</span>
      </button>
      {s.thinking !== undefined && (
        <span class="dim" title="How much reasoning is asked for">
          thinking: {s.thinking}
        </span>
      )}
      <span class="spacer" />
      {s.context !== undefined && (
        <span
          class={css.context}
          title={
            s.context.limit === undefined
              ? `${s.context.used} tokens of context`
              : `${s.context.used} of ${s.context.limit} tokens of context`
          }
        >
          {frac !== undefined && (
            <span
              class={css.gauge}
              role="meter"
              aria-valuenow={Math.round(frac * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Context used"
            >
              <span class={cn(css.gauge_fill, frac > 0.8 && css.high)} style={{ width: `${Math.round(frac * 100)}%` }} />
            </span>
          )}
          {kilo(s.context.used)}
          {s.context.limit !== undefined && ` / ${kilo(s.context.limit)}`}
        </span>
      )}
      {s.usd !== undefined && (
        <span title={s.unpriced === true ? "Some requests had no known price, so this is a lower bound" : "Cost of this thread"}>
          {s.unpriced === true ? "≥ " : ""}${s.usd.toFixed(2)}
        </span>
      )}
    </div>
  );
}
