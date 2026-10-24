import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FrameError,
  MemoryBlobStore,
  SchemaError,
  Tagged,
  appendEntry,
  emitEntry,
  encodeEntry,
  endsCleanly,
  lastCompleteSpan,
  parseEntry,
  parseFile,
  peekTag,
  resolve,
  scan,
  valueToObject,
  type Entry,
} from "../../src/index.ts";
import { FORMAT, createPipeline } from "../../harness/entries.ts";
import { ULID_RE, createUlid, ulidTime } from "../../harness/ulid.ts";
import { Rng, cp, randomEntry, randomString } from "../support/gen.ts";

const pipeline = createPipeline();
const nextId = createUlid(() => 1_700_000_000_000);
const HASH_A = "a1".repeat(32);
const HASH_B = "b2".repeat(32);
const ESC = cp(0x1b);

function samples(): Record<string, Record<string, unknown>> {
  const blob = { $tag: "blob", sha256: HASH_A, bytes: 48122, mime: "text/plain" };
  const reasoning = { $tag: "reasoning", provider: "anthropic", payload: { $tag: "blob", sha256: HASH_B, bytes: 2210 }, visible: "Let me look at the test." };
  return {
    header: { $tag: "header", format: FORMAT.format, major: FORMAT.major, minor: FORMAT.minor },
    user: { $tag: "user", id: nextId(), content: [{ $tag: "text", text: "Fix the failing test in parser.rs\n\nIt fails with:\n  expected `a`\n" }] },
    "user with attachment": {
      $tag: "user",
      id: nextId(),
      content: [{ $tag: "text", text: "What is in this image?" }, { $tag: "attachment", name: "shot.png", data: { $tag: "blob", sha256: HASH_A, bytes: 9001, mime: "image/png" } }],
    },
    assistant: {
      $tag: "assistant",
      id: nextId(),
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      blocks: [
        reasoning,
        { $tag: "text", text: "Running the tests." },
        { $tag: "tool_call", call_id: "toolu_01A", name: "run_command", args: { command: "cargo test parser", note: `tab\there "q" ${ESC}[31m`, nested: { list: [1, 2.5, null, true], empty: {} } } },
      ],
      stop_reason: "tool_use",
      usage: { input: 1840, output: 96, cache_read: 1712 },
      ext: { response_id: "resp_1", item_ids: ["a", "b"] },
    },
    "assistant with malformed tool arguments": {
      $tag: "assistant",
      id: nextId(),
      provider: "llama.cpp",
      model: "gpt-oss-20b",
      blocks: [{ $tag: "tool_call", call_id: "call_0", name: "edit", args: {}, args_raw: '{"path": "a.rs", "edit": ' }],
      stop_reason: "length",
    },
    tool_result: { $tag: "tool_result", id: nextId(), call_id: "toolu_01A", is_error: false, content: "test result: ok. 3 passed\n", truncated: true },
    "tool_result with a blob": { $tag: "tool_result", id: nextId(), call_id: "toolu_01B", is_error: true, content: blob },
    compaction: { $tag: "compaction", id: nextId(), replaces: { from: nextId(), to: nextId() }, summary: "The user asked for a parser fix.\nWe found an off-by-one in tokenize().", model: "claude-sonnet-5-5" },
    config_changed: { $tag: "config_changed", id: nextId(), old: HASH_A, new: HASH_B },
    "branch_start (subagent)": { $tag: "branch_start", id: nextId(), kind: "subagent", from: { branch: "main", commit: "9fceb02" }, context: "fresh", brief: "Find every caller of tokenize().", call_id: "toolu_09Z" },
    "branch_start (fork)": { $tag: "branch_start", id: nextId(), kind: "fork", from: { branch: "main", commit: "9fceb02" }, context: "inherit" },
    subagent_result: {
      $tag: "subagent_result",
      id: nextId(),
      call_id: "toolu_09Z",
      branch: "subagent/01K8",
      tip: "c0ffee1",
      summary: "tokenize() is called from 4 places.",
      files: { changed: ["notes/callers.md"], added: ["scratch/grep.txt"], discarded: ["scratch/plan.md"] },
    },
    interrupted: {
      $tag: "interrupted",
      id: nextId(),
      by: "user",
      partial: [{ $tag: "text", text: "I will start by" }, { $tag: "tool_call", call_id: "toolu_02", name: "run_command", args: {}, args_raw: '{"command": "ca' }],
    },
  };
}

