/**
 * Talking to llama-server for completions: `/completion` with a prompt a `CompletionFormat` wrote, and `/infill`, where the server writes
 * the prompt from the model's own fill-in-the-middle tokens. The two are kept side by side so that what each does for a model can be
 * measured (`tools/completion-bench.ts`). Neither streams: a completion is short, and what matters is the time the server reports.
 */
import { jsonOr, type Json } from "../wire.ts";
import type { FimRequest, RenderedCompletion } from "./format.ts";

export type Transport = "completion" | "infill";

export interface CompleteOptions {
  /** The server's address, without a path. */
  baseUrl: string;
  /** The model's name, for a server in router mode. */
  model?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** Tokens to write at most (default 128). */
  maxTokens?: number | undefined;
  /** Default 0: a completion should be the same each time it is asked. */
  temperature?: number | undefined;
  /** Whether the server may reuse the start of the last prompt (default true). */
  cachePrompt?: boolean | undefined;
  /** Default 60 s. */
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** More sampler fields, which never replace the prompt. */
  extra?: Record<string, unknown> | undefined;
}

/** What the server says about the time and the tokens, and the time on this side of the request. */
export interface Timings {
  promptTokens?: number | undefined;
  /** Prompt tokens the server did not have to evaluate again. */
  cachedTokens?: number | undefined;
  promptMs?: number | undefined;
  generatedTokens?: number | undefined;
  generatedMs?: number | undefined;
  totalMs: number;
}

export interface CompletionResult {
  /** What the model wrote. */
  text: string;
  /** `eos`, `word`, `limit`: why it stopped, as the server says. */
  stopType?: string | undefined;
  timings: Timings;
}

/** The server refused or could not do the request; `status` is the HTTP status when there was one. */
export class CompletionError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CompletionError";
    this.status = status;
  }
}

const OWNED = new Set(["model", "prompt", "stream", "n_predict", "stop", "input_prefix", "input_suffix", "input_extra"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function post(path: string, body: Record<string, unknown>, o: CompleteOptions): Promise<CompletionResult> {
  const doFetch = o.fetch ?? fetch;
  const started = performance.now();
  const signals = [AbortSignal.timeout(o.timeoutMs ?? 60_000), ...(o.signal === undefined ? [] : [o.signal])];
  let res: Response;
  try {
    res = await doFetch(`${o.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    throw new CompletionError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const raw = await res.text();
  const totalMs = performance.now() - started;
  let json: Json = {};
  try {
    json = jsonOr(JSON.parse(raw));
  } catch {
    // Not JSON: the status and the text say what happened.
  }
  if (!res.ok) {
    const err = jsonOr(json["error"]);
    const message = typeof err["message"] === "string" ? err["message"] : raw.slice(0, 200);
    throw new CompletionError(`${path}: ${res.status} ${message}`, res.status);
  }
  const t = jsonOr(json["timings"]);
  return {
    text: typeof json["content"] === "string" ? json["content"] : "",
    stopType: typeof json["stop_type"] === "string" ? json["stop_type"] : undefined,
    timings: {
      promptTokens: num(t["prompt_n"]) ?? num(json["tokens_evaluated"]),
      cachedTokens: num(t["cache_n"]) ?? num(json["tokens_cached"]),
      promptMs: num(t["prompt_ms"]),
      generatedTokens: num(t["predicted_n"]),
      generatedMs: num(t["predicted_ms"]),
      totalMs,
    },
  };
}

function sampler(o: CompleteOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    stream: false,
    cache_prompt: o.cachePrompt ?? true,
    n_predict: o.maxTokens ?? 128,
    temperature: o.temperature ?? 0,
  };
  if (o.model !== undefined) body["model"] = o.model;
  for (const [k, v] of Object.entries(o.extra ?? {})) if (!OWNED.has(k)) body[k] = v;
  return body;
}

/** A prompt a format wrote, through `/completion`. */
export function completeRaw(rendered: RenderedCompletion, o: CompleteOptions): Promise<CompletionResult> {
  const body = { ...sampler(o), prompt: rendered.prompt };
  if (rendered.stop.length > 0) Object.assign(body, { stop: rendered.stop });
  return post("/completion", body, o);
}

/**
 * The same request through `/infill`: the server puts the sentinels in, in the order the model's own metadata says. It answers 501 for a model
 * with no fill-in-the-middle tokens, which comes back as a `CompletionError` with that status.
 */
export function completeInfill(req: FimRequest, o: CompleteOptions): Promise<CompletionResult> {
  const body = {
    ...sampler(o),
    input_prefix: req.prefix,
    input_suffix: req.suffix,
    ...((req.files ?? []).length > 0 ? { input_extra: (req.files ?? []).map((f) => ({ filename: f.path, text: f.text })) } : {}),
  };
  return post("/infill", body, o);
}
