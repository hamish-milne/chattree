/**
 * The thread graph: lanes drawn as one SVG behind a list of rows. All state is in the `GraphModel`; this file only
 * draws it and turns clicks and keys into model calls. Colours come from VS Code theme variables, so it follows
 * the user's theme.
 */
import type { JSX } from "preact";
import type { GraphEdge, GraphRow } from "chattree/ui/model/graph-layout";
import type { GraphThread, ThreadStatus } from "chattree/ui/model/graph";
import type { GraphModel } from "chattree/ui/model/graph-model";
import { Icon } from "../icons.tsx";

type Model = InstanceType<typeof GraphModel>;

const ROW = 24;
const LANE = 14;
const PAD = 12;
const x = (lane: number): number => PAD + lane * LANE;
const y = (row: number): number => row * ROW + ROW / 2;
const COLORS = 5;

/** The colour of a lane: the theme's graph colours in turn, the trunk first. Threads that are open together are on different lanes, so they differ. */
const colorOf = (lane: number): string => `var(--vscode-scmGraph-foreground${(lane % COLORS) + 1})`;

const clean = (summary: string): string => summary.replace(/^(user|assistant): /, "");
const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function edgePath(e: GraphEdge): string {
  const x1 = x(e.fromLane);
  const y1 = y(e.from);
  const x2 = x(e.toLane);
  const y2 = y(e.to);
  if (e.fromLane === e.toLane) return `M${x1} ${y1}V${y2}`;
  const k = ROW * 0.9;
  // A fork leaves the parent's lane at the parent, going down the child's lane until it is near; a merge leaves the
  // merge commit sideways and then runs down the merged thread's lane.
  return e.bend === "bottom"
    ? `M${x1} ${y1}V${y2 - k}C${x1} ${y2 - k / 3} ${x2} ${y2 - k / 2} ${x2} ${y2}`
    : `M${x1} ${y1}C${x1} ${y1 + k / 2} ${x2} ${y1 + k / 3} ${x2} ${y1 + k}V${y2}`;
}

function Node({ row, index, color, lit }: { row: GraphRow; index: number; color: string; lit: boolean }): JSX.Element {
  return (
    <g>
      {lit && <circle class="halo" cx={x(row.lane)} cy={y(index)} r={10} fill={color} />}
      <Shape row={row} index={index} color={color} />
    </g>
  );
}

function Shape({ row, index, color }: { row: GraphRow; index: number; color: string }): JSX.Element {
  const cx = x(row.lane);
  const cy = y(index);
  const common = { stroke: color, "stroke-width": 1.5 };
  if (row.type === "fold") {
    return (
      <g>
        <rect x={cx - 8} y={cy - 6} width={16} height={12} rx={4} fill="var(--vscode-sideBar-background)" {...common} />
        <text x={cx} y={cy + 3.5} text-anchor="middle" class="node-count" fill={color}>
          {row.calls}
        </text>
      </g>
    );
  }
  switch (row.commit.kind) {
    case "user":
      return <circle cx={cx} cy={cy} r={5} fill={color} {...common} />;
    case "fork_merge":
    case "subagent_result":
      return <circle cx={cx} cy={cy} r={6} fill="var(--vscode-sideBar-background)" stroke-width={3} stroke={color} />;
    case "branch_start":
      return <rect x={cx - 4} y={cy - 4} width={8} height={8} transform={`rotate(45 ${cx} ${cy})`} fill={color} />;
    case "interrupted":
      return <path d={`M${cx - 4} ${cy - 4}l8 8m0 -8l-8 8`} stroke="var(--vscode-errorForeground)" stroke-width={2} fill="none" />;
    case "assistant":
      return <circle cx={cx} cy={cy} r={4} fill="var(--vscode-sideBar-background)" {...common} />;
    default:
      return <circle cx={cx} cy={cy} r={2.5} fill={color} />;
  }
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: "idle",
  running: "working",
  awaiting: "waiting for you",
  error: "stopped by an error",
  elsewhere: "open in another window",
};

function Status({ status }: { status: ThreadStatus }): JSX.Element | null {
  if (status === "idle") return null;
  return (
    <span class={`status status-${status}`} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === "elsewhere" ? (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M5 7V5a3 3 0 0 1 6 0v2h1v6H4V7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z" fill="currentColor" />
        </svg>
      ) : status === "error" ? (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path
            d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3 9.3-.7.7L8 8.7 5.7 11l-.7-.7L7.3 8 5 5.7l.7-.7L8 7.3 10.3 5l.7.7L8.7 8z"
            fill="currentColor"
          />
        </svg>
      ) : null}
    </span>
  );
}

function Pill({ thread, color }: { thread: GraphThread; color: string }): JSX.Element {
  return (
    <span
      class={`pill${thread.merged === true ? " merged" : ""}`}
      style={{ "--c": color }}
      title={[thread.title, thread.model, thread.merged === true ? "merged" : undefined].filter(Boolean).join(" · ")}
    >
      <span class="pill-name">{thread.name}</span>
      <Status status={thread.status} />
    </span>
  );
}

function labelOf(row: GraphRow): { text: string; dim: boolean; strong: boolean } {
  if (row.type === "fold") return { text: `${row.calls} tool call${row.calls === 1 ? "" : "s"}`, dim: true, strong: false };
  const kind = row.commit.kind;
  return {
    text: clean(row.commit.summary),
    dim: kind === "tool_result" || kind === "approval" || kind === "agent_setup" || kind === "header",
    strong: kind === "user",
  };
}

