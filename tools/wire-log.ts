import { appendFile } from "node:fs/promises";

export interface WireRecord {
  n: number;
  at: string;
  url: string;
  status: number;
  /** An HTTP error, or an error event in the body. */
  failed: boolean;
  request: unknown;
  /** The whole response body as it came (the event stream, error events included). */
  response: string;
}

/**
 * Wraps the global `fetch`, which the provider adapters use, and hands every request to `match`ing URLs to `on` with the raw response
 * once it has been read. The caller still reads the response as normal. Authorization headers are never recorded. `flush` waits for the
 * responses still being read; `restore` puts the real `fetch` back.
 */
export function tapFetch(match: (url: string) => boolean, on: (r: WireRecord) => void | Promise<void>): { flush: () => Promise<void>; restore: () => void } {
  const real = globalThis.fetch;
  const pending = new Set<Promise<void>>();
  let seq = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await real(input, init);
    if (!match(url)) return res;
    const n = seq++;
    const at = new Date().toISOString();
    let request: unknown = init?.body;
    try {
      request = JSON.parse(String(init?.body));
    } catch {
      // not JSON: keep the text
    }
    const copy = res.clone();
    const done = (async () => {
      let text: string;
      try {
        text = await copy.text();
      } catch (e) {
        text = `[the response could not be read: ${e instanceof Error ? e.message : String(e)}]`;
      }
      const failed = res.status >= 400 || /"error"\s*:/.test(text);
      await on({ n, at, url, status: res.status, failed, request, response: text });
    })();
    pending.add(done);
    void done.finally(() => pending.delete(done));
    return res;
  }) as typeof fetch;
  return {
    flush: async () => {
      await Promise.all([...pending]);
    },
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/**
 * Record every chat-completions request and the raw response to a JSON-lines file, so that a request a server answered badly can be
 * replayed with tools/llama-replay.ts. Returns a function that waits for the last response to be written.
 */
export function installWireLog(file: string): () => Promise<void> {
  return tapFetch(
    (url) => url.endsWith("/chat/completions"),
    (r) => appendFile(file, `${JSON.stringify(r)}\n`),
  ).flush;
}
