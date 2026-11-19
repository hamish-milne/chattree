/**
 * The end of the transcript, while the thread is not simply waiting for the person: what the working model is doing (preparing,
 * waiting for the provider, retrying after a failure, streaming, a tool running) and how long it has been at it, or, for a thread that
 * stopped partway, why and a button to carry on. Either way the person is told what is happening instead of being shown a quiet
 * thread.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Activity } from "chattree/ui/model/chat";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { Icon } from "../icons.tsx";
import css from "./chat.module.css";
import { cn } from "../cn.ts";

type Model = InstanceType<typeof ChatModel>;

/** The time now, redrawn every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const seconds = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const chars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k characters` : `${n} characters`);

/** What the activity says, in words, and the part that changes by the second. */
export function describe(a: Activity, now: number): { text: string; extra?: string; warn?: boolean } {
  const since = seconds(now - a.since);
  switch (a.phase) {
    case "preparing":
      return { text: "Preparing the request" };
    case "waiting":
      return {
        text: a.attempt === undefined ? "Waiting for the model to start answering" : `Waiting for the provider (attempt ${a.attempt})`,
        extra: since,
      };
    case "streaming":
      return {
        text:
          a.detail === "thinking"
            ? "The model is thinking"
            : a.detail !== undefined
              ? `The model is writing a call (${a.detail.replace(/^calling /, "")})`
              : "The model is answering",
        extra: a.chars === undefined || a.chars === 0 ? since : `${chars(a.chars)}, ${since}`,
      };
    case "retrying":
      return {
        text: `The provider failed${a.detail === undefined ? "" : ` (${a.detail})`}. Trying again in ${seconds((a.until ?? now) - now)}${a.attempt === undefined ? "" : `, attempt ${a.attempt}`}`,
        warn: true,
      };
    case "tool":
      return { text: `Running ${a.detail ?? "a tool"}`, extra: since };
    case "blocked":
      return { text: `Waiting for ${(a.detail ?? "other threads").split(",").join(", ")} to finish` };
    default:
      return { text: "Working" };
  }
}

/** Questions of the threads below this one: the person is told something there needs them, and goes there to answer. */
function Forwarded({ model }: { model: Model }): JSX.Element | null {
  const questions = model.forwarded.value;
  if (questions.length === 0) return null;
  return (
    <>
      {questions.map((q) => (
        <div key={`${q.thread}:${q.callId}`} class={cn(css.progress, css.progress_warn, css.stalled)} role="status">
          <Icon name="warn" size={12} />
          <span class={css.progress_text}>
            <strong>{q.thread}</strong> is asking: {q.summary}
          </span>
          <button class="primary" onClick={() => model.openThread(q.thread)}>
            Go to {q.thread}
          </button>
        </div>
      ))}
    </>
  );
}

export function Progress({ model }: { model: Model }): JSX.Element {
  return (
    <>
      <Line model={model} />
      <Forwarded model={model} />
    </>
  );
}

function Line({ model }: { model: Model }): JSX.Element | null {
  const a = model.activity.value;
  const stalled = model.status.value?.stalled;
  const now = useNow(a !== undefined && a.phase !== "blocked");
  if (a !== undefined) {
    const d = describe(a, now);
    const blocked = a.phase === "blocked" ? (a.detail ?? "").split(",").filter((n) => n !== "") : [];
    return (
      <div class={cn(css.progress, d.warn === true && css.progress_warn)} role="status" aria-live="polite">
        {d.warn === true ? <Icon name="warn" size={12} /> : <span class={css.progress_spin} aria-hidden="true" />}
        <span class={css.progress_text}>{d.text}</span>
        {d.extra !== undefined && <span class={css.progress_extra}>{d.extra}</span>}
        {blocked.map((n) => (
          <button key={n} onClick={() => model.openThread(n)}>
            Go to {n}
          </button>
        ))}
      </div>
    );
  }
  if (stalled === undefined) return null;
  return (
    <div class={cn(css.progress, css.progress_warn, css.stalled)} role="status">
      <Icon name="warn" size={12} />
      <span class={css.progress_text}>
        <strong>Stopped partway.</strong> {stalled}. The model can carry on without anything from you.
      </span>
      <button class="primary" onClick={() => model.resume()}>
        Continue
      </button>
    </div>
  );
}
