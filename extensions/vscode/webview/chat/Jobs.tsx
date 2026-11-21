/**
 * The background jobs of the open thread: a list in a popup above the status bar, and, for the job the person clicks, a terminal
 * that shows what it printed as it prints (what was typed, what came back on stdout, what came back on stderr).
 */
import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import type { JobView } from "chattree/ui/model/chat";
import { Icon } from "../icons.tsx";
import { cn } from "../cn.ts";
import css from "./chat.module.css";

type Model = InstanceType<typeof ChatModel>;

/** Time since `from`, for a running job (`12s`, `3 min`, `1 h 5 min`). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const STATE: Record<JobView["status"], string> = {
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  lost: "Lost",
};

/** Re-draw every second while something shows a running time. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function StateMark({ job }: { job: JobView }): JSX.Element {
  if (job.status === "running")
    return <span class={cn(css.job_mark, job.daemon ? css.job_daemon : css.job_spin)} role="img" aria-label={STATE[job.status]} />;
  const icon = job.status === "completed" ? "check" : job.status === "failed" ? "x" : job.status === "stopped" ? "ban" : "warn";
  return (
    <span class={cn(css.job_mark, css[`job_${job.status}`])} role="img" aria-label={STATE[job.status]} title={STATE[job.status]}>
      <Icon name={icon} size={12} />
    </span>
  );
}

function How({ job, now }: { job: JobView; now: number }): string {
  const end = job.endedAt ?? now;
  const time = elapsed(end - job.startedAt);
  return job.status === "running" ? `${time}${job.daemon ? " · no time limit" : ""}` : `${STATE[job.status].toLowerCase()} after ${time}`;
}

function List({ model, now }: { model: Model; now: number }): JSX.Element {
  const jobs = model.jobs.value;
  return (
    <ul class={css.job_list}>
      {jobs.map((j) => (
        <li key={j.id} class={css.job_row}>
          <button class={css.job_open} onClick={() => model.watchJob(j.id)} title="Show what it prints">
            <StateMark job={j} />
            <span class={css.job_text}>
              <span class={css.job_name}>{j.name ?? j.label}</span>
              <span class={css.job_sub}>
                {j.id}
                {j.name === undefined ? "" : ` · ${j.label}`} · {How({ job: j, now })}
              </span>
            </span>
          </button>
          {j.status === "running" && (
            <button class={css.job_stop} title="Stop this job" aria-label={`Stop ${j.name ?? j.label}`} onClick={() => model.stopJob(j.id)}>
              <Icon name="stop" size={11} />
              Stop
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What a terminal shows: each channel in its own colour, plain text only. */
function Terminal({ model }: { model: Model }): JSX.Element {
  const { chunks, dropped } = model.log.value;
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [chunks]);
  return (
    <pre
      class={css.term}
      ref={ref}
      tabIndex={0}
      aria-label="Job output"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {dropped > 0 && <span class={css.term_note}>{`… ${dropped} earlier characters are not kept …\n`}</span>}
      {chunks.length === 0 && <span class={css.term_note}>(nothing printed yet)</span>}
      {chunks.map((c, i) => (
        <span key={i} class={css[`term_${c.channel}`]}>
          {c.text}
        </span>
      ))}
    </pre>
  );
}

function Watched({ model, job, now }: { model: Model; job: JobView | undefined; now: number }): JSX.Element {
  return (
    <>
      <div class={css.jobs_head}>
        <button class={cn("icon-button")} title="Back to the list" aria-label="Back to the jobs list" onClick={() => model.unwatchJob()}>
          <Icon name="back" />
        </button>
        <span class={css.jobs_title}>{job === undefined ? "Job" : (job.name ?? job.label)}</span>
        {job !== undefined && <span class={css.job_sub}>{How({ job, now })}</span>}
        <span class="spacer" />
        {job?.status === "running" && (
          <button class={css.job_stop} title="Stop this job" onClick={() => model.stopJob(job.id)}>
            <Icon name="stop" size={11} />
            Stop
          </button>
        )}
        <button class="icon-button" title="Close" aria-label="Close jobs" onClick={() => model.closeJobs()}>
          <Icon name="x" />
        </button>
      </div>
      <Terminal model={model} />
      <div class={css.term_legend} aria-hidden="true">
        <span class={css.term_stdin}>stdin</span>
        <span class={css.term_stdout}>stdout</span>
        <span class={css.term_stderr}>stderr</span>
      </div>
    </>
  );
}

export function JobsPanel({ model }: { model: Model }): JSX.Element | null {
  const open = model.jobsOpen.value;
  const jobs = model.jobs.value;
  const now = useTick(open && jobs.some((j) => j.status === "running"));
  if (!open) return null;
  const watched = model.watched.value;
  return (
    <section class={cn(css.jobs, watched !== undefined && css.jobs_wide)} id="jobs-panel" aria-label="Background jobs">
      {watched === undefined ? (
        <>
          <div class={css.jobs_head}>
            <span class={css.jobs_title}>Background jobs</span>
            <span class="spacer" />
            <button class="icon-button" title="Close" aria-label="Close jobs" onClick={() => model.closeJobs()}>
              <Icon name="x" />
            </button>
          </div>
          <List model={model} now={now} />
        </>
      ) : (
        <Watched model={model} job={model.watchedJob.value} now={now} />
      )}
    </section>
  );
}

/** The chip in the status bar: a spinner while a job with a time limit runs, a still icon while only servers and watchers do, and how many are running. */
export function JobsChip({ model }: { model: Model }): JSX.Element | null {
  const s = model.jobsSummary.value;
  if (s.total === 0) return null;
  const open = model.jobsOpen.value;
  const title =
    s.running === 0
      ? `${s.total} background job${s.total === 1 ? "" : "s"}, none running`
      : `${s.running} background job${s.running === 1 ? "" : "s"} running`;
  return (
    <button
      class={cn(css.model_chip, css.jobs_chip, open && css.open, s.running === 0 && css.jobs_idle)}
      aria-expanded={open}
      aria-controls="jobs-panel"
      title={title}
      onClick={() => model.toggleJobs()}
    >
      {s.timed ? <span class={css.progress_spin} aria-hidden="true" /> : <Icon name="jobs" size={12} />}
      <span>{s.running === 0 ? s.total : s.running}</span>
    </button>
  );
}
