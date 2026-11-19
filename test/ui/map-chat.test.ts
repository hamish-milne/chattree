import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatEntry } from "../../harness/entries.ts";
import { mapEntries, type MapItem } from "../../ui/controller/map-chat.ts";
import { parseEvent } from "../../ui/model/protocol.ts";
import type { Block } from "../../ui/model/transcript.ts";

const U = (n: number): string => `01HZ${String(n).padStart(22, "0")}`;
const commitOf = (i: number): string => i.toString(16).padStart(40, "a");
const noBlobs = { blob: async (): Promise<undefined> => undefined };

const items = (entries: ChatEntry[]): MapItem[] => entries.map((entry, i) => ({ entry, ref: { commit: commitOf(i + 1) } }));

/** Mapped blocks must be ones the view accepts. */
function checked(blocks: Block[]): Block[] {
  const r = parseEvent({ type: "chat.append", blocks });
  assert.ok(r.ok, JSON.stringify(r));
  return blocks;
}

const text = (t: string) => ({ $tag: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ $tag: "tool_call" as const, call_id: id, name, args });
const usage = (input: number, output: number, cache = 0) => ({ input_tokens: input, output_tokens: output, cache_read_tokens: cache });

test("a turn becomes a user block, assistant text, one tool block per call with its result, and one turn_end", async () => {
  const entries: ChatEntry[] = [
    { $tag: "header", format: "chatlog", major: 2, minor: 7 },
    {
      $tag: "user",
      id: U(1),
      content: [
        text("fix the retry"),
        { $tag: "attachment", name: "n.md", data: { $tag: "blob", sha256: "a".repeat(64), bytes: 12, mime: "text/markdown" } },
      ],
    },
    {
      $tag: "assistant",
      id: U(2),
      provider: "p",
      model: "m",
      blocks: [
        { $tag: "reasoning", provider: "p", visible: "thinking it over" },
        text("Looking."),
        call("c1", "read", { path: "src/a.ts" }),
      ],
      stop_reason: "tool_use",
      usage: usage(100, 10, 40),
    },
    { $tag: "tool_result", id: U(3), call_id: "c1", is_error: false, content: "file text" },
    { $tag: "assistant", id: U(4), provider: "p", model: "m", blocks: [text("Done.")], stop_reason: "end_turn", usage: usage(200, 20) },
  ];
  const blocks = checked(
    await mapEntries(items(entries), noBlobs, {
      spends: new Map([
        [2, { spend: { usd: 0.01, requests: 1, unpriced: 0 }, model: "m" }],
        [4, { spend: { usd: 0.02, requests: 1, unpriced: 0 }, model: "m" }],
      ]),
    }),
  );
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["user", "reasoning", "assistant", "tool", "assistant", "turn_end"],
  );
  const [user, , , tool, , end] = blocks;
  assert.equal(user?.type === "user" && user.attachments[0]?.kind, "text");
  assert.equal(tool?.type === "tool" && tool.summary, "read src/a.ts");
  assert.equal(tool?.type === "tool" && tool.status, "ok");
  assert.equal(tool?.type === "tool" && tool.result?.text, "file text");
  assert.equal(tool?.commit, commitOf(3)); // the call is anchored on the assistant entry that made it
  assert.ok(end?.type === "turn_end");
  assert.deepEqual(end.usage, { input: 300, output: 30, cached: 40 });
  assert.equal(end.usd, 0.03);
  assert.equal(end.stop, "end_turn");
});

test("a call with no result shows what the thread is doing about it; a declined or cut-off call did not run", async () => {
  const entries: ChatEntry[] = [
    { $tag: "user", id: U(1), content: [text("go")] },
    {
      $tag: "assistant",
      id: U(2),
      provider: "p",
      model: "m",
      blocks: [
        call("w", "write", { path: "a" }),
        call("r", "run", { command: "ls" }),
        call("x", "run", { command: "rm" }),
        call("q", "read", { path: "b" }),
      ],
      stop_reason: "tool_use",
    },
    { $tag: "approval", id: U(3), call_id: "x", allow: false, reason: "no" },
  ];
  const blocks = checked(await mapEntries(items(entries), noBlobs, { awaiting: new Set(["w"]), running: new Set(["r"]) }));
  const status = Object.fromEntries(blocks.flatMap((b) => (b.type === "tool" ? [[b.id, b.status]] : [])));
  assert.deepEqual(status, { w: "awaiting_approval", r: "running", x: "did_not_run", q: "pending" });
  const x = blocks.find((b) => b.type === "tool" && b.id === "x");
  assert.equal(x?.type === "tool" && x.result?.text, "no");

  const cut = checked(
    await mapEntries(
      items([entries[0]!, { $tag: "interrupted", id: U(4), by: "user", partial: [text("par"), call("z", "run", { command: "x" })] }]),
      noBlobs,
    ),
  );
  assert.deepEqual(
    cut.map((b) => (b.type === "tool" ? b.status : b.type)),
    ["user", "assistant", "did_not_run", "notice", "turn_end"],
  );
});

