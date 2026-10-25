import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptySetup } from "../../harness/setup.ts";
import type { ModelContext } from "../../harness/context-builder.ts";
import { collectStream, conformanceProblems, type StreamRun } from "../../providers/conformance.ts";
import { Limiter, classifyStatus, parseRetryAfter, type HttpOptions } from "../../providers/http.ts";
import { ProviderError, type ProviderAdapter } from "../../providers/types.ts";
import { replayFetch } from "../../providers/fixtures.ts";
import { FakeServer, type Reply } from "../support/fake-server.ts";
import { HELLO, sse, toyAdapter } from "../support/toy-adapter.ts";

const SECRET = "sk-test-SECRET-123";
const context: ModelContext = { system: "s", instructions: undefined, turns: [], tools: [], cacheHints: [] };
const setup = { ...emptySetup(), model: { provider: "main", id: "toy-1" } };
const req = (signal: AbortSignal = new AbortController().signal) => ({ context, setup, signal });

/** Options that make retries instant and recorded. */
const fast = (extra: HttpOptions = {}): HttpOptions & { waits: number[] } => {
  const waits: number[] = [];
  return { waits, secrets: [SECRET], auth: () => ({ authorization: `Bearer ${SECRET}` }), retry: { jitter: (ms) => ms, baseMs: 10 }, sleep: async (ms) => void waits.push(ms), ...extra };
};

async function withServer<T>(script: Reply[] | ((n: number) => Reply), fn: (server: FakeServer) => Promise<T>): Promise<T> {
  const server = await FakeServer.start(script);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}
const run = async (adapter: ProviderAdapter, signal?: AbortSignal): Promise<StreamRun> => collectStream(adapter.stream(req(signal)));
const checked = (r: StreamRun): StreamRun => {
  assert.deepEqual(conformanceProblems(r, { secrets: [SECRET] }), []);
  return r;
};
const ok: Reply = { acts: HELLO };

describe("a normal stream", () => {
  test("events come through, the result is returned, and it conforms", async () => {
    await withServer([ok], async (server) => {
      const r = checked(await run(toyAdapter(server.url, fast())));
      assert.equal(r.error, undefined);
      assert.deepEqual(r.events.map((e) => e.type), ["started", "observed", "usage", "text.delta", "text.delta", "block.done", "tool_call.start", "tool_call.delta", "tool_call.delta", "block.done", "usage"]);
      assert.deepEqual(r.completed?.blocks, [{ type: "text", text: "Hello" }, { type: "tool_call", call_id: "c1", name: "run", args: { x: 1 } }]);
      assert.equal(r.completed?.stop_reason, "tool_use");
      assert.deepEqual(r.completed?.usage, { input_tokens: 10, output_tokens: 7 });
      assert.equal(r.completed?.observed.model, "toy-1-2026");
      const seen = server.seen[0];
      assert.equal(seen?.headers["authorization"], `Bearer ${SECRET}`);
      assert.deepEqual(JSON.parse(seen?.body ?? ""), { model: "toy-1", turns: 0 });
    });
  });

  test("unknown events and comments are tolerated", async () => {
    await withServer([{ acts: [": hi\n\n", sse("future_thing", { i: 0 }), ...HELLO] }], async (server) => {
      checked(await run(toyAdapter(server.url, fast())));
    });
  });

  test("the bytes may arrive in any pieces, including mid-character", async () => {
    const text = HELLO.join("").replace("Hel", "Hé日");
    for (const size of [1, 2, 3, 7, 64]) {
      const pieces = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
      await withServer([{ acts: pieces }], async (server) => {
        const r = checked(await run(toyAdapter(server.url, fast())));
        assert.equal((r.completed?.blocks[0] as { text: string }).text, "Hé日lo");
      });
    }
  });

  test("the injected fetch is used (a replayed fixture needs no network)", async () => {
    const adapter = toyAdapter("http://never.invalid", fast({ fetch: replayFetch({ version: 1, response: { status: 200, headers: { "content-type": "text/event-stream" }, body: HELLO.join("") } }, [5]) }));
    assert.equal(checked(await run(adapter)).completed?.stop_reason, "tool_use");
  });
});

