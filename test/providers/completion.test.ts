import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  CompletionError,
  completeInfill,
  completeRaw,
  completionFormat,
  completionFormats,
  deepseekCoder,
  fimFormat,
  mellum,
  qwenCoder,
  seedCoder,
  shown,
  starcoder2,
  sweepNextEdit,
  sweepNextEditSmall,
  zeta21,
  trimSuffixOverlap,
} from "../../providers/completion/index.ts";

const req = { path: "src/a.ts", prefix: "function add(a, b) {\n  return ", suffix: ";\n}\n" };

describe("fill-in-the-middle formats", () => {
  test("each writes its own sentinels in its own order", () => {
    assert.equal(qwenCoder.render(req).prompt, "<|fim_prefix|>function add(a, b) {\n  return <|fim_suffix|>;\n}\n<|fim_middle|>");
    assert.equal(starcoder2.render(req).prompt, "<fim_prefix>function add(a, b) {\n  return <fim_suffix>;\n}\n<fim_middle>");
    assert.equal(seedCoder.render(req).prompt, "<[fim-suffix]>;\n}\n<[fim-prefix]>function add(a, b) {\n  return <[fim-middle]>");
    assert.equal(
      mellum.render(req).prompt,
      "<filename>src/a.ts\n<fim_suffix>;\n}\n<fim_prefix>function add(a, b) {\n  return <fim_middle>",
    );
    assert.equal(deepseekCoder.render(req).prompt, "<｜fim▁begin｜>function add(a, b) {\n  return <｜fim▁hole｜>;\n}\n<｜fim▁end｜>");
  });

  test("other files go where the format puts them, and are left out where it has no place", () => {
    const files = [{ path: "src/b.ts", text: "export const one = 1;" }];
    const withFiles = { ...req, repo: "demo", files };
    assert.equal(
      qwenCoder.render(withFiles).prompt,
      "<|repo_name|>demo\n<|file_sep|>src/b.ts\nexport const one = 1;\n<|file_sep|>src/a.ts\n<|fim_prefix|>function add(a, b) {\n  return <|fim_suffix|>;\n}\n<|fim_middle|>",
    );
    assert.equal(
      mellum.render(withFiles).prompt,
      "<filename>src/b.ts\nexport const one = 1;\n<filename>src/a.ts\n<fim_suffix>;\n}\n<fim_prefix>function add(a, b) {\n  return <fim_middle>",
    );
    assert.equal(seedCoder.render(withFiles).prompt, seedCoder.render(req).prompt, "Seed-Coder ignores them");
    assert.equal(seedCoder.files, false);
  });

  test("the answer is cut at a sentinel the server let through", () => {
    assert.equal(qwenCoder.parse("a + b<|file_sep|>more"), "a + b");
    assert.equal(mellum.parse("a + b<filename>x"), "a + b");
    assert.equal(seedCoder.parse("a + b"), "a + b");
  });

  test("formats are found by id, and a next-edit format is not a fill-in-the-middle one", () => {
    assert.equal(fimFormat("qwen2.5-coder"), qwenCoder);
    assert.throws(() => fimFormat("sweep-next-edit"), /next-edit format/);
    assert.throws(() => completionFormat("nope"), /known: qwen2.5-coder/);
    assert.equal(new Set(completionFormats().map((f) => f.id)).size, completionFormats().length);
  });
});

