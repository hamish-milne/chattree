import type { Block } from "../harness/context-builder.ts";
import { parseSse, type SseEvent } from "./sse.ts";
import { USER_AGENT } from "./identity.ts";
import { ProviderError, type Completed, type ErrorKind, type ModelStream, type StreamEvent, type StreamRequest } from "./types.ts";

/**
 * The shared HTTP transport for adapters that talk SSE over HTTP (docs/providers.md, P3; the extension points are
 * documented in docs/writing-an-adapter.md). It owns what is the same for every such provider: concurrency,
 * timeouts, retry, error classification, secret scrubbing, event buffering, cancellation. A provider supplies an
 * `HttpMapper`: three small functions and a way to classify errors. Every behaviour here is an option with a
 * documented default, and any of them can be replaced.
 */

export interface HttpRequestSpec {
  url: string;
  method?: string;
  headers: Record<string, string>;
  /** A string is sent as is; anything else as JSON. */
  body?: unknown;
}

/** What an adapter provides to describe one provider's API. */
export interface HttpMapper<S> {
  /** The request to send. Do not put credentials here; `auth` adds them. */
  request(req: StreamRequest): HttpRequestSpec | Promise<HttpRequestSpec>;
  /** Fresh per-attempt state. */
  start(req: StreamRequest): S;
  /** Translate one SSE event. May throw `ProviderError` (an error event inside the stream). */
  event(sse: SseEvent, state: S): StreamEvent[];
  /** Whether the provider's terminal event has been seen. A stream that ends before this is a protocol error. */
  done(state: S): boolean;
  /** Build the result. Called once, after `done`. */
  finish(state: S): Completed;
  /** Override how a non-2xx response is classified. Return nothing to use the default. */
  classify?(res: { status: number; headers: Headers; body: string }): Partial<{ kind: ErrorKind; retryable: boolean; message: string; retryAfterMs: number }> | undefined;
}

export interface RetryPolicy {
  /** Total attempts including the first. Default 4. */
  maxAttempts: number;
  /** First backoff. Default 500 ms; doubles each attempt. */
  baseMs: number;
  /** Cap on a single wait, including a provider's `retry-after`. Default 30 s. */
  maxMs: number;
  /** Randomise a wait. Default: between half and full. */
  jitter(ms: number): number;
  /** Decide again whether an error is worth retrying. Default: `error.retryable`. */
  shouldRetry(error: ProviderError, attempt: number): boolean;
}

export interface Timeouts {
  /** No bytes for this long ends the stream. Default 60 s. */
  idleMs: number;
  /** The whole request, retries included. Default 10 minutes. */
  totalMs: number;
}

/** Hooks see redacted views and must not throw; they are for logging, tracing and recording. */
export interface HttpHooks {
  onRequest?(view: { url: string; method: string; headers: Record<string, string>; body: string; attempt: number }): void;
  onResponse?(view: { status: number; headers: Record<string, string>; attempt: number }): void;
  onSse?(event: SseEvent): void;
  onRetry?(view: { attempt: number; waitMs: number; error: ProviderError }): void;
}

/**
 * The headers a request goes out with, lowest priority first: our `User-Agent`, what the adapter built, the provider's `headers` map (a
 * `null` value removes that header, which can break a provider's terms: docs/providers.md), the session header (`session_header`, with the
 * conversation's id when there is one). Credentials are added after this and always win. Names are compared case-insensitively.
 */
export function requestHeaders(built: Record<string, string>, opts: { headers?: Record<string, string | null> | undefined; sessionHeader?: string | undefined }, session?: string): Record<string, string> {
  const out = new Map<string, string>([["user-agent", USER_AGENT]]);
  for (const [k, v] of Object.entries(built)) out.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) out.delete(k.toLowerCase());
    else out.set(k.toLowerCase(), v);
  }
  if (opts.sessionHeader !== undefined && session !== undefined && !Object.entries(opts.headers ?? {}).some(([k, v]) => v === null && k.toLowerCase() === opts.sessionHeader?.toLowerCase())) out.set(opts.sessionHeader.toLowerCase(), session);
  return Object.fromEntries(out);
}