test("large text is read from its blob, and cut when huge; a missing blob is said so", async () => {
  const sha = "b".repeat(64);
  const blob = { $tag: "blob" as const, sha256: sha, bytes: 50, mime: "text/plain" };
  const entries: ChatEntry[] = [
    { $tag: "user", id: U(1), content: [text("hi")] },
    {
      $tag: "assistant",
      id: U(2),
      provider: "p",
      model: "m",
      blocks: [{ $tag: "text", text: blob }, call("c", "write", { path: "f", content: blob })],
      stop_reason: "tool_use",
    },
    { $tag: "tool_result", id: U(3), call_id: "c", is_error: true, content: { ...blob, sha256: "c".repeat(64) }, truncated: true },
  ];
  const read = async (s: string): Promise<Uint8Array | undefined> => (s === sha ? new TextEncoder().encode("x".repeat(50)) : undefined);
  const blocks = checked(await mapEntries(items(entries), { blob: read, maxText: 30 }));
  const a = blocks.find((b) => b.type === "assistant");
  assert.equal(a?.type === "assistant" && a.markdown, "x".repeat(30));
  const t = blocks.find((b) => b.type === "tool");
  assert.ok(t?.type === "tool");
  assert.match(t.args, /xxxxxxxx/);
  assert.equal(t.status, "error");
  assert.deepEqual(t.result, { text: "(content not available)", truncated: true });
});

test("everything that is not a message becomes a notice with the commit it came from", async () => {
  const merge = { policy: "trunk" as const, base: "b", conflicts: [] };
  const entries: ChatEntry[] = [
    { $tag: "agent_setup", id: U(1), reason: "user", model: { provider: "p", id: "m" } },
    { $tag: "agent_setup", id: U(2), reason: "fork", model: { provider: "p", id: "m" } },
    { $tag: "injection", id: U(3), key: "budget", text: "80% used" },
    { $tag: "compaction", id: U(4), replaces: { from: U(1), to: U(3) }, summary: "sum", by: "auto" },
    { $tag: "trim", id: U(5), upto: U(3), rule: { reasoning: true }, by: "user" },
    { $tag: "branch_start", id: U(6), kind: "fork", from: { branch: "main", commit: "c" }, context: "inherit" },
    { $tag: "job_event", id: U(7), job: "j1", call_id: "c", status: "failed", summary: "exit 1" },
    {
      $tag: "fork_merge",
      id: U(8),
      branch: "fork/x",
      tip: "t",
      summary: "s",
      files: { changed: ["a"], added: ["b"], discarded: ["c"] },
      merge,
    },
  ];
  const blocks = checked(await mapEntries(items(entries), noBlobs));
  assert.deepEqual(
    blocks.map((b) => (b.type === "notice" ? `${b.kind}:${b.level}` : b.type)),
    ["setup:info", "injection:info", "compaction:info", "trim:info", "branch:info", "job:error", "merge:warning"],
  );
  assert.ok(blocks.every((b) => b.commit !== undefined));
});

test("a subagent's result lands on the call that started it, with the thread to open", async () => {
  const entries: ChatEntry[] = [
    { $tag: "user", id: U(1), content: [text("go")] },
    {
      $tag: "assistant",
      id: U(2),
      provider: "p",
      model: "m",
      blocks: [call("s", "subagent", { brief: "look into it" })],
      stop_reason: "tool_use",
    },
    {
      $tag: "subagent_result",
      id: U(3),
      call_id: "s",
      branch: "sub/1",
      tip: "t",
      summary: "found it",
      files: { changed: [], added: ["n"], discarded: [] },
    },
  ];
  const blocks = checked(await mapEntries(items(entries), noBlobs));
  const t = blocks.find((b) => b.type === "tool");
  assert.ok(t?.type === "tool");
  assert.equal(t.thread, "sub/1");
  assert.equal(t.status, "ok");
  assert.match(t.result?.text ?? "", /found it\n\n1 file merged/);
});

test("an unpriced response is flagged, not shown as free", async () => {
  const entries: ChatEntry[] = [
    { $tag: "user", id: U(1), content: [text("go")] },
    { $tag: "assistant", id: U(2), provider: "p", model: "m", blocks: [text("ok")], stop_reason: "end_turn", usage: usage(1, 1) },
  ];
  const blocks = checked(
    await mapEntries(items(entries), noBlobs, { spends: new Map([[1, { spend: { usd: 0, requests: 1, unpriced: 1 }, model: "m" }]]) }),
  );
  const end = blocks.at(-1);
  assert.ok(end?.type === "turn_end");
  assert.equal(end.unpriced, true);
  assert.equal(end.usd, undefined);
});

test("a turn still going is not closed with a turn_end", async () => {
  const entries: ChatEntry[] = [
    { $tag: "user", id: U(1), content: [text("go")] },
    {
      $tag: "assistant",
      id: U(2),
      provider: "p",
      model: "m",
      blocks: [call("c", "run", { command: "ls" })],
      stop_reason: "tool_use",
      usage: usage(1, 1),
    },
  ];
  const open = checked(await mapEntries(items(entries), noBlobs, { inFlight: true }));
  assert.deepEqual(
    open.map((b) => b.type),
    ["user", "tool"],
  );
  const done = checked(await mapEntries(items(entries), noBlobs));
  assert.equal(done.at(-1)?.type, "turn_end");
});
