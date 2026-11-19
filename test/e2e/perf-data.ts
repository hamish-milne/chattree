/** A long conversation for the performance test: thousands of commits on a trunk and its forks, and a transcript of as many blocks. Deterministic. */
import { chatFixture } from "../../ui/fixtures/chat.ts";
import type { ChatState } from "../../ui/model/chat.ts";
import type { GraphCommit, GraphData, GraphKind, GraphThread } from "../../ui/model/graph.ts";
import type { Block } from "../../ui/model/transcript.ts";

const hashOf = (n: number): string => (0x1000000 + n * 7919).toString(16).padStart(7, "0");
const timeOf = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 31_000).toISOString();

/** What a long agent session is mostly made of: a message, a reply that calls tools, and the results. */
const PATTERN: { kind: GraphKind; toolCalls?: number; summary: string }[] = [
  { kind: "user", summary: "user: Please look at the failing test" },
  { kind: "assistant", toolCalls: 2, summary: "assistant: reading the test and its subject (2 calls)" },
  { kind: "tool_result", summary: "tool result: read test/http.test.ts" },
  { kind: "tool_result", summary: "tool result: read src/http.ts" },
  { kind: "assistant", summary: "assistant: the loop returns on the first response" },
];

export interface Long {
  graph: GraphData;
  chat: ChatState;
  /** Make the commit and block a new message adds. */
  next(text: string): { graph: GraphData; blocks: Block[] };
}

/** `commits` on the trunk and `forks` forks of 30 commits each branching off along it; `blocks` blocks in the transcript. */
export function longConversation(commits: number, blocks: number, forks = 12): Long {
  const all: GraphCommit[] = [];
  const threads: GraphThread[] = [];
  let n = 0;
  const add = (thread: string, parent: string | undefined, i: number, summary?: string): string => {
    const p = PATTERN[i % PATTERN.length];
    const c: GraphCommit = {
      hash: hashOf(++n),
      parents: parent === undefined ? [] : [parent],
      thread,
      kind: p?.kind ?? "other",
      summary: summary ?? p?.summary ?? "",
      time: timeOf(n),
      ...(p?.toolCalls === undefined ? {} : { toolCalls: p.toolCalls }),
    };
    all.push(c);
    return c.hash;
  };
  let tip: string | undefined;
  const trunk: string[] = [];
  for (let i = 0; i < commits; i++) {
    tip = add("main", tip, i);
    trunk.push(tip);
    // A fork leaves the trunk at evenly spaced points, with its own run of commits.
    for (let f = 0; f < forks; f++) {
      if (i !== Math.floor(((f + 1) * commits) / (forks + 1))) continue;
      let ft: string | undefined = tip;
      for (let k = 0; k < 30; k++) ft = add(`fork/${f}`, ft, k);
      threads.push({ name: `fork/${f}`, kind: "fork", status: "idle", tip: ft ?? tip, from: tip, title: `Fork ${f}` });
    }
  }
  threads.unshift({ name: "main", kind: "main", status: "idle", tip: tip ?? "", title: "A very long conversation", checkedOut: true });
  const graph: GraphData = { trunk: "main", threads, commits: all };

  const base = chatFixture();
  const templates = base.blocks.filter((b) => !("streaming" in b && b.streaming));
  const made: Block[] = [];
  for (let i = 0; i < blocks; i++) {
    const t = templates[i % templates.length];
    if (t === undefined) continue;
    // Every block has text of its own, as a real transcript does (so nothing is cached by its content).
    const own = { id: `${t.id}~${i}`, commit: trunk[i % trunk.length] ?? "" };
    if (t.type === "assistant") made.push({ ...t, ...own, markdown: `${t.markdown} (message ${i})` });
    else if (t.type === "user") made.push({ ...t, ...own, text: `${t.text} (message ${i})` });
    else made.push({ ...t, ...own });
  }
  const chat: ChatState = {
    ...base,
    thread: { ...base.thread, name: "main", tip: tip ?? "", title: "A very long conversation" },
    blocks: made,
  };

  let count = 0;
  return {
    graph,
    chat,
    next(text) {
      count++;
      const parent = graph.threads[0]?.tip;
      const c: GraphCommit = {
        hash: hashOf(++n),
        parents: parent === undefined ? [] : [parent],
        thread: "main",
        kind: "user",
        summary: `user: ${text}`,
        time: timeOf(n),
      };
      graph.commits.push(c);
      const main = graph.threads[0];
      if (main !== undefined) graph.threads[0] = { ...main, tip: c.hash };
      return {
        graph: { ...graph, threads: [...graph.threads], commits: [...graph.commits] },
        blocks: [{ type: "user", id: `new-${count}`, commit: c.hash, text, attachments: [] }],
      };
    },
  };
}