export interface HttpOptions {
  /** Extra headers for every request; `null` removes one. For the default `User-Agent` that leaves the runtime's own (`node`), which is sent when none is set. */
  headers?: Record<string, string | null>;
  /** The name of a header that carries `StreamRequest.session`, a stable id for the conversation (OpenCode Go's `x-opencode-session`, for caching). */
  sessionHeader?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Headers that carry the credentials; added after `request`, never shown to hooks. */
  auth?(spec: HttpRequestSpec): Record<string, string> | Promise<Record<string, string>>;
  /** Secret values to scrub from errors and hook views, in addition to whatever `auth` adds. */
  secrets?: readonly string[];
  retry?: Partial<RetryPolicy>;
  timeouts?: Partial<Timeouts>;
  /** Share one across adapters instances of a provider to cap concurrent requests. */
  limiter?: Limiter;
  hooks?: HttpHooks;
  /** Waits between retries. Default: a timer that ends early when the request is aborted. Tests inject this. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** At most `max` requests at once; the rest wait their turn, in order. */
export class Limiter {
  readonly #max: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("a limiter needs a positive integer");
    this.#max = max;
  }
  get active(): number {
    return this.#active;
  }
  get queued(): number {
    return this.#waiting.length;
  }
  /** Resolves when a slot is free; call the result to give it back. Waiting ends early (with an `aborted` error) if `signal` aborts. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw new ProviderError({ kind: "aborted", message: "aborted while waiting for a request slot" });
    if (this.#active < this.#max) this.#active++;
    else {
      // A slot handed over by `release` stays counted as active, so `#active` is unchanged when our turn comes.
      await new Promise<void>((resolve, reject) => {
        const turn = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.#waiting.indexOf(turn);
          if (i >= 0) this.#waiting.splice(i, 1);
          reject(new ProviderError({ kind: "aborted", message: "aborted while waiting for a request slot" }));
        };
        this.#waiting.push(turn);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next !== undefined) next();
      else this.#active--;
    };
  }
}

const SENSITIVE_HEADERS = /^(authorization|x-api-key|api-key|proxy-authorization|cookie|set-cookie|x-goog-api-key)$/i;
const MAX_ERROR_BODY = 64 * 1024;

export const defaultRetry: RetryPolicy = {
  maxAttempts: 4,
  baseMs: 500,
  maxMs: 30_000,
  jitter: (ms) => ms / 2 + Math.random() * (ms / 2),
  shouldRetry: (e) => e.retryable,
};

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortedError(signal));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortedError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const abortedError = (signal: AbortSignal): ProviderError => new ProviderError({ kind: "aborted", message: "the request was aborted", cause: signal.reason });

/** The default classification of an HTTP status. */
export function classifyStatus(status: number): { kind: ErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "rate_limit", retryable: true };
  if (status === 503 || status === 529) return { kind: "overloaded", retryable: true };
  if (status === 408 || status === 409 || status === 425) return { kind: "server", retryable: true };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { kind: "invalid_request", retryable: false };
  if (status >= 500) return { kind: "server", retryable: true };
  return { kind: "invalid_request", retryable: false };
}

/** `retry-after` as milliseconds: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const isContent = (e: StreamEvent): boolean => e.type !== "started" && e.type !== "observed" && e.type !== "usage";

/**
 * Make one request and stream it. See the file comment and `HttpOptions`.
 *
 * Retrying: before the first content event, a retryable failure (a refused or reset connection, a retryable
 * status, a retryable error event) is tried again after a backoff, up to `maxAttempts`, honouring `retry-after`
 * (capped at `maxMs`). After content has been yielded nothing is retried: the partial output was paid for, and the
 * caller decides what to do with it (the thrown error carries the complete blocks in `partial`).
 */