describe("ulid", () => {
  test("format, ordering and time", () => {
    let t = 1_700_000_000_000;
    const same = createUlid(() => t);
    const ids = Array.from({ length: 2000 }, same);
    assert.ok(ids.every((i) => ULID_RE.test(i)));
    assert.deepEqual([...ids].sort(), ids, "ids within one millisecond still sort in creation order");
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ulidTime(ids[0] as string), 1_700_000_000_000);
    t += 1;
    assert.ok(same() > (ids.at(-1) as string));
  });
  test("the default clock produces valid ids", () => assert.match(createUlid()(), ULID_RE));
});

describe("every entry type round-trips through the pipeline and the file format", () => {
  for (const [name, input] of Object.entries(samples())) {
    test(name, async () => {
      const entry = await pipeline.encode(input);
      const bytes = encodeEntry(entry);
      const file = parseFile(bytes);
      assert.equal(file.truncated, false);
      assert.equal(file.entries.length, 1);
      assert.equal(peekTag(bytes, (scan(bytes).spans[0] as { start: number; end: number })), input["$tag"]);
      const r = await pipeline.decode(file.entries[0] as Entry);
      assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
      assert.deepEqual(r.value, input);
    });
  }
});

describe("on-disk layout", () => {
  test("user entry", async () => {
    const e = await pipeline.encode({
      $tag: "user",
      id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D",
      content: [{ $tag: "text", text: "Fix the failing test.\n\nIt fails with:\n  expected `a`" }],
    });
    assert.equal(
      emitEntry(e),
      "- !user\n" +
        '  id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D"\n' +
        "  content:\n" +
        "  - !text\n" +
        "    text: |-\n" +
        "      Fix the failing test.\n" +
        "      \n" +
        "      It fails with:\n" +
        "        expected `a`\n" +
        "\n",
    );
  });

  test("assistant entry with a tool call", async () => {
    const e = await pipeline.encode({
      $tag: "assistant",
      id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      blocks: [
        { $tag: "reasoning", provider: "anthropic", payload: { $tag: "blob", sha256: HASH_B, bytes: 2210 } },
        { $tag: "text", text: "Running the tests." },
        { $tag: "tool_call", call_id: "toolu_01A", name: "run_command", args: { command: "cargo test parser" } },
      ],
      stop_reason: "tool_use",
      usage: { input: 1840, output: 96 },
    });
    assert.equal(
      emitEntry(e),
      "- !assistant\n" +
        '  id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F"\n' +
        "  provider: anthropic\n" +
        "  model: claude-sonnet-5-5\n" +
        "  blocks:\n" +
        "  - !reasoning\n" +
        "    provider: anthropic\n" +
        `    payload: !blob {sha256: "${HASH_B}", bytes: 2210}\n` +
        "  - !text\n" +
        '    text: "Running the tests."\n' +
        "  - !tool_call\n" +
        "    call_id: toolu_01A\n" +
        "    name: run_command\n" +
        "    args:\n" +
        '      command: "cargo test parser"\n' +
        "  stop_reason: tool_use\n" +
        "  usage:\n" +
        "    input: 1840\n" +
        "    output: 96\n" +
        "\n",
    );
  });

  test("the entry type is visible to plain text tools", async () => {
    const e = await pipeline.encode(samples()["config_changed"] as Record<string, unknown>);
    assert.match(emitEntry(e), /^- !config_changed\n/);
  });
});

describe("writes are validated", () => {
  const ok = () => structuredClone(samples());
  type Case = [name: string, input: () => unknown, path: RegExp];
  const cases: Case[] = [
    ["a bad ULID", () => ({ ...ok()["user"], id: "not-a-ulid" }), /^id$/],
    ["a missing field", () => { const u = { ...ok()["user"] }; delete u["content"]; return u; }, /^content/],
    ["an unknown block type", () => ({ ...ok()["assistant"], blocks: [{ $tag: "video", url: "x" }] }), /^blocks\[0\]/],
    ["an enum value that does not exist", () => ({ ...ok()["branch_start (fork)"], kind: "clone" }), /^kind$/],
    ["an extra field on the entry", () => ({ ...ok()["tool_result"], exit_code: 1 }), /^exit_code$/],
    ["an extra field inside a block", () => ({ ...ok()["user"], content: [{ $tag: "text", text: "x", bold: true }] }), /^content\[0\]\.bold$/],
    ["tool arguments that are not an object", () => ({ ...ok()["assistant"], blocks: [{ $tag: "tool_call", call_id: "c", name: "n", args: "ls" }] }), /^blocks\[0\]/],
    ["a blob size that is negative", () => ({ ...ok()["tool_result"], content: { $tag: "blob", sha256: HASH_A, bytes: -1 } }), /^content/],
    ["a blob hash that is not hex", () => ({ ...ok()["tool_result"], content: { $tag: "blob", sha256: "xyz", bytes: 1 } }), /^content/],
    ["the wrong format name in the header", () => ({ ...ok()["header"], format: "other" }), /^format$/],
    ["a non-numeric token count", () => ({ ...ok()["assistant"], usage: { input: "many" } }), /^usage/],
    ["an attachment without a blob", () => ({ ...ok()["user"], content: [{ $tag: "attachment", data: "inline bytes" }] }), /^content\[0\]/],
    ["a missing nested field", () => ({ ...ok()["compaction"], replaces: { from: nextId() } }), /^replaces\.to$/],
  ];
  for (const [name, input, path] of cases) {
    test(`rejects ${name}`, async () => {
      await assert.rejects(pipeline.encode(input()), (e) => {
        assert.ok(e instanceof SchemaError, String(e));
        assert.ok(e.issues.some((i) => path.test(i.path)), `no issue matched ${path}: ${JSON.stringify(e.issues)}`);
        return true;
      });
    });
  }

  test("rejects an unknown entry type", async () => {
    await assert.rejects(pipeline.encode({ $tag: "telemetry", id: nextId() }), (e) => e instanceof SchemaError && e.issues[0]?.path === "$tag");
  });
});

