/**
 * A chat session for the mock: an ordinary agent turn with reasoning, parallel tool calls, an approval, a failing
 * test run and its fix, and a notice or two, followed by a second message that is still streaming. Commits are taken
 * from the graph fixture's main thread, so a click in the graph and the chat agree.
 */
import type { ChatState } from "../model/chat.ts";
import type { Block } from "../model/transcript.ts";
import { graphFixture, THREADS } from "./graph.ts";

/** The rows of an edit result, as the edit tool writes them: removed lines, the line before, added lines, the line after. */
const ctx = (n: number, t: string): string => `  ${n}\t${t}`;
const add = (n: number, t: string): string => `+ ${n}\t${t}`;
const del = (n: number, t: string): string => `- ${n}\t${t}`;
const numbered = (first: number, lines: string[]): string => lines.map((t, i) => `${first + i}\t${t}`).join("\n");

const RETRY = [
  "  const max = init?.retries ?? 3;",
  "  for (let attempt = 0; ; attempt++) {",
  "    try {",
  "      const res = await fetch(url, init);",
  "      if (res.ok || attempt >= max) return res;",
  "    } catch (err) {",
  "      if (attempt >= max) throw err;",
  "    }",
  "    await sleep(Math.min(200 * 2 ** attempt, 5000));",
  "  }",
];
const SIGNATURE = "export async function request(url: string, init?: RequestInit): Promise<Response> {";
const TEST = ["import { test } from './harness.ts';", "import { request } from '../src/http.ts';"];
const NEW_TESTS = [
  "test('retries a 503', async () => {",
  "  // fails the first two calls, then answers",
  "});",
  "test('does not retry POST', async () => {});",
];

