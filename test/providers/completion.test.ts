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