describe("reading is forgiving and never throws", () => {
  test("an entry type this build does not know is reported and can be written back unchanged", async () => {
    const text = "- !telemetry\n  id: \"01K8ZQ3M0A5G2W7Y9C4T1R6B8D\"\n  fps: 59.9\n  samples: !series\n  - 1\n  - 2\n\n";
    const r = await pipeline.decode(parseEntry(text));
    assert.ok(!r.ok && r.reason === "unknown-tag" && r.tag === "telemetry");
    assert.equal(emitEntry(r.raw), text);
  });

  test("a stored entry that no longer validates is reported with its issue paths", async () => {
    const text = '- !assistant\n  id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F"\n  provider: p\n  model: m\n  blocks: []\n  stop_reason: 5\n\n';
    const r = await pipeline.decode(parseEntry(text));
    assert.ok(!r.ok && r.reason === "invalid");
    assert.ok(r.issues.some((i) => i.path === "stop_reason"));
    assert.equal(emitEntry(r.raw), text);
  });

  test("fields added by a newer minor version are ignored, not fatal", async () => {
    const text = '- !user\n  id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D"\n  locale: en-GB\n  content:\n  - !text\n    text: hi\n    emphasis: !style\n      bold: true\n\n';
    const r = await pipeline.decode(parseEntry(text));
    assert.ok(r.ok);
    assert.deepEqual(r.value, { $tag: "user", id: "01K8ZQ3M0A5G2W7Y9C4T1R6B8D", content: [{ $tag: "text", text: "hi" }] });
  });

  test("an unknown block type inside a known entry makes the entry invalid, not the file unreadable", async () => {
    const text = '- !assistant\n  id: "01K8ZQ3N7E4H0X2P5V9J3S1K6F"\n  provider: p\n  model: m\n  blocks:\n  - !hologram\n    depth: 3\n  stop_reason: end_turn\n\n';
    const r = await pipeline.decode(parseEntry(text));
    assert.ok(!r.ok && r.reason === "invalid");
  });
});