export function chatFixture(): ChatState {
  const graph = graphFixture();
  const main = graph.commits.filter((c) => c.thread === THREADS.main);
  const at = (i: number): string => main[Math.min(i, main.length - 1)]?.hash ?? "0000000";
  const tip = graph.threads.find((t) => t.name === THREADS.main)?.tip ?? "0000000";
  const blocks: Block[] = [
    {
      type: "notice",
      id: "n1",
      commit: at(1),
      kind: "setup",
      level: "info",
      title: "Model set to Claude Sonnet 5.5",
      detail: "Prices pinned: $3.00 in / $15.00 out per million tokens.",
    },
    {
      type: "user",
      id: "u1",
      commit: at(2),
      text: "Add retry with backoff to the HTTP client in src/http.ts. Only retry idempotent requests.",
      attachments: [],
    },
    {
      type: "reasoning",
      id: "r1",
      commit: at(3),
      text: "I need to see how `request` is structured before changing it. Reading the file, finding its callers, and checking the existing tests in parallel.",
    },
    {
      type: "assistant",
      id: "a1",
      commit: at(3),
      markdown: "I'll start by reading the client and its callers.",
      model: "claude-sonnet-5-5",
    },
    {
      type: "tool",
      id: "c1",
      commit: at(4),
      name: "read",
      summary: "read src/http.ts",
      args: JSON.stringify({ path: "src/http.ts" }, null, 2),
      status: "ok",
      result: {
        text: `=== src/http.ts (3 lines, version 3a9f0c21) ===\n${numbered(1, [SIGNATURE, "  return fetch(url, init);", "}"])}`,
        truncated: false,
        ms: 6,
      },
    },
    {
      type: "tool",
      id: "c2",
      commit: at(5),
      name: "grep",
      summary: "grep request( in src/",
      args: JSON.stringify({ pattern: "request\\(", path: "src" }, null, 2),
      status: "ok",
      result: { text: "src/http.ts:1\nsrc/api/client.ts:22\nsrc/api/client.ts:48\n… 11 more", truncated: true, ms: 41 },
    },
    {
      type: "tool",
      id: "c3",
      commit: at(6),
      name: "read",
      summary: "read test/http.test.ts",
      args: JSON.stringify({ path: "test/http.test.ts" }, null, 2),
      status: "ok",
      result: { text: `=== test/http.test.ts (2 lines, version 91c2e7aa) ===\n${numbered(1, TEST)}`, truncated: false, ms: 5 },
    },
    {
      type: "assistant",
      id: "a2",
      commit: at(7),
      markdown:
        "`request` is a thin wrapper over `fetch`, so the retry loop belongs there. I'll add a `retries` option (default 3) with exponential backoff, and skip the loop for non-idempotent methods.",
      model: "claude-sonnet-5-5",
    },
    {
      type: "tool",
      id: "c4",
      commit: at(9),
      name: "edit",
      summary: "edit src/http.ts",
      args: JSON.stringify({ path: "src/http.ts", version: "3a9f0c21", start: 2, end: 2, content: RETRY.join("\n") }, null, 2),
      status: "ok",
      result: {
        text: [
          "edited src/http.ts (now 12 lines, version 7be41d90)",
          "change 1: replaced lines 2-2 with 10 lines; now lines 2-11; the lines after it moved down by 9",
          del(2, "  return fetch(url, init);"),
          ctx(1, SIGNATURE),
          ...RETRY.map((t, i) => add(2 + i, t)),
          ctx(12, "}"),
        ].join("\n"),
        truncated: false,
        ms: 12,
      },
    },
    {
      type: "tool",
      id: "c5",
      commit: at(10),
      name: "edit",
      summary: "edit test/http.test.ts",
      args: JSON.stringify({ path: "test/http.test.ts", version: "91c2e7aa", after: 2, content: NEW_TESTS.join("\n") }, null, 2),
      status: "ok",
      result: {
        text: [
          "edited test/http.test.ts (now 6 lines, version c04a77b3)",
          "change 1: inserted 4 lines after line 2; now lines 3-6",
          ctx(2, TEST[1] ?? ""),
          ...NEW_TESTS.map((t, i) => add(3 + i, t)),
        ].join("\n"),
        truncated: false,
        ms: 9,
      },
    },
    {
      type: "tool",
      id: "c6",
      commit: at(12),
      name: "run",
      summary: "run npm test",
      args: JSON.stringify({ command: "npm test" }, null, 2),
      status: "error",
      result: {
        text: "exit 1\nnot ok 2 - retries a 503\n  expected 3 calls, got 1\nnot ok 3 - does not retry POST\n# fail 2",
        truncated: false,
        ms: 2140,
      },
    },
    {
      type: "assistant",
      id: "a3",
      commit: at(13),
      markdown:
        "Two failures. The loop returns on the first non-throwing response, but a 503 does not throw. It needs to check `response.status`.",
      model: "claude-sonnet-5-5",
    },
    {
      type: "tool",
      id: "c7",
      commit: at(14),
      name: "edit",
      summary: "edit src/http.ts",
      args: JSON.stringify(
        {
          path: "src/http.ts",
          version: "7be41d90",
          start: 6,
          end: 6,
          content: "      if (res.status < 500 || attempt >= max) return res;",
        },
        null,
        2,
      ),
      status: "ok",
      result: {
        text: [
          "edited src/http.ts (now 12 lines, version e1d90a42)",
          "change 1: replaced lines 6-6 with 1 line; now lines 6-6",
          del(6, "      if (res.ok || attempt >= max) return res;"),
          ctx(5, "      const res = await fetch(url, init);"),
          add(6, "      if (res.status < 500 || attempt >= max) return res;"),
          ctx(7, "    } catch (err) {"),
        ].join("\n"),
        truncated: false,
        ms: 8,
      },
    },
    {
      type: "tool",
      id: "c8",
      commit: at(16),
      name: "run",
      summary: "run npm test",
      args: JSON.stringify({ command: "npm test" }, null, 2),
      status: "ok",
      result: { text: "exit 0\n# pass 12\n# fail 0", truncated: false, ms: 1980 },
    },
    {
      type: "assistant",
      id: "a4",
      commit: at(17),
      markdown:
        "Retries are in.\n\n- Idempotent requests (`GET`, `HEAD`, `PUT`, `DELETE`) retry up to 3 times on network errors and `5xx`.\n- The delay doubles from 200 ms, capped at 5 s.\n- `POST` is never retried.\n\nAll 12 tests pass.",
      model: "claude-sonnet-5-5",
    },
    { type: "turn_end", id: "t1", commit: at(17), usage: { input: 18420, output: 1130, cached: 12800 }, usd: 0.119, stop: "end_turn" },
    {
      type: "user",
      id: "u2",
      text: "Also add jitter to the delay, and make the cap configurable.",
      attachments: [{ name: "backoff-notes.md", mime: "text/markdown", kind: "text", bytes: 2310 }],
      queued: false,
    },
    {
      type: "reasoning",
      id: "r2",
      text: "Jitter should be full jitter: a random value between 0 and the capped delay. The cap becomes an option",
      streaming: true,
    },
  ];
  return {
    thread: { name: THREADS.main, kind: "main", title: "Add retry with backoff", tip },
    blocks,
    status: {
      state: "running",
      model: "Claude Sonnet 5.5",
      provider: "anthropic",
      context: { used: 31_800, limit: 200_000 },
      thinking: "brief",
      usd: 0.254,
    },
    composer: { draft: "", attachments: [] },
    model: {
      current: "anthropic/claude-sonnet-5-5",
      options: [
        { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic" },
        { id: "anthropic/claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic" },
        { id: "openai/gpt-5.1", label: "GPT-5.1", provider: "openai" },
        { id: "local/qwen3-coder-30b", label: "Qwen3 Coder 30B (local)", provider: "local" },
      ],
    },
    settings: {
      id: "model-settings",
      title: "Model settings",
      schema: {
        type: "object",
        properties: {
          temperature: { type: "number", minimum: 0, maximum: 2, description: "Randomness of the output." },
          max_tokens: { type: "integer", minimum: 1, description: "The most the model may write in one reply." },
          thinking: { enum: ["off", "brief", "on"], description: "How much of the model's reasoning to ask for." },
          cache: { type: "boolean", description: "Reuse the prompt cache between requests." },
        },
      },
      value: { temperature: 1, max_tokens: 8192, thinking: "brief", cache: true },
      issues: [],
      dirty: false,
      saveLabel: "Apply to thread",
    },
  };
}