export async function* httpStream<S>(mapper: HttpMapper<S>, req: StreamRequest, opts: HttpOptions = {}): ModelStream {
  const doFetch = opts.fetch ?? fetch;
  const retry: RetryPolicy = { ...defaultRetry, ...opts.retry };
  const timeouts: Timeouts = { idleMs: 60_000, totalMs: 600_000, ...opts.timeouts };
  const sleep = opts.sleep ?? defaultSleep;
  const hooks = opts.hooks ?? {};

  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort(req.signal.reason);
  if (req.signal.aborted) controller.abort(req.signal.reason);
  else req.signal.addEventListener("abort", onCallerAbort, { once: true });
  const total = setTimeout(() => controller.abort(new ProviderError({ kind: "timeout", message: `the request took longer than ${timeouts.totalMs} ms` })), timeouts.totalMs);

  const secrets = new Set((opts.secrets ?? []).filter((s) => s.length > 0));
  const scrub = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join("[redacted]");
    return out;
  };
  const scrubError = (e: ProviderError): ProviderError => {
    e.message = scrub(e.message);
    return e;
  };

  const blocks: Block[] = [];
  let release: (() => void) | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      let held: StreamEvent[] = [];
      let content = false;
      // Per attempt, so an idle timeout ends this attempt only; the caller's abort and the total limit end them all.
      const attemptController = new AbortController();
      const link = (): void => attemptController.abort(controller.signal.reason);
      if (controller.signal.aborted) link();
      else controller.signal.addEventListener("abort", link, { once: true });
      const signal = attemptController.signal;
      try {
        release = await (opts.limiter?.acquire(controller.signal) ?? Promise.resolve(() => {}));
        if (signal.aborted) throw signalError(signal);
        const spec = await mapper.request(req);
        const authHeaders = (await opts.auth?.(spec)) ?? {};
        for (const v of Object.values(authHeaders)) {
          if (v.length === 0) continue;
          secrets.add(v);
          const bare = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v)?.[1]; // the key alone, as an error body might echo it
          if (bare !== undefined) secrets.add(bare);
        }
        const headers = { ...requestHeaders(spec.headers, opts, req.session), ...authHeaders };
        const body = spec.body === undefined ? undefined : typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
        const method = spec.method ?? "POST";
        safely(() => hooks.onRequest?.({ url: spec.url, method, headers: viewHeaders(headers), body: scrub(body ?? ""), attempt }));

        let res: Response;
        try {
          res = await doFetch(spec.url, { method, headers, ...(body === undefined ? {} : { body }), signal });
        } catch (e) {
          throw signal.aborted ? signalError(signal) : new ProviderError({ kind: "network", message: `request failed: ${errorText(e)}`, retryable: true, cause: e });
        }
        safely(() => hooks.onResponse?.({ status: res.status, headers: viewHeaders(Object.fromEntries(res.headers)), attempt }));
        if (!res.ok) throw await failure(mapper, res, scrub);
        if (res.body === null) throw new ProviderError({ kind: "protocol", message: "the response has no body", retryable: false });

        const state = mapper.start(req);
        for await (const sse of parseSse(idleGuarded(res.body, timeouts.idleMs, attemptController))) {
          safely(() => hooks.onSse?.(sse));
          for (const ev of mapper.event(sse, state)) {
            if (ev.type === "block.done") blocks[ev.index] = ev.block;
            if (!content && !isContent(ev)) {
              held.push(ev);
              continue;
            }
            if (!content) {
              content = true;
              for (const h of held) yield h;
              held = [];
            }
            yield ev;
          }
          if (mapper.done(state)) break;
        }
        if (signal.aborted) throw signalError(signal);
        if (!mapper.done(state)) throw new ProviderError({ kind: "protocol", message: "the stream ended before the provider's final event", retryable: !content });
        for (const h of held) yield h;
        release();
        release = undefined;
        return mapper.finish(state);
      } catch (e) {
        release?.();
        release = undefined;
        const err = scrubError(toProviderError(e, signal));
        err.partial = blocks.filter((b): b is Block => b !== undefined);
        if (content || err.kind === "aborted" || attempt >= retry.maxAttempts || !(err.retryable && retry.shouldRetry(err, attempt))) throw err;
        const wait = Math.min(retry.maxMs, err.retryAfterMs ?? retry.jitter(Math.min(retry.maxMs, retry.baseMs * 2 ** (attempt - 1))));
        safely(() => hooks.onRetry?.({ attempt, waitMs: wait, error: err }));
        blocks.length = 0;
        try {
          await sleep(wait, controller.signal);
        } catch (s) {
          throw scrubError(toProviderError(s, controller.signal));
        } finally {
          controller.signal.removeEventListener("abort", link);
        }
        continue;
      } finally {
        controller.signal.removeEventListener("abort", link);
        attemptController.abort();
      }
    }
  } finally {
    clearTimeout(total);
    req.signal.removeEventListener("abort", onCallerAbort);
    release?.();
    controller.abort(); // the consumer may have stopped early: cancel the request and free the socket
  }
}