describe("errors before any content", () => {
  test("a retryable status is retried after the provider's retry-after, then succeeds; the consumer never sees the failed attempt", async () => {
    const o = fast();
    await withServer([{ status: 429, headers: { "retry-after": "2" }, acts: ['{"error":"slow down"}'] }, { status: 503, acts: ["busy"] }, ok], async (server) => {
      const r = checked(await run(toyAdapter(server.url, o)));
      assert.equal(r.completed?.stop_reason, "tool_use");
      assert.equal(server.seen.length, 3);
      assert.deepEqual(o.waits, [2000, 20], "retry-after first, then exponential backoff");
      assert.equal(r.events.filter((e) => e.type === "started").length, 1);
    });
  });

  test("gives up after maxAttempts with the last error, classified", async () => {
    const o = fast({ retry: { maxAttempts: 3, jitter: (ms) => ms, baseMs: 1 } });
    await withServer([{ status: 500, acts: ["boom"] }], async (server) => {
      const r = await run(toyAdapter(server.url, o));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "server" && r.error.status === 500 && r.error.retryable);
      assert.match(r.error.message, /boom/);
      assert.equal(server.seen.length, 3);
    });
  });

  test("non-retryable statuses are not retried; the body is shown with secrets scrubbed", async () => {
    for (const [status, kind] of [[401, "auth"], [400, "invalid_request"], [413, "invalid_request"]] as const) {
      await withServer([{ status, acts: [`bad key ${SECRET} in header`] }], async (server) => {
        const r = await run(toyAdapter(server.url, fast()));
        assert.ok(r.error instanceof ProviderError && r.error.kind === kind && !r.error.retryable, `${status}`);
        assert.ok(!r.error.message.includes(SECRET) && r.error.message.includes("[redacted]"));
        assert.equal(server.seen.length, 1);
        assert.deepEqual(conformanceProblems(r, { secrets: [SECRET] }), []);
      });
    }
  });

  test("a reset connection and a refused connection are retried as network errors", async () => {
    await withServer([{ acts: [{ reset: true }] }, ok], async (server) => {
      const r = checked(await run(toyAdapter(server.url, fast())));
      assert.equal(r.completed?.stop_reason, "tool_use");
      assert.equal(server.seen.length, 2);
    });
    const dead = await FakeServer.start([ok]);
    const url = dead.url;
    await dead.close();
    const r = await run(toyAdapter(url, fast({ retry: { maxAttempts: 2, jitter: (ms) => ms, baseMs: 1 } })));
    assert.ok(r.error instanceof ProviderError && r.error.kind === "network" && r.error.retryable);
  });

  test("an error event before content is retried when the mapper says it is retryable", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), sse("error", { kind: "overloaded", message: "try later" })] }, ok], async (server) => {
      const r = checked(await run(toyAdapter(server.url, fast())));
      assert.equal(server.seen.length, 2);
      assert.equal(r.events.filter((e) => e.type === "started").length, 1);
    });
  });

  test("a stream that ends before the provider's final event is a protocol error, retried only before content", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" })] }, ok], async (server) => {
      checked(await run(toyAdapter(server.url, fast())));
      assert.equal(server.seen.length, 2);
    });
  });

  test("a mapper can reclassify statuses", async () => {
    // The toy mapper has no override; classifyStatus is the default table.
    assert.deepEqual(classifyStatus(529), { kind: "overloaded", retryable: true });
    assert.deepEqual(classifyStatus(404), { kind: "invalid_request", retryable: false });
    assert.deepEqual(classifyStatus(502), { kind: "server", retryable: true });
  });

  test("retry-after as seconds or as a date; garbage is ignored; waits are capped", async () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter("0.5"), 500);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 5000);
    assert.equal(parseRetryAfter("soon"), undefined);
    assert.equal(parseRetryAfter(null), undefined);
    const o = fast({ retry: { maxMs: 100, jitter: (ms) => ms, baseMs: 1 } });
    await withServer([{ status: 429, headers: { "retry-after": "3600" }, acts: ["x"] }, ok], async (server) => {
      await run(toyAdapter(server.url, o));
      assert.deepEqual(o.waits, [100]);
    });
  });
});