describe("the next-edit format (Sweep)", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`);
  const text = lines.join("");
  const cursor = lines.slice(0, 20).join("").length + 3; // inside line 21 (0-based 20)

  test("the block is ten lines each way, numbered from 1, and the model writes from the cursor's line", () => {
    const r = sweepNextEdit.render({ path: "f.txt", text, cursor });
    assert.deepEqual(r.block, { startLine: 10, endLine: 31 });
    assert.match(r.prompt, /<\|file_sep\|>original\/f\.txt:11:31\n/);
    assert.match(r.prompt, /<\|file_sep\|>current\/f\.txt:11:31\nline 11\n[\s\S]*lin<\|cursor\|>e 21/);
    assert.ok(r.prompt.includes("lin<|cursor|>e 21\n"));
    assert.equal(r.prefill, lines.slice(10, 20).join(""), "every line above the cursor's, from the block's start");
    assert.ok(r.prompt.endsWith(`<|file_sep|>updated/f.txt:11:31\n${r.prefill}`));
    assert.deepEqual(r.stop, ["<|endoftext|>", "<|file_sep|>"]);
  });

  test("after an insertion above the cursor, only the first line is given, so the lines between can change", () => {
    const r = sweepNextEdit.render({ path: "f.txt", text, cursor, changesAboveCursor: true });
    assert.equal(r.prefill, "line 11\n");
  });

  test("recent changes, retrieved chunks and whole files are written where Sweep reads them", () => {
    const r = sweepNextEdit.render({
      path: "f.txt",
      text: "a\nb\n",
      cursor: 0,
      recentChanges: [{ path: "f.txt", start: 1, end: 2, original: "x\n", updated: "a\n" }],
      retrieval: [{ path: "g.txt", text: "chunk" }],
      files: [{ path: "h.txt", text: "whole" }],
    });
    assert.ok(r.prompt.startsWith("<|file_sep|>h.txt\nwhole\n<|file_sep|>f.txt\na\nb\n\n<|file_sep|>g.txt\nchunk\n\n"));
    assert.ok(r.prompt.includes("<|file_sep|>f.txt:1:2\noriginal:\nx\n\nupdated:\na\n\n<|file_sep|>original/f.txt:1:2\n"));
    assert.equal(r.prefill, "");
  });

  test("the suggestion is the prefill and what the model wrote, over the lines of the block", () => {
    const r = sweepNextEdit.render({ path: "f.txt", text, cursor });
    const s = sweepNextEdit.parse("new 21\nnew 22\n<|file_sep|>junk", r);
    assert.deepEqual(s, { startLine: 10, endLine: 31, text: `${r.prefill}new 21\nnew 22\n` });
  });

  test("a cursor at the end of the file belongs to the last line, and an empty file has a block of nothing", () => {
    assert.deepEqual(sweepNextEdit.render({ path: "f", text, cursor: text.length }).block, { startLine: 29, endLine: 40 });
    assert.deepEqual(sweepNextEdit.render({ path: "f", text: "", cursor: 0 }).block, { startLine: 0, endLine: 0 });
  });
});

describe("filters", () => {
  test("a closing bracket the editor already has is not written twice, but a matching letter is kept", () => {
    assert.equal(trimSuffixOverlap("a + b)", ")\n"), "a + b");
    assert.equal(trimSuffixOverlap("a + b", "b\n"), "a + b");
    // An answer that went on into the code that is already after the cursor, and then into more of its own, is cut where it got there.
    assert.equal(
      trimSuffixOverlap("while (n) {\n  n--;\n}\n}\nreturn out;\n}\n\nfunction more() {}", "\n  }\n  return out;\n}\n"),
      "while (n) {\n  n--;\n}",
    );
    assert.equal(trimSuffixOverlap("a\nb\nc", "\nzzz\nyyy\n"), "a\nb\nc", "nothing like the code after the cursor: left");
    assert.equal(trimSuffixOverlap("x\ny\nz", "\ny\n"), "x\ny\nz", "one line after the cursor is too little to go on");
    // A closer that closes something in the suggestion is its own, not the editor's.
    assert.equal(trimSuffixOverlap("items.slice(i, i + size)", ");\n"), "items.slice(i, i + size)");
    assert.equal(trimSuffixOverlap('"abc"', '"\n'), '"abc"');
    assert.equal(trimSuffixOverlap('abc"', '"\n'), "abc");
  });

  test("a model that goes on into the line that follows loses that line", () => {
    const suffix = "\n  return total;\n}\n";
    assert.equal(trimSuffixOverlap("total += x;\n  return total;", suffix), "total += x;");
    assert.equal(trimSuffixOverlap("total += x;", suffix), "total += x;");
  });

  test("nothing, or what is already there, is not shown", () => {
    assert.deepEqual(shown("  \n", "a", "b"), { problem: "empty" });
    assert.deepEqual(shown("b", "a", "b + c"), { problem: "no change" });
    assert.deepEqual(shown("x", "a", "b"), { text: "x" });
  });
});

describe("the client", () => {
  let server: Server;
  let base = "";
  const seen: { url: string; body: Record<string, unknown> }[] = [];

  before(async () => {
    server = createServer((rq: IncomingMessage, res) => {
      let raw = "";
      rq.on("data", (c: Buffer) => (raw += c.toString()));
      rq.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ url: rq.url ?? "", body });
        res.setHeader("content-type", "application/json");
        if (rq.url === "/infill" && body["model"] === "no-fim") {
          res.writeHead(501).end(JSON.stringify({ error: { code: 501, message: "model does not support infill" } }));
          return;
        }
        res.end(
          JSON.stringify({
            content: " a + b",
            stop_type: "eos",
            tokens_evaluated: 30,
            tokens_cached: 20,
            timings: { prompt_n: 10, cache_n: 20, prompt_ms: 12.5, predicted_n: 4, predicted_ms: 30 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  test("/completion carries the rendered prompt and stops, and reports the server's timings", async () => {
    seen.length = 0;
    const out = await completeRaw(qwenCoder.render(req), { baseUrl: `${base}/`, model: "m", maxTokens: 32 });
    assert.equal(out.text, " a + b");
    assert.equal(out.stopType, "eos");
    assert.equal(out.timings.promptTokens, 10);
    assert.equal(out.timings.cachedTokens, 20);
    assert.equal(out.timings.generatedMs, 30);
    assert.ok(out.timings.totalMs >= 0);
    const b = seen[0]?.body ?? {};
    assert.equal(seen[0]?.url, "/completion");
    assert.equal(b["prompt"], qwenCoder.render(req).prompt);
    assert.deepEqual(b["stop"], ["<|endoftext|>", "<|file_sep|>"]);
    assert.equal(b["n_predict"], 32);
    assert.equal(b["temperature"], 0);
    assert.equal(b["cache_prompt"], true);
    assert.equal(b["model"], "m");
  });

  test("`extra` adds sampler fields but cannot replace the prompt", async () => {
    seen.length = 0;
    await completeRaw({ prompt: "p", stop: [] }, { baseUrl: base, extra: { top_k: 5, prompt: "other" } });
    assert.equal(seen[0]?.body["prompt"], "p");
    assert.equal(seen[0]?.body["top_k"], 5);
    assert.equal("stop" in (seen[0]?.body ?? {}), false);
  });

  test("/infill sends the texts and the other files, and says 501 for a model without the tokens", async () => {
    seen.length = 0;
    await completeInfill({ ...req, files: [{ path: "b.ts", text: "x" }] }, { baseUrl: base, cachePrompt: false });
    const b = seen[0]?.body ?? {};
    assert.equal(seen[0]?.url, "/infill");
    assert.equal(b["input_prefix"], req.prefix);
    assert.equal(b["input_suffix"], req.suffix);
    assert.deepEqual(b["input_extra"], [{ filename: "b.ts", text: "x" }]);
    assert.equal(b["cache_prompt"], false);
    assert.equal("stop" in b, false);
    seen.length = 0;
    await completeInfill(req, { baseUrl: base }, ["<file_sep>"]);
    assert.deepEqual(seen[0]?.body["stop"], ["<file_sep>"], "a model whose end marker the server does not know needs the format's stop");
    await assert.rejects(
      completeInfill(req, { baseUrl: base, model: "no-fim" }),
      (e: unknown) => e instanceof CompletionError && e.status === 501 && /does not support infill/.test(e.message),
    );
  });

  test("a server that is not there is an error with no status", async () => {
    await assert.rejects(
      completeRaw({ prompt: "p", stop: [] }, { baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 }),
      (e: unknown) => e instanceof CompletionError && e.status === undefined,
    );
  });
});

describe("the 1.5B next-edit format", () => {
  const change = { path: "g.js", start: 1, end: 1, original: "function g(a) {", updated: "function g(b) {" };
  test("is laid out as its model card shows: diffs, then the file before, now and after, with no cursor or ranges", () => {
    const r = sweepNextEditSmall.render({
      path: "g.js",
      before: "function g(a) {\n  return a;\n}",
      text: "function g(b) {\n  return a;\n}",
      cursor: 10,
      recentChanges: [change],
      files: [{ path: "h.js", text: "// h" }],
    });
    assert.equal(
      r.prompt,
      "<|file_sep|>h.js\n// h\n<|file_sep|>g.js.diff\noriginal:\nfunction g(a) {\nupdated:\nfunction g(b) {\n" +
        "<|file_sep|>original/g.js\nfunction g(a) {\n  return a;\n}\n<|file_sep|>current/g.js\nfunction g(b) {\n  return a;\n}\n<|file_sep|>updated/g.js",
    );
    assert.ok(r.stop.includes("<|file_sep|>"));
    assert.deepEqual(r.block, { startLine: 0, endLine: 3 });
  });

  test("the answer is the whole file, without the line break that follows the name and without what comes after", () => {
    const r = sweepNextEditSmall.render({ path: "g.js", text: "a\nb", cursor: 0 });
    assert.deepEqual(sweepNextEditSmall.parse("\nX\nY<|file_sep|>junk", r), { startLine: 0, endLine: 2, text: "X\nY" });
  });
});

describe("Zeta 2.1", () => {
  const text = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const cursor = text.indexOf("line 10") + 4;
  const change = { path: "z.js", start: 3, end: 3, original: "old", updated: "line 3" };

  test("is laid out as its model card shows: suffix first, related files, the edit history as a diff, the file, numbered markers around the region", () => {
    const r = zeta21.render({ path: "z.js", text, cursor, recentChanges: [change], files: [{ path: "h.js", text: "// h" }] });
    assert.deepEqual(r.block, { startLine: 0, endLine: 20 });
    assert.deepEqual(r.markers, [0, 8, 16, 20]);
    assert.ok(
      r.prompt.startsWith("<[fim-suffix]>\n<[fim-prefix]><filename>h.js\n// h\n\n<filename>edit_history\n--- a/z.js\n+++ b/z.js\n@@ -1,"),
    );
    assert.match(r.prompt, /-old\n\+line 3\n line 4\n line 5\n line 6\n\n<filename>z\.js\n<\|marker_1\|>line 1\n/);
    assert.match(r.prompt, /line 8\n<\|marker_2\|>line 9\nline<\|user_cursor\|> 10\n/);
    assert.ok(
      r.prompt.endsWith("line 20<|marker_4|>\n<[fim-middle]>"),
      "the last marker follows the last line with no line break, as in the sample",
    );
  });

  test("the lines after the region go first, and a long file is cut to a region around the cursor", () => {
    const long = `${Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n")}\n`;
    const r = zeta21.render({ path: "z.js", text: long, cursor: long.indexOf("l50"), linesAfter: 5 });
    assert.deepEqual(r.block, { startLine: 30, endLine: 71 });
    assert.ok(r.prompt.startsWith("<[fim-suffix]>\nl71\n"));
    assert.ok(r.prompt.includes("<filename>z.js\nl0\nl1\n"), "the lines above the region are written as they are");
    assert.match(r.prompt, /l29\n<\|marker_1\|>l30\n/);
  });

  test("the answer names its first and last marker, and what is between them replaces those lines, minus the cursor marker", () => {
    const r = zeta21.render({ path: "z.js", text, cursor });
    assert.deepEqual(zeta21.parse("<|marker_2|>line 9\nline 10<|user_cursor|>!\nline 11\n<|marker_3|>", r), {
      startLine: 8,
      endLine: 16,
      text: "line 9\nline 10!\nline 11\n",
    });
    assert.deepEqual(zeta21.parse("<|marker_3|>x<|marker_4|>", r), { startLine: 16, endLine: 20, text: "x" });
    assert.deepEqual(
      zeta21.parse("<|marker_1|>a\n<|marker_2|>b\n<|marker_3|>c<|marker_4|>", r),
      { startLine: 0, endLine: 20, text: "a\nb\nc" },
      "a span over several markers writes the ones in between again; they are taken out",
    );
    assert.deepEqual(
      zeta21.parse("<|marker_2|>new\n<|marker_2|>", r),
      { startLine: 8, endLine: 8, text: "new\n" },
      "between one marker and itself is an insertion",
    );
    for (const none of ["", "no markers", "<|marker_1|>only one", "<|marker_3|>x<|marker_1|>", "<|marker_9|>x<|marker_9|>y<|marker_10|>"]) {
      assert.deepEqual(zeta21.parse(none, r), { startLine: 0, endLine: 0, text: "" }, JSON.stringify(none));
    }
  });
});