function signalError(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError ? signal.reason : abortedError(signal);
}

function toProviderError(e: unknown, signal: AbortSignal): ProviderError {
  if (e instanceof ProviderError) return e;
  if (signal.aborted) return signalError(signal);
  return new ProviderError({ kind: "protocol", message: `unexpected failure: ${errorText(e)}`, cause: e });
}

/** Hooks are observers: whatever they do, they cannot break a request. */
function safely(f: () => void): void {
  try {
    f();
  } catch {
    /* ignored by design */
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function viewHeaders(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SENSITIVE_HEADERS.test(k) ? "[redacted]" : v]));
}

async function failure<S>(mapper: HttpMapper<S>, res: Response, scrub: (s: string) => string): Promise<ProviderError> {
  let text = "";
  try {
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let size = 0;
    while (reader !== undefined && size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      text += dec.decode(value, { stream: true });
    }
    await reader?.cancel().catch(() => undefined);
  } catch {
    /* an unreadable body is still an error status */
  }
  const base = classifyStatus(res.status);
  const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
  const override = mapper.classify?.({ status: res.status, headers: res.headers, body: text });
  const message = override?.message ?? `HTTP ${res.status}${text === "" ? "" : `: ${scrub(text).slice(0, 2000)}`}`;
  return new ProviderError({ ...base, ...override, message: scrub(message), status: res.status, ...(retryAfterMs === undefined && override?.retryAfterMs === undefined ? {} : { retryAfterMs: override?.retryAfterMs ?? (retryAfterMs as number) }) });
}

/** Pass chunks through; if none arrives within `idleMs`, abort the request with a timeout error. */
async function* idleGuarded(body: ReadableStream<Uint8Array>, idleMs: number, controller: AbortController): AsyncGenerator<Uint8Array, void, void> {
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new ProviderError({ kind: "timeout", message: `no data for ${idleMs} ms`, retryable: true });
          controller.abort(err);
          reject(err);
        }, idleMs);
      });
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await Promise.race([reader.read(), timeout]);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (controller.signal.aborted) throw signalError(controller.signal);
        throw new ProviderError({ kind: "network", message: `the connection failed: ${errorText(e)}`, retryable: true, cause: e });
      } finally {
        clearTimeout(timer);
      }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}


/**
 * One JSON request, no streaming, no retry: for the small calls an adapter makes beside its main one (counting tokens).
 * Credentials come from `opts.auth`, secrets are scrubbed from errors, and failures are classified as for a stream
 * (`classify` may refine them). The caller's signal and the total timeout both cancel it.
 */
export async function jsonRequest(
  spec: HttpRequestSpec,
  opts: HttpOptions,
  extra: { signal: AbortSignal; classify?: HttpMapper<unknown>["classify"] },
): Promise<unknown> {
  const secrets = new Set((opts.secrets ?? []).filter((s) => s.length > 0));
  const authHeaders = (await opts.auth?.(spec)) ?? {};
  const headers = { ...requestHeaders(spec.headers, opts), ...authHeaders };
  for (const v of Object.values(authHeaders)) {
    if (v.length === 0) continue;
    secrets.add(v);
    const bare = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v)?.[1];
    if (bare !== undefined) secrets.add(bare);
  }
  const scrub = (t: string): string => [...secrets].reduce((acc, k) => acc.split(k).join("[redacted]"), t);
  const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(opts.timeouts?.totalMs ?? 60_000)]);
  const method = spec.method ?? "POST";
  const body = spec.body === undefined ? undefined : typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(spec.url, { method, headers, ...(body === undefined ? {} : { body }), signal });
  } catch (e) {
    throw new ProviderError({ kind: extra.signal.aborted ? "aborted" : signal.aborted ? "timeout" : "network", message: scrub(`request failed: ${errorText(e)}`), retryable: !signal.aborted, cause: e });
  }
  const text = await res.text();
  if (!res.ok) {
    const c = extra.classify?.({ status: res.status, headers: res.headers, body: text });
    throw new ProviderError({ ...classifyStatus(res.status), ...c, message: scrub(c?.message ?? `HTTP ${res.status}: ${text.slice(0, 500)}`), status: res.status });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError({ kind: "protocol", message: "the response is not JSON" });
  }
}
