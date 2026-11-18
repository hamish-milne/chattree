import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chatFixture } from "../../ui/fixtures/chat.ts";
import type { Block } from "../../ui/model/transcript.ts";
import { toolView } from "../../ui/model/tool-view.ts";

type Tool = Extract<Block, { type: "tool" }>;
const call = (name: string, args: unknown, over: Partial<Tool> = {}): Tool => ({
  type: "tool",
  id: "c",
  name,
  summary: name,
  args: JSON.stringify(args),
  status: "ok",
  ...over,
});
const result = (text: string) => ({ text, truncated: false, ms: 1 });
const fixture = (id: string): Tool => {
  const b = chatFixture().blocks.find((x) => x.type === "tool" && x.id === id);
  assert.ok(b?.type === "tool");
  return b;
};

describe("how tools are shown", () => {
  test("an edit result becomes hunks of removed, unchanged and added lines, with counts", () => {
    const v = toolView(fixture("c7"));
    assert.ok(v.kind === "edit");
    assert.equal(v.path, "src/http.ts");
    assert.deepEqual([v.added, v.removed], [1, 1]);
    assert.match(v.note ?? "", /^edited src\/http.ts/);
    const hunk = v.hunks[0];
    assert.match(hunk?.head ?? "", /^replaced lines 6-6/);
    assert.deepEqual(
      hunk?.rows.map((r) => [r.sign, r.n]),
      [
        ["-", 6],
        [" ", 5],
        ["+", 6],
        [" ", 7],
      ],
    );
    assert.equal(hunk?.rows[2]?.text, "      if (res.status < 500 || attempt >= max) return res;");
  });

  test("an edit that is still waiting shows what was asked for: the new lines and the range they replace", () => {
    const v = toolView(
      call("edit", { path: "a.ts", version: "1f08cd1f", start: 3, end: 4, content: "x\ny\nz" }, { status: "awaiting_approval" }),
    );
    assert.ok(v.kind === "edit");
    assert.deepEqual([v.added, v.removed], [3, 2]);
    assert.equal(v.hunks[0]?.head, "replace lines 3-4");
    assert.deepEqual(
      v.hunks[0]?.rows.map((r) => `${r.sign}${r.n}${r.text}`),
      ["+3x", "+4y", "+5z"],
    );
    const insert = toolView(call("edit", { path: "a.ts", version: "v", after: 0, content: "top" }));
    assert.ok(insert.kind === "edit" && insert.hunks[0]?.head === "insert after line 0" && insert.hunks[0].rows[0]?.n === 1);
    const del = toolView(call("edit", { path: "a.ts", version: "v", start: 2, end: 2 }));
    assert.ok(del.kind === "edit" && del.hunks[0]?.head === "delete lines 2-2" && del.removed === 1);
  });

  test("elided rows count towards the totals; a failed edit carries its message", () => {
    const text = [
      "edited a.ts (now 9 lines, version 00000000)",
      "change 1: replaced lines 1-30 with 30 lines",
      "- 1\told",
      "- ... 29 more lines",
      "+ 1\tnew",
      "+ ... 29 more lines",
    ].join("\n");
    const v = toolView(call("edit", { path: "a.ts", version: "v", start: 1, end: 30, content: "n" }, { result: result(text) }));
    assert.ok(v.kind === "edit");
    assert.deepEqual([v.added, v.removed], [30, 30]);
    assert.equal(v.hunks[0]?.rows.at(-1)?.sign, "…");
    const bad = toolView(call("edit", { path: "a.ts" }, { status: "error", result: result("failed: a.ts has changed since you read it") }));
    assert.ok(bad.kind === "edit" && /changed since/.test(bad.failed ?? ""));
  });

  test("read shows numbered lines with its range and version; a failure shows the reason", () => {
    const v = toolView(fixture("c1"));
    assert.ok(v.kind === "read");
    assert.equal(v.version, "3a9f0c21");
    assert.equal(v.range, "3 lines");
    assert.deepEqual(
      v.rows.map((r) => r.n),
      [1, 2, 3],
    );
    const partial = toolView(
      call(
        "read",
        { path: "a" },
        {
          result: result(
            "=== a (lines 5-6 of 90, version 0badf00d) ===\n5\tx\n6\ty\n... 84 more lines; read again with offset 6 for the rest",
          ),
        },
      ),
    );
    assert.ok(partial.kind === "read" && partial.range === "lines 5-6 of 90" && partial.rows.at(-1)?.sign === "…");
    const bad = toolView(call("read", { path: "a" }, { status: "error", result: result("failed: a: no such file") }));
    assert.ok(bad.kind === "read" && bad.failed !== undefined);
  });

  test("write lists every new line as added", () => {
    const v = toolView(call("write", { path: "n.txt", content: "a\nb\n" }, { result: result("wrote n.txt (2 lines)") }));
    assert.ok(v.kind === "write");
    assert.equal(v.added, 2);
    assert.equal(v.note, "wrote n.txt (2 lines)");
  });

  test("run and script split the exit code from the output", () => {
    const v = toolView(fixture("c6"));
    assert.ok(v.kind === "run");
    assert.equal(v.command, "npm test");
    assert.equal(v.exit, 1);
    assert.ok(v.failed && v.output.startsWith("not ok 2"));
    const s = toolView(call("script", { script: "ls && echo hi" }, { result: result("exit 0\nhi") }));
    assert.ok(s.kind === "run" && s.shell === "script" && s.exit === 0 && !s.failed && s.output === "hi");
    const pending = toolView(call("run", { command: "ls" }, { status: "running" }));
    assert.ok(pending.kind === "run" && pending.exit === undefined && pending.output === "");
  });

  test("any other tool, and arguments that are not JSON, get the generic shape", () => {
    const g = toolView(fixture("c2"));
    assert.ok(g.kind === "generic" && g.result?.truncated === true && !g.failed);
    const cut = toolView({ ...call("edit", {}), args: '{"path": "a.ts", "content": "unfinish' });
    assert.equal(cut.kind, "generic");
    assert.equal(toolView(call("edit", [1, 2])).kind, "generic");
  });
});
