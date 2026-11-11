import { appendFile } from "node:fs/promises";

/**
 * Record every chat-completions request and the raw response (the whole event stream, error events included) to a JSON-lines file, so
 * that a request a server answered badly can be replayed with tools/llama-replay.ts. It wraps the global `fetch`, which the provider
 * adapters use; the Authorization header is not recorded. Returns a function that waits for the last response to be written.
 */
export function installWireLog(file: string): () => Promise<void> {
  const real = globalThis.fetch;
  const pending = new Set<Promise<void>>();
  let seq = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await real(input, init);
    if (!url.endsWith("/chat/completions")) return res;
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
      await appendFile(file, `${JSON.stringify({ n, at, url, status: res.status, failed, request, response: text })}\n`);
    })();
    pending.add(done);
    void done.finally(() => pending.delete(done));
    return res;
  }) as typeof fetch;
  return async () => {
    await Promise.all([...pending]);
  };
}