describe("transforms in the app pipeline", () => {
  const SECRET = "sk-ABCDEFGHIJKLMNOP1234";
  const patterns = [/sk-[A-Za-z0-9]{16,}/g, /Bearer [A-Za-z0-9._-]+/g];

  test("secrets are removed everywhere, before large values are stored", async () => {
    const store = new MemoryBlobStore();
    const p = createPipeline({ store, threshold: 500, redact: patterns });
    const big = "output line\n".repeat(400);
    const e1 = await p.encode({ $tag: "tool_result", id: nextId(), call_id: "c1", is_error: false, content: `token=${SECRET}\n${big}` });
    const e2 = await p.encode({
      $tag: "assistant",
      id: nextId(),
      provider: "p",
      model: "m",
      blocks: [{ $tag: "tool_call", call_id: "c2", name: "run", args: { command: `curl -H "Authorization: Bearer abc.def-123" https://x` } }],
      stop_reason: "tool_use",
    });
    for (const e of [e1, e2]) {
      const text = emitEntry(e);
      assert.ok(!text.includes(SECRET) && !text.includes("abc.def-123"), text);
    }
    assert.ok(emitEntry(e1).length < 400, "large output left the entry");
    assert.match(emitEntry(e2), /Authorization: \[REDACTED\]\\" https/);
    assert.equal(store.blobs.size, 1);
    for (const bytes of store.blobs.values()) {
      const stored = new TextDecoder().decode(bytes);
      assert.ok(!stored.includes(SECRET));
      assert.ok(stored.startsWith("token=[REDACTED]\n"));
    }
  });

  test("large values are blob references on disk and resolve back to the original", async () => {
    const store = new MemoryBlobStore();
    const p = createPipeline({ store, threshold: 500 });
    const big = "multi-line tool output\n".repeat(300);
    const e = await p.encode({ $tag: "tool_result", id: nextId(), call_id: "c1", is_error: false, content: big });
    const stored = parseEntry(emitEntry(e));
    const r = await p.decode(stored);
    assert.ok(r.ok);
    assert.equal((r.value as { content: { $tag: string; mime: string } }).content.$tag, "blob");
    assert.equal((r.value as { content: { mime: string } }).content.mime, "text/plain");
    const resolved = (await resolve(stored, store)) as Tagged & { value: Map<string, unknown> };
    assert.equal(resolved.value.get("content"), big);
  });

  test("without a store nothing is externalized, however large", async () => {
    const big = "x".repeat(50_000);
    const e = await pipeline.encode({ $tag: "tool_result", id: nextId(), call_id: "c", is_error: false, content: big });
    assert.ok(emitEntry(e).length > 50_000);
  });
});

describe("a whole file", () => {
  const conversation = () => {
    const s = samples();
    return [s["header"], s["user"], s["assistant"], s["tool_result"], s["config_changed"], s["compaction"], s["branch_start (subagent)"], s["subagent_result"], s["interrupted"]] as Record<string, unknown>[];
  };

  test("appended with appendEntry, framed, tagged and decoded", async () => {
    const inputs = conversation();
    let file: Uint8Array = new Uint8Array(0);
    for (const input of inputs) file = appendEntry(file, await pipeline.encode(input));
    const { spans, truncated } = scan(file);
    assert.equal(truncated, false);
    assert.deepEqual(spans.map((s) => peekTag(file, s)), inputs.map((i) => i["$tag"]));
    const { entries } = parseFile(file);
    for (const [i, entry] of entries.entries()) {
      const r = await pipeline.decode(entry);
      assert.ok(r.ok);
      assert.deepEqual(r.value, inputs[i]);
    }
    const last = lastCompleteSpan(file) as { start: number; end: number };
    assert.equal(peekTag(file, last), "interrupted");
  });

  test("a crash mid-write: detected, refused for appending, repaired, and the file carries on", async () => {
    const inputs = conversation();
    let file: Uint8Array = new Uint8Array(0);
    for (const input of inputs) file = appendEntry(file, await pipeline.encode(input));
    const damaged = file.subarray(0, file.length - 25);
    assert.equal(endsCleanly(damaged), false);
    const next = await pipeline.encode({ $tag: "user", id: nextId(), content: [{ $tag: "text", text: "continue" }] });
    assert.throws(() => appendEntry(damaged, next), FrameError);

    const { validLength, truncated } = scan(damaged);
    assert.equal(truncated, true);
    const repaired = appendEntry(damaged.subarray(0, validLength), next);
    const { entries } = parseFile(repaired);
    assert.equal(entries.length, inputs.length);
    for (const entry of entries) assert.ok((await pipeline.decode(entry)).ok);
    assert.equal(peekTag(repaired, lastCompleteSpan(repaired) as { start: number; end: number }), "user");
  });
});

describe("hostile text through the real schemas", () => {
  test("random strings, keys and nested values survive write, parse and read", async () => {
    const rng = new Rng(2025);
    for (let i = 0; i < 1500; i++) {
      const args = valueToObject(randomEntry(rng)) as Record<string, unknown>;
      const input = {
        $tag: "assistant",
        id: nextId(),
        provider: "p",
        model: "m",
        blocks: [{ $tag: "text", text: randomString(rng) }, { $tag: "tool_call", call_id: "c", name: "n", args }],
        stop_reason: "end_turn",
      };
      const entry = await pipeline.encode(input);
      const text = emitEntry(entry);
      const r = await pipeline.decode(parseEntry(text));
      assert.ok(r.ok, `entry ${i}: ${r.ok ? "" : JSON.stringify(r.issues)}\n${text}`);
      assert.deepEqual(r.value, input, `entry ${i}\n${text}`);
    }
  });

  test("a whole transcript of such entries frames and decodes", async () => {
    const rng = new Rng(7);
    let file: Uint8Array = new Uint8Array(0);
    const inputs: Record<string, unknown>[] = [];
    for (let i = 0; i < 200; i++) {
      const input = { $tag: "tool_result", id: nextId(), call_id: `c${i}`, is_error: rng.chance(0.2), content: randomString(rng) };
      inputs.push(input);
      file = appendEntry(file, await pipeline.encode(input));
    }
    const { entries } = parseFile(file);
    assert.equal(entries.length, inputs.length);
    for (const [i, e] of entries.entries()) assert.deepEqual((await pipeline.decode(e) as { value: unknown }).value, inputs[i]);
  });
});