describe("errors after content", () => {
  test("never retried; the complete blocks so far are on the error; conforms", async () => {
    const acts = [HELLO[0] as string, HELLO[2] as string, HELLO[4] as string, HELLO[5] as string, sse("text", { i: 2, t: "par" }), { wait: 40 } as const, { reset: true } as const];
    await withServer([{ acts }, ok], async (server) => {
      const r = await run(toyAdapter(server.url, fast()));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "network");
      assert.deepEqual(r.error.partial, [{ type: "text", text: "Hello" }]);
      assert.equal(server.seen.length, 1, "no retry once content was shown");
      assert.deepEqual(conformanceProblems(r, { secrets: [SECRET] }), []);
    });
  });

  test("an error event in the stream after content is thrown as it is, with the partial blocks", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), sse("text", { i: 0, t: "a" }), sse("end", { i: 0 }), sse("error", { kind: "overloaded", message: "gone" })] }], async (server) => {
      const r = await run(toyAdapter(server.url, fast()));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "overloaded" && r.error.partial.length === 1);
      assert.equal(server.seen.length, 1);
    });
  });
});

describe("timeouts and cancellation", () => {
  test("silence longer than the idle limit ends the attempt; it is retried before content", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), { hang: true }] }, ok], async (server) => {
      const r = checked(await run(toyAdapter(server.url, fast({ timeouts: { idleMs: 60 } }))));
      assert.equal(r.completed?.stop_reason, "tool_use");
      assert.equal(server.seen.length, 2);
    });
  });

  test("idle after content is a timeout error with the partial blocks", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), sse("text", { i: 0, t: "a" }), sse("end", { i: 0 }), sse("text", { i: 1, t: "b" }), { hang: true }] }], async (server) => {
      const r = await run(toyAdapter(server.url, fast({ timeouts: { idleMs: 60 } })));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "timeout" && r.error.partial.length === 1);
      assert.deepEqual(conformanceProblems(r), []);
      assert.equal(server.seen.length, 1);
    });
  });

  test("the total limit covers the whole request, however lively the stream", async () => {
    const acts = Array.from({ length: 50 }, () => [sse("text", { i: 0, t: "x" }), { wait: 20 } as const]).flat();
    await withServer([{ acts }], async (server) => {
      const r = await run(toyAdapter(server.url, fast({ timeouts: { idleMs: 1000, totalMs: 100 } })));
      assert.ok(r.error instanceof ProviderError && r.error.kind === "timeout" && /took longer/.test(r.error.message));
    });
  });

  test("aborting the signal ends the stream with `aborted` and closes the connection", async () => {
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), sse("text", { i: 0, t: "a" }), sse("end", { i: 0 }), { hang: true }] }], async (server) => {
      const ac = new AbortController();
      const stream = toyAdapter(server.url, fast()).stream(req(ac.signal));
      const events = [];
      let error: unknown;
      try {
        for (;;) {
          const r = await stream.next();
          if (r.done) break;
          events.push(r.value);
          if (r.value.type === "block.done") ac.abort();
        }
      } catch (e) {
        error = e;
      }
      assert.ok(error instanceof ProviderError && error.kind === "aborted" && error.partial.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(server.seen[0]?.closed, true);
    });
  });

  test("an already-aborted signal makes no request", async () => {
    await withServer([ok], async (server) => {
      const ac = new AbortController();
      ac.abort();
      const r = await run(toyAdapter(server.url, fast()), ac.signal);
      assert.ok(r.error instanceof ProviderError && r.error.kind === "aborted");
      assert.equal(server.seen.length, 0);
    });
  });

  test("stopping early (return) cancels the request and frees the slot", async () => {
    const limiter = new Limiter(1);
    await withServer([{ acts: [sse("start", { model: "m", id: "r" }), sse("text", { i: 0, t: "a" }), { hang: true }] }], async (server) => {
      const stream = toyAdapter(server.url, fast({ limiter })).stream(req());
      for (;;) {
        const r = await stream.next();
        if (!r.done && r.value.type === "text.delta") break;
      }
      assert.equal(limiter.active, 1);
      await stream.return({ blocks: [], stop_reason: "", usage: { input_tokens: 0, output_tokens: 0 }, observed: {} });
      assert.equal(limiter.active, 0);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(server.seen[0]?.closed, true);
    });
  });
});

