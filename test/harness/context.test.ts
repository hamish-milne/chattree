import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contextEntries } from "../../harness/context.ts";
import type { ChatEntry } from "../../harness/entries.ts";

let n = 0;
const id = (): string => `01K8ZQ3M0A5G2W7Y9C4T1R6B${String(n++).padStart(2, "0")}`.slice(0, 26);
const u = (text: string): ChatEntry => ({ $tag: "user", id: id(), content: [{ $tag: "text", text }] });
const header: ChatEntry = { $tag: "header", format: "chatlog", major: 1, minor: 2 };
const compact = (from: ChatEntry, to: ChatEntry, summary: string): ChatEntry => ({
  $tag: "compaction",
  id: id(),
  replaces: { from: (from as { id: string }).id, to: (to as { id: string }).id },
  summary,
});
const label = (e: ChatEntry): string => (e.$tag === "user" ? (e.content[0] as { text: string }).text : e.$tag === "compaction" ? `[${e.summary}]` : e.$tag);

describe("contextEntries", () => {
  test("passes a plain transcript through", () => {
    const e = [header, u("a"), u("b")];
    assert.deepEqual(contextEntries(e), e);
  });

  test("a compaction replaces its range with the summary, where the range began", () => {
    const [a, b, c, d] = [u("a"), u("b"), u("c"), u("d")];
    const e = [header, a, b, c, d, compact(b, c, "bc")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "a", "[bc]", "d"]);
  });

  test("a later compaction can name an earlier one, and then reaches back to where that summary stands", () => {
    const [a, b, c, d, f] = [u("a"), u("b"), u("c"), u("d"), u("f")];
    const first = compact(a, b, "ab");
    const e = [header, a, b, c, first, d, f, compact(first, d, "ab+c+d")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "[ab+c+d]", "f"]);
  });

  test("a compaction can end at an earlier summary, covering everything that summary stood for", () => {
    const [a, b, c, d] = [u("a"), u("b"), u("c"), u("d")];
    const first = compact(b, c, "bc");
    const e = [header, a, b, c, first, d, compact(a, first, "abc")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "[abc]", "d"]);
  });

  test("compacting a summary together with the entries around it", () => {
    const [a, b, c, d] = [u("a"), u("b"), u("c"), u("d")];
    const first = compact(a, b, "ab");
    const second = compact(a, d, "everything");
    const e = [header, a, b, c, first, d, second];
    assert.deepEqual(contextEntries(e).map(label), ["header", "[everything]"]);
    assert.ok(!contextEntries(e).includes(first), "the earlier summary is gone");
  });

  test("two disjoint compactions both apply", () => {
    const [a, b, c, d, f] = [u("a"), u("b"), u("c"), u("d"), u("f")];
    const e = [header, a, b, c, d, f, compact(a, b, "ab"), compact(d, f, "df")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "[ab]", "c", "[df]"]);
  });

  test("entries after the compaction are untouched", () => {
    const [a, b] = [u("a"), u("b")];
    const e = [header, a, b, compact(a, a, "a"), u("later")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "[a]", "b", "later"]);
  });

  test("a fresh-context marker hides everything before it", () => {
    const marker: ChatEntry = { $tag: "branch_start", id: id(), kind: "subagent", from: { branch: "main", commit: "abc" }, context: "fresh", brief: "do the thing", call_id: "c" };
    const e = [header, u("parent talk"), marker, u("child work")];
    assert.deepEqual(contextEntries(e).map(label), ["branch_start", "child work"]);
  });

  test("an inherit marker (a fork) hides nothing", () => {
    const marker: ChatEntry = { $tag: "branch_start", id: id(), kind: "fork", from: { branch: "main", commit: "abc" }, context: "inherit" };
    const e = [header, u("shared"), marker, u("new")];
    assert.deepEqual(contextEntries(e).map(label), ["header", "shared", "branch_start", "new"]);
  });

  test("compactions in a subagent cannot reach into the parent's part of the transcript", () => {
    const old = u("old");
    const marker: ChatEntry = { $tag: "branch_start", id: id(), kind: "subagent", from: { branch: "main", commit: "abc" }, context: "fresh", brief: "b", call_id: "c" };
    const [x, y] = [u("x"), u("y")];
    const e = [header, old, marker, x, y, compact(x, y, "xy"), compact(old, x, "reaches before the marker")];
    // the second compaction reaches into the parent's entries, so it is ignored; the first applies
    assert.deepEqual(contextEntries(e).map(label), ["branch_start", "[xy]"]);
  });

  test("a compaction that cannot be applied is ignored", () => {
    const [a, b] = [u("a"), u("b")];
    const missing: ChatEntry = { $tag: "compaction", id: id(), replaces: { from: "01K8ZQ3M0A5G2W7Y9C4T1R6B00", to: "01K8ZQ3M0A5G2W7Y9C4T1R6BZZ" }, summary: "?" };
    const backwards = compact(b, a, "backwards");
    const early = [header, a, compact(a, b, "reaches ahead"), b];
    assert.deepEqual(contextEntries([header, a, b, missing]).map(label), ["header", "a", "b"]);
    assert.deepEqual(contextEntries([header, a, b, backwards]).map(label), ["header", "a", "b"]);
    assert.deepEqual(contextEntries(early).map(label), ["header", "a", "b"]);
  });

  test("the other entry kinds pass through", () => {
    const sub: ChatEntry = { $tag: "subagent_result", id: id(), call_id: "c", branch: "sub/x", tip: "t", summary: "s", files: { changed: [], added: [], discarded: [] } };
    const fm: ChatEntry = { $tag: "fork_merge", id: id(), branch: "f", tip: "t", summary: "s", files: { changed: [], added: [], discarded: [] }, merge: { policy: "trunk", base: "b", conflicts: [] } };
    const int: ChatEntry = { $tag: "interrupted", id: id(), by: "user", partial: [] };
    assert.deepEqual(contextEntries([header, sub, fm, int]).map((e) => e.$tag), ["header", "subagent_result", "fork_merge", "interrupted"]);
  });
});
