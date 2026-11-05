/**
 * Fetching with the two rules downloads need (docs/local-models.md, section 3): redirects are followed by hand so a token is sent only to
 * the host it was meant for (Hugging Face redirects to a CDN), and failures are a `FetchError` that says what to do.
 */

export type FetchFn = typeof fetch;

export class FetchError extends Error {
  override name = "FetchError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface FollowOptions {
  fetch?: FetchFn | undefined;
  headers?: Record<string, string> | undefined;
  /** Sent as `Authorization: Bearer` while the request stays on the first host. */
  token?: string | undefined;
  method?: "GET" | "HEAD" | undefined;
  signal?: AbortSignal | undefined;
  /** Return a redirect response itself instead of following it (Hugging Face tells the file's hash on the redirect). */
  manual?: boolean | undefined;
}

const MAX_REDIRECTS = 8;

/** The response after any redirects. A status of 400 or more is a `FetchError`. */
export async function fetchFollow(url: string, o: FollowOptions = {}): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const first = new URL(url).host;
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token !== undefined && new URL(at).host === first) headers["authorization"] = `Bearer ${o.token}`;
    let res: Response;
    try {
      res = await doFetch(at, { method: o.method ?? "GET", headers, redirect: "manual", ...(o.signal === undefined ? {} : { signal: o.signal }) });
    } catch (e) {
      if (o.signal?.aborted === true) throw e;
      throw new FetchError(`could not reach ${new URL(at).host}: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      if (o.manual === true && hop === 0) return res;
      at = new URL(res.headers.get("location") as string, at).toString();
      await res.body?.cancel();
      continue;
    }
    if (res.status >= 400 && res.status !== 416) {
      await res.body?.cancel();
      const why = res.status === 401 || res.status === 403 ? " (a private or gated repository needs a token: set hf_token_env)" : res.status === 404 ? " (not found)" : "";
      throw new FetchError(`${new URL(at).host} answered ${res.status}${why} for ${url}`, res.status);
    }
    return res;
  }
  throw new FetchError(`too many redirects from ${url}`);
}

export async function fetchJson(url: string, o: FollowOptions = {}): Promise<unknown> {
  const res = await fetchFollow(url, { ...o, headers: { accept: "application/json", ...(o.headers ?? {}) } });
  try {
    return await res.json();
  } catch {
    throw new FetchError(`${url} did not answer with JSON`);
  }
}
