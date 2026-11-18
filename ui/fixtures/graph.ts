/**
 * A realistic thread graph for the mock extension and the tests: one main thread with a tool-heavy session, a fork
 * that was tried and merged back, a subagent still running, and forks in each of the other states. Hashes and times
 * are made up and deterministic.
 */
import type { GraphCommit, GraphData, GraphKind, GraphThread, ThreadStatus } from "../model/graph.ts";

class Builder {
  readonly commits: GraphCommit[] = [];
  private readonly tips = new Map<string, string>();
  private n = 0;

  /** Add a commit on `thread`. Its parent is the thread's previous tip unless `parents` says otherwise. */
  add(thread: string, kind: GraphKind, summary: string, more: { parents?: string[]; toolCalls?: number; usd?: number } = {}): string {
    this.n++;
    const hash = (0x1a2b3c4 + this.n * 0x9e37).toString(16).padStart(7, "0");
    const prev = this.tips.get(thread);
    const parents = more.parents ?? (prev === undefined ? [] : [prev]);
    const time = new Date(Date.UTC(2026, 10, 17, 9, 0) + this.n * 97_000).toISOString();
    this.commits.push({
      hash,
      parents,
      thread,
      kind,
      summary,
      time,
      ...(more.toolCalls === undefined ? {} : { toolCalls: more.toolCalls }),
      ...(more.usd === undefined ? {} : { usd: more.usd }),
    });
    this.tips.set(thread, hash);
    return hash;
  }

  tip(thread: string): string {
    const t = this.tips.get(thread);
    if (t === undefined) throw new Error(`no commits on ${thread}`);
    return t;
  }
}

/** The names of the threads in the fixture, so a test or the mock can refer to them. */
export const THREADS = {
  main: "main",
  sqlite: "try-sqlite-cache",
  auth: "explore-auth",
  lint: "lint-cleanup",
  bench: "bench-run",
  old: "old-attempt",
} as const;

export function graphFixture(): GraphData {
  const g = new Builder();
  const m = THREADS.main;
  g.add(m, "header", "conversation starts");
  g.add(m, "agent_setup", "setup (start): claude-sonnet-5-5");
  g.add(m, "user", "user: Add retry with backoff to the HTTP client in src/http.ts");
  g.add(m, "assistant", "assistant: calls read_file", { toolCalls: 3, usd: 0.012 });
  g.add(m, "tool_result", "tool result: export async function request(...)");
  g.add(m, "tool_result", "tool result: 14 matches");
  g.add(m, "tool_result", "tool result: ok");
  g.add(m, "assistant", "assistant: calls edit", { toolCalls: 2, usd: 0.031 });
  g.add(m, "approval", "allowed call_edit1");
  g.add(m, "tool_result", "tool result: edited src/http.ts");
  g.add(m, "tool_result", "tool result: edited test/http.test.ts");
  g.add(m, "assistant", "assistant: calls run", { toolCalls: 1, usd: 0.018 });
  g.add(m, "tool_result", "tool result: 2 failing");
  g.add(m, "assistant", "assistant: calls edit", { toolCalls: 1, usd: 0.022 });
  g.add(m, "tool_result", "tool result: edited src/http.ts");
  g.add(m, "assistant", "assistant: calls run", { toolCalls: 1, usd: 0.017 });
  g.add(m, "tool_result", "tool result: all passing");
  const done = g.add(m, "assistant", "assistant: Retries are in. The client now retries idempotent requests up to 3 times…", {
    usd: 0.019,
  });

  // A fork tried from the end of the first task.
  const s = THREADS.sqlite;
  g.add(s, "branch_start", "fork starts", { parents: [done] });
  g.add(s, "user", "user: What if we cache responses in SQLite instead?");
  g.add(s, "assistant", "assistant: calls write", { toolCalls: 2, usd: 0.044 });
  g.add(s, "tool_result", "tool result: wrote src/cache.ts");
  g.add(s, "tool_result", "tool result: wrote test/cache.test.ts");
  g.add(s, "assistant", "assistant: The SQLite cache works but adds a native dependency…", { usd: 0.02 });

  // The main thread carries on, then takes the fork's conclusion in.
  g.add(m, "user", "user: Also add jitter to the delay");
  g.add(m, "assistant", "assistant: calls edit", { toolCalls: 2, usd: 0.026 });
  g.add(m, "tool_result", "tool result: edited src/http.ts");
  g.add(m, "tool_result", "tool result: edited test/http.test.ts");
  g.add(m, "assistant", "assistant: Jitter added, tests pass.", { usd: 0.012 });
  g.add(m, "fork_merge", "fork merged: SQLite cache rejected, kept the in-memory one", { parents: [g.tip(m), g.tip(s)] });

  // A subagent still working, and forks in the other states.
  const a = THREADS.auth;
  g.add(a, "branch_start", "subagent starts: map how authentication is wired", { parents: [g.tip(m)] });
  g.add(a, "assistant", "assistant: calls grep", { toolCalls: 4, usd: 0.009 });
  g.add(a, "tool_result", "tool result: 9 matches");
  g.add(a, "tool_result", "tool result: 3 matches");
  g.add(a, "tool_result", "tool result: ok");
  g.add(a, "tool_result", "tool result: ok");

  const l = THREADS.lint;
  g.add(l, "branch_start", "fork starts", { parents: [g.tip(m)] });
  g.add(l, "user", "user: Fix the lint warnings in cli/");
  g.add(l, "assistant", "assistant: calls edit", { toolCalls: 1, usd: 0.014 });

  const b = THREADS.bench;
  g.add(b, "branch_start", "fork starts", { parents: [done] });
  g.add(b, "user", "user: Benchmark the retry path");
  g.add(b, "assistant", "assistant: calls run", { toolCalls: 1, usd: 0.011 });
  g.add(b, "tool_result", "tool result: 1200 ops/s");

  const o = THREADS.old;
  g.add(o, "branch_start", "fork starts", { parents: [done] });
  g.add(o, "user", "user: Rewrite the client on top of undici");
  g.add(o, "assistant", "assistant: calls run", { toolCalls: 1, usd: 0.02 });
  g.add(o, "interrupted", "interrupted by error");

  const status = (t: string, st: ThreadStatus, more: Partial<GraphThread>, kind: GraphThread["kind"] = "fork"): GraphThread => ({
    name: t,
    kind,
    status: st,
    tip: g.tip(t),
    ...more,
  });
  const first = (t: string): string => g.commits.find((c) => c.thread === t)?.parents[0] ?? g.tip(t);
  return {
    trunk: m,
    threads: [
      status(m, "idle", { title: "Add retry with backoff", model: "Claude Sonnet 5.5" }, "main"),
      status(s, "idle", { title: "SQLite cache", model: "Claude Sonnet 5.5", from: first(s), merged: true }),
      status(a, "running", { title: "Map authentication", model: "Claude Haiku 5.5", from: first(a) }, "subagent"),
      status(l, "awaiting", { title: "Lint cleanup", model: "Claude Sonnet 5.5", from: first(l) }),
      status(b, "elsewhere", { title: "Benchmark retries", model: "Qwen3 Coder 30B (local)", from: first(b) }),
      status(o, "error", { title: "undici rewrite", model: "GPT-5.1", from: first(o) }),
    ],
    commits: g.commits,
  };
}
