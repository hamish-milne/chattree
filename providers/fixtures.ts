/**
 * Recorded provider responses, for tests that must not call a provider (docs/writing-an-adapter.md). A fixture is
 * one HTTP response, secrets scrubbed, stored as JSON; replaying it lets a test choose how the bytes are split
 * into network chunks, which is how streaming parsers are shaken out.
 */

export interface Fixture {
  version: 1;
  /** What was asked, with credentials removed. For people reading the fixture, not used in replay. */
  request?: { url: string; method: string; headers: Record<string, string>; body: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

const SENSITIVE = /^(authorization|x-api-key|api-key|proxy-authorization|cookie|set-cookie|x-goog-api-key|openai-organization|openai-project|anthropic-organization-id|request-id|x-request-id|cf-ray)$/i;

export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join("[redacted]");
  return out;
}

const scrubHeaders = (h: Record<string, string>, secrets: readonly string[]): Record<string, string> =>
  Object.fromEntries(Object.entries(h).flatMap(([k, v]) => (SENSITIVE.test(k) ? [] : [[k.toLowerCase(), scrubText(v, secrets)] as const])));

/**
 * A `fetch` that makes the real request, passes the response through unchanged, and hands a scrubbed copy of the
 * exchange to `sink` once the body has been read to the end. Headers that identify the account or the request
 * are dropped; every string in `secrets` is replaced everywhere.
 */
export function recordingFetch(real: typeof fetch, sink: (fixture: Fixture) => void | Promise<void>, secrets: readonly string[] = []): typeof fetch {
  return async (input, init) => {
    const res = await real(input, init);
    if (res.body === null) return res;
    const [pass, copy] = res.body.tee();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    void (async () => {
      const dec = new TextDecoder();
      let text = "";
      try {
        for await (const chunk of copy as unknown as AsyncIterable<Uint8Array>) text += dec.decode(chunk, { stream: true });
        text += dec.decode();
      } catch {
        // A stream that failed mid-way is still worth recording up to that point.
      }
      await sink({
        version: 1,
        request: { url: scrubText(url, secrets), method: init?.method ?? "GET", headers: scrubHeaders(headers, secrets), body: scrubText(body, secrets) },
        response: { status: res.status, headers: scrubHeaders(Object.fromEntries(res.headers), secrets), body: scrubText(text, secrets) },
      });
    })();
    return new Response(pass, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** Split `bytes` into pieces of the given sizes, repeating the sizes as needed (a size of 0 is treated as 1). */
export function splitBytes(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const n = Math.max(1, sizes[i % sizes.length] ?? bytes.length);
    out.push(bytes.subarray(at, at + n));
    at += n;
  }
  return out;
}

/** A `fetch` that answers every request with the fixture's response, its body arriving in chunks of `chunkSizes` bytes (default: all at once). */
export function replayFetch(fixture: Fixture, chunkSizes: readonly number[] = [Number.MAX_SAFE_INTEGER]): typeof fetch {
  return async () => {
    const chunks = splitBytes(new TextEncoder().encode(fixture.response.body), chunkSizes);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    return new Response(body, { status: fixture.response.status, headers: fixture.response.headers });
  };
}