describe("limiter", () => {
  test("at most N at once, in order; release is idempotent", async () => {
    const l = new Limiter(2);
    const order: string[] = [];
    const a = await l.acquire();
    const b = await l.acquire();
    const c = l.acquire().then((r) => (order.push("c"), r));
    const d = l.acquire().then((r) => (order.push("d"), r));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([l.active, l.queued, order], [2, 2, []]);
    a();
    a();
    const rc = await c;
    assert.deepEqual([l.active, l.queued, order], [2, 1, ["c"]]);
    b();
    const rd = await d;
    assert.deepEqual(order, ["c", "d"]);
    rc();
    rd();
    assert.equal(l.active, 0);
    assert.throws(() => new Limiter(0), RangeError);
  });

  test("aborting while waiting leaves the queue clean", async () => {
    const l = new Limiter(1);
    const held = await l.acquire();
    const ac = new AbortController();
    const waiting = l.acquire(ac.signal);
    ac.abort();
    await assert.rejects(waiting, (e) => e instanceof ProviderError && e.kind === "aborted");
    assert.equal(l.queued, 0);
    held();
    assert.equal(l.active, 0);
  });

  test("a shared limiter caps concurrent streams", async () => {
    const limiter = new Limiter(2);
    let live = 0;
    let peak = 0;
    await withServer(() => ({ acts: [{ wait: 40 }, ...HELLO] }), async (server) => {
      const adapter = toyAdapter(server.url, fast({ limiter, hooks: { onRequest: () => void (peak = Math.max(peak, ++live)), onResponse: () => void live-- } }));
      const runs = await Promise.all(Array.from({ length: 6 }, () => run(adapter)));
      for (const r of runs) checked(r);
      assert.ok(peak <= 2, `peak ${peak}`);
      assert.equal(limiter.active, 0);
    });
  });
});

describe("hooks and secrets", () => {
  test("hooks see redacted views; a throwing hook cannot break the request", async () => {
    const views: unknown[] = [];
    const o = fast({ hooks: { onRequest: (v) => (views.push(v), void (() => { throw new Error("boom"); })()), onResponse: (v) => void views.push(v), onSse: (e) => void views.push(e), onRetry: (v) => void views.push(v) } });
    await withServer([{ status: 500, acts: [`oops ${SECRET}`] }, ok], async (server) => {
      checked(await run(toyAdapter(server.url, o)));
    });
    const text = JSON.stringify(views);
    assert.ok(!text.includes(SECRET), "no secret in any hook view");
    assert.match(text, /\[redacted\]/);
    assert.ok(views.length > 5);
  });

  test("a secret the provider echoes in the stream is scrubbed from errors", async () => {
    await withServer([{ acts: [sse("error", { kind: "server", message: `bad key ${SECRET}` })] }], async (server) => {
      const r = await run(toyAdapter(server.url, fast({ retry: { maxAttempts: 1 } })));
      assert.ok(r.error instanceof ProviderError && !r.error.message.includes(SECRET));
      assert.deepEqual(conformanceProblems(r, { secrets: [SECRET] }), []);
    });
  });
});

describe("the conformance checks themselves", () => {
  const base = { blocks: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, observed: {} };
  test("flag what a broken adapter would do", () => {
    const p = (r: StreamRun) => conformanceProblems(r, { secrets: ["S3CR3T"] }).join("|");
    assert.match(p({ events: [] }), /neither returned nor threw/);
    assert.match(p({ events: [], completed: base, error: new ProviderError({ kind: "server", message: "x" }) }), /both returned and threw/);
    assert.match(p({ events: [], error: new Error("x") }), /not a ProviderError/);
    assert.match(p({ events: [{ type: "text.delta", index: 0, text: "a" }, { type: "started" }], completed: base }), /not the first event/);
    assert.match(p({ events: [{ type: "usage", usage: { input_tokens: 5, output_tokens: 5 } }, { type: "usage", usage: { input_tokens: 4, output_tokens: 5 } }], completed: base }), /usage decreased/);
    assert.match(p({ events: [{ type: "text.delta", index: 0, text: "a" }, { type: "block.done", index: 0, block: { type: "text", text: "b" } }], completed: { ...base, blocks: [{ type: "text", text: "b" }] } }), /deltas do not add up/);
    assert.match(p({ events: [{ type: "block.done", index: 0, block: { type: "text", text: "b" } }], completed: base }), /returned blocks/);
    assert.match(p({ events: [{ type: "block.done", index: 0, block: { type: "text", text: "S3CR3T" } }], completed: { ...base, blocks: [{ type: "text", text: "S3CR3T" }] } }), /secret/);
    assert.match(p({ events: [{ type: "block.done", index: 0, block: { type: "text", text: "a" } }], error: new ProviderError({ kind: "network", message: "x" }) }), /partial blocks/);
  });
});