export function GraphView({ model }: { model: Model }): JSX.Element {
  const layout = model.layout.value;
  const data = model.data.value;
  if (layout === undefined || data === undefined) return <div class="graph-empty">No conversation yet.</div>;
  const threads = new Map(data.threads.map((t) => [t.name, t]));
  const selected = model.selected.value;
  const lit = model.lit.value;
  const menu = model.menu.value;
  const width = PAD * 2 + (layout.lanes - 1) * LANE;
  // The newest row of an expanded fold carries the way to collapse it.
  const collapsers = new Set<string>();
  const seenFolds = new Set<string>();
  for (const r of layout.rows) {
    if (r.type === "commit" && r.foldId !== undefined && !seenFolds.has(r.foldId)) {
      seenFolds.add(r.foldId);
      collapsers.add(r.id);
    }
  }

  const commitOf = (r: GraphRow): string => (r.type === "fold" ? (r.commits.at(-1)?.hash ?? r.id) : r.id);
  const activate = (r: GraphRow): void => {
    if (r.type === "fold") model.toggleFold(r.id);
    else model.open(r.id);
  };
  const move = (from: HTMLElement, delta: number): void => {
    const rows = [...(from.closest(".graph")?.querySelectorAll<HTMLElement>(".row") ?? [])];
    rows[Math.max(0, Math.min(rows.length - 1, rows.indexOf(from) + delta))]?.focus();
  };

  return (
    <div
      class="graph"
      role="list"
      aria-label="Threads"
      onKeyDown={(e) => {
        if (e.key === "Escape") model.closeMenu();
      }}
    >
      <div class="graph-body" style={{ height: `${layout.rows.length * ROW}px` }}>
        {layout.rows.map((r, i) => {
          const commit = commitOf(r);
          const isSelected = selected.thread === r.thread && r.tipOf !== undefined;
          const cls = [
            "row-bg",
            isSelected ? "selected" : "",
            lit.thread === r.thread ? "thread-lit" : "",
            lit.commit === commit ? "commit-lit" : "",
          ];
          return (
            <div
              key={r.id}
              class={cls.filter(Boolean).join(" ")}
              style={{ top: `${i * ROW}px`, "--c": colorOf(r.lane) }}
              aria-hidden="true"
            />
          );
        })}
        <svg class="lanes" width={width} height={layout.rows.length * ROW} aria-hidden="true">
          {layout.edges.map((e, i) => (
            <path key={i} d={edgePath(e)} stroke={colorOf(e.bend === "bottom" ? e.fromLane : e.toLane)} stroke-width={1.5} fill="none" />
          ))}
          {layout.rows.map((r, i) => (
            <Node key={r.id} row={r} index={i} color={colorOf(r.lane)} lit={lit.commit !== undefined && commitOf(r) === lit.commit} />
          ))}
        </svg>
        {layout.rows.map((r, i) => {
          const l = labelOf(r);
          const tip = r.tipOf === undefined ? undefined : threads.get(r.tipOf);
          const commit = commitOf(r);
          return (
            <div
              key={r.id}
              class={`row${r.type === "fold" ? " fold" : ""}${r.type === "commit" && r.foldId !== undefined ? " in-fold" : ""}`}
              style={{ top: `${i * ROW}px`, paddingLeft: `${width + 16}px` }}
              role="listitem"
              tabIndex={i === 0 ? 0 : -1}
              aria-label={`${l.text}, thread ${r.thread}`}
              aria-expanded={r.type === "fold" ? false : undefined}
              onClick={() => activate(r)}
              onMouseEnter={() => model.setHover(commit)}
              onMouseLeave={() => model.setHover(undefined)}
              onContextMenu={(e) => {
                e.preventDefault();
                model.openMenu(commit, e.clientX, e.clientY);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(e.currentTarget, e.key === "ArrowDown" ? 1 : -1);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate(r);
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  model.openMenu(commit, box.left + 24, box.bottom);
                }
              }}
            >
              {r.type === "fold" && (
                <span class="chevron" style={{ left: `${width - 4}px` }} aria-hidden="true">
                  <Icon name="chevron" size={14} />
                </span>
              )}
              {collapsers.has(r.id) && r.type === "commit" && r.foldId !== undefined && (
                <button
                  class="chevron expanded"
                  style={{ left: `${width - 4}px` }}
                  aria-label="Collapse tool calls"
                  title="Collapse tool calls"
                  onClick={(e) => {
                    e.stopPropagation();
                    model.toggleFold(r.foldId ?? "");
                  }}
                >
                  <Icon name="chevron" size={14} />
                </button>
              )}
              <span class={`label${l.dim ? " dim" : ""}${l.strong ? " strong" : ""}`}>{l.text}</span>
              {tip !== undefined && <Pill thread={tip} color={colorOf(r.lane)} />}
              <span class="time">{r.type === "fold" ? "" : clock(r.commit.time)}</span>
            </div>
          );
        })}
      </div>
      {menu !== undefined && (
        <>
          <div
            class="menu-scrim"
            onClick={() => model.closeMenu()}
            onContextMenu={(e) => {
              e.preventDefault();
              model.closeMenu();
            }}
          />
          <div class="menu" role="menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
            {model.menuActions.value.map((a) => (
              <button
                key={a.id}
                class="menu-item"
                role="menuitem"
                disabled={!a.enabled}
                aria-disabled={!a.enabled}
                title={a.reason}
                onClick={() => model.act(a.id, menu.commit)}
              >
                <span>{a.label}</span>
                {a.reason !== undefined && <span class="reason">{a.reason}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
