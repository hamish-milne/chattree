import { z } from "zod";
import type { Block, ModelContext, Turn } from "../harness/context-builder.ts";
import type { ToolDefinition } from "../harness/definitions.ts";
import { servedModelId, stable, type AgentSetup, type Change } from "../harness/setup.ts";
import { defineAdapter, commonProviderFields, envName, httpOptionsFor, modelsFor, pricesFor } from "./registry.ts";
import { httpStream, type HttpMapper, type HttpOptions, type HttpRequestSpec } from "./http.ts";
import type { SseEvent } from "./sse.ts";
import { ProviderError, type Completed, type ErrorKind, type ProviderAdapter, type StreamEvent, type StreamRequest, type Usage } from "./types.ts";

/**
 * The Chat Completions API as llama-server, Ollama, vLLM, LM Studio and similar servers speak it (docs/providers.md,
 * step 8). It is stateless and has no cache control, no storage and no retrieval: every request replays the context.
 *
 * Wire facts relied on, from OpenAI's documentation and from what these servers are known to do (checked live against
 * Ollama only; llama-server, vLLM and LM Studio are from memory): `data:` chunks whose `choices[0].delta` carries
 * `content`, a reasoning field (`reasoning_content` in llama-server and vLLM, `reasoning` in Ollama), and `tool_calls`
 * fragments keyed by `index` (the id and name in the first, `function.arguments` in pieces); `finish_reason` on the
 * last choice chunk; a final chunk with `usage` and no choices when `stream_options.include_usage` is set; `data: [DONE]`.
 * Servers differ in small ways, so the mapper is lenient: a missing tool call id is made up, `arguments` may be an
 * object, a finished tool call is `tool_use` whatever `finish_reason` says (Ollama says `stop`).
 */

// ---- settings -------------------------------------------------------------------------------------------------

export const compatibleSettings = z.strictObject({
  /** Per-request cap on output, reasoning included (sent as `max_tokens`, or the parameter the provider config names). Required: the cost limit is computed from it. */
  max_output_tokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.array(z.string().min(1)).max(4).optional(),
  seed: z.number().int().optional(),
  /** `reasoning_effort`, for servers and models that take it. Changing it changes what the server computes, so it counts as a cache break. */
  reasoning_effort: z.string().min(1).optional(),
  /**
   * Send the model's earlier reasoning back (as `reasoning_content`) with each assistant message. Default false: most
   * chat templates drop it, and a few (those that expect it next to tool calls) need it.
   */
  replay_reasoning: z.boolean().optional(),
  /** Extra top-level request fields for server extensions (`top_k`, `min_p`, `chat_template_kwargs`, Ollama's `think`). Cannot override the fields the adapter owns. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type CompatibleSettings = z.infer<typeof compatibleSettings>;

export function parseCompatibleSettings(settings: unknown): CompatibleSettings {
  const r = compatibleSettings.safeParse(settings ?? {});
  if (!r.success) throw new ProviderError({ kind: "invalid_request", message: `invalid model settings for this provider: ${r.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ")}` });
  return r.data;
}

// ---- request --------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const OWNED = new Set(["model", "messages", "tools", "stream", "stream_options", "max_tokens", "max_completion_tokens", "tool_choice"]);

export interface RequestOptions {
  /** The name of the output cap parameter. Servers want `max_tokens`; OpenAI's newer models want `max_completion_tokens`. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** Ask for a usage chunk at the end (`stream_options.include_usage`). */
  includeUsage: boolean;
}

/** The JSON body of a Chat Completions request for a context. Pure. */
export function buildChatBody(ctx: ModelContext, setup: AgentSetup, opts: RequestOptions): Json {
  if (setup.model === undefined) throw new ProviderError({ kind: "invalid_request", message: "the agent has no model" });
  const s = parseCompatibleSettings(setup.model.settings);
  const body: Json = { model: servedModelId(setup.model), stream: true, [opts.maxTokensParam]: s.max_output_tokens };
  if (opts.includeUsage) body["stream_options"] = { include_usage: true };
  body["messages"] = toMessages(ctx, s.replay_reasoning === true);
  if (ctx.tools.length > 0) body["tools"] = ctx.tools.map(toTool);
  for (const k of ["temperature", "top_p", "stop", "seed", "reasoning_effort"] as const) if (s[k] !== undefined) body[k] = s[k];
  for (const [k, v] of Object.entries(s.extra ?? {})) if (!OWNED.has(k)) body[k] = v;
  return body;
}

const toTool = (t: ToolDefinition): Json => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } });

function toMessages(ctx: ModelContext, replayReasoning: boolean): Json[] {
  const out: Json[] = [];
  const system = [ctx.system, ctx.instructions ?? ""].filter((x) => x !== "").join("\n\n");
  if (system !== "") out.push({ role: "system", content: system });
  for (const t of ctx.turns as readonly Turn[]) {
    if (t.role === "user") {
      const parts = t.parts.map((p) => {
        if (p.type === "text") return p.text;
        throw new ProviderError({ kind: "invalid_request", message: "attachments are not supported by this adapter yet" });
      });
      out.push({ role: "user", content: parts.join("\n\n") });
    } else if (t.role === "tool_results") {
      for (const r of t.results) out.push({ role: "tool", tool_call_id: r.call_id, content: r.content });
    } else {
      const text = t.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = t.blocks.flatMap((b) => (b.type === "tool_call" ? [{ id: b.call_id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.args) } }] : []));
      const reasoning = replayReasoning ? t.blocks.flatMap((b) => (b.type === "reasoning" && b.visible !== undefined && b.visible !== "" ? [b.visible] : [])).join("") : "";
      if (text === "" && calls.length === 0) continue;
      out.push({ role: "assistant", content: text === "" ? null : text, ...(reasoning === "" ? {} : { reasoning_content: reasoning }), ...(calls.length === 0 ? {} : { tool_calls: calls }) });
    }
  }
  return out;
}

// ---- stream ---------------------------------------------------------------------------------------------------

type Open =
  | { kind: "text"; index: number; text: string }
  | { kind: "reasoning"; index: number; text: string; field: string }
  | { kind: "tool"; index: number; id: string; name: string; args: string };

interface State {
  provider: string;
  id: string | undefined;
  model: string | undefined;
  started: boolean;
  announced: boolean;
  next: number;
  text: Open | undefined;
  reasoning: Open | undefined;
  tools: Map<number, Open>;
  out: Block[];
  finish: string | undefined;
  refused: boolean;
  sawTool: boolean;
  raw: { prompt: number; completion: number; cached: number | undefined; reasoning: number | undefined };
  usage: Usage;
  hasUsage: boolean;
  done: boolean;
}

const ERROR_KINDS: Record<string, { kind: ErrorKind; retryable: boolean }> = {
  rate_limit_exceeded: { kind: "rate_limit", retryable: true },
  rate_limit_error: { kind: "rate_limit", retryable: true },
  insufficient_quota: { kind: "auth", retryable: false },
  invalid_api_key: { kind: "auth", retryable: false },
  authentication_error: { kind: "auth", retryable: false },
  context_length_exceeded: { kind: "invalid_request", retryable: false },
  exceed_context_size_error: { kind: "invalid_request", retryable: false },
  invalid_request_error: { kind: "invalid_request", retryable: false },
  server_error: { kind: "server", retryable: true },
  overloaded_error: { kind: "overloaded", retryable: true },
  unavailable_error: { kind: "overloaded", retryable: true },
};

const FINISH: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const protocol = (message: string): ProviderError => new ProviderError({ kind: "protocol", message });

/** What an error body or event says: `{error: {message, type, code}}`, or a bare string. */
function errorFrom(d: unknown): { kind: ErrorKind; retryable: boolean; message: string } {
  const e = (typeof d === "object" && d !== null ? ((d as Json)["error"] ?? d) : d) as Json | string;
  if (typeof e === "string") return { kind: "server", retryable: false, message: e };
  const code = typeof e["code"] === "string" ? e["code"] : undefined;
  const type = typeof e["type"] === "string" ? e["type"] : undefined;
  const known = (code === undefined ? undefined : ERROR_KINDS[code]) ?? (type === undefined ? undefined : ERROR_KINDS[type]) ?? { kind: "server" as const, retryable: false };
  return { ...known, message: `${code ?? type ?? "error"}: ${String(e["message"] ?? "")}` };
}

function updateUsage(s: State, raw: Json): void {
  s.hasUsage = true;
  // Take the largest figure seen for each count, so that servers that report running totals, or revise one, never make usage go down.
  const prompt = num(raw["prompt_tokens"]);
  const completion = num(raw["completion_tokens"]);
  const cached = num((raw["prompt_tokens_details"] as Json | undefined)?.["cached_tokens"]);
  const reasoning = num((raw["completion_tokens_details"] as Json | undefined)?.["reasoning_tokens"]);
  if (prompt !== undefined) s.raw.prompt = Math.max(s.raw.prompt, prompt);
  if (completion !== undefined) s.raw.completion = Math.max(s.raw.completion, completion);
  if (cached !== undefined) s.raw.cached = Math.max(s.raw.cached ?? 0, cached);
  if (reasoning !== undefined) s.raw.reasoning = Math.max(s.raw.reasoning ?? 0, reasoning);
  const cachedRead = Math.min(s.raw.cached ?? 0, s.raw.prompt);
  s.usage = {
    input_tokens: s.raw.prompt - cachedRead, // OpenAI counts cached tokens inside prompt_tokens; ours are disjoint
    output_tokens: s.raw.completion,
    ...(s.raw.cached === undefined ? {} : { cache_read_tokens: cachedRead }),
    ...(s.raw.reasoning === undefined ? {} : { reasoning_tokens: s.raw.reasoning }),
    raw: { ...s.usage.raw, ...raw },
  };
}

const usageEvent = (u: Usage): StreamEvent => ({ type: "usage", usage: { ...u, ...(u.raw === undefined ? {} : { raw: { ...u.raw } }) } });

function close(o: Open | undefined, s: State, events: StreamEvent[]): void {
  if (o === undefined) return;
  let block: Block;
  if (o.kind === "text") block = { type: "text", text: o.text };
  else if (o.kind === "reasoning") block = { type: "reasoning", provider: s.provider, payload: JSON.stringify({ [o.field]: o.text }), visible: o.text };
  else {
    try {
      const parsed: unknown = o.args === "" ? {} : JSON.parse(o.args);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      block = { type: "tool_call", call_id: o.id, name: o.name, args: parsed as Json };
    } catch {
      block = { type: "tool_call", call_id: o.id, name: o.name, args: {}, args_raw: o.args };
    }
  }
  s.out[o.index] = block;
  events.push({ type: "block.done", index: o.index, block });
}

export function chatMapper(baseUrl: string, request: RequestOptions): HttpMapper<State> {
  return {
    request(req: StreamRequest): HttpRequestSpec {
      return { url: `${baseUrl.replace(/\/$/, "")}/chat/completions`, headers: { "content-type": "application/json", accept: "text/event-stream" }, body: buildChatBody(req.context, req.setup, request) };
    },
    start: (req) => ({
      provider: req.setup.model?.provider ?? "openai-compatible",
      id: undefined,
      model: undefined,
      started: false,
      announced: false,
      next: 0,
      text: undefined,
      reasoning: undefined,
      tools: new Map(),
      out: [],
      finish: undefined,
      refused: false,
      sawTool: false,
      raw: { prompt: 0, completion: 0, cached: undefined, reasoning: undefined },
      usage: { input_tokens: 0, output_tokens: 0 },
      hasUsage: false,
      done: false,
    }),
    event(sse: SseEvent, s: State): StreamEvent[] {
      const data = sse.data.trim();
      if (data === "") return [];
      if (data === "[DONE]") {
        s.done = true;
        const events: StreamEvent[] = [];
        // A server that ends without a finish chunk after real output is treated as having stopped normally.
        close(s.reasoning, s, events);
        close(s.text, s, events);
        for (const t of s.tools.values()) close(t, s, events);
        s.reasoning = s.text = undefined;
        s.tools.clear();
        // Usage is reported once, here. Chunks may carry running totals or revise a count (more cache hits lower the uncached
        // input), and an event cannot be taken back, so only the final figure is sent as an event.
        if (s.hasUsage) events.push(usageEvent(s.usage));
        return events;
      }
      let d: Json;
      try {
        d = JSON.parse(data) as Json;
      } catch {
        throw protocol("malformed chunk");
      }
      if (d["error"] !== undefined && d["error"] !== null) throw new ProviderError(errorFrom(d));
      const events: StreamEvent[] = [];
      if (!s.started) {
        s.started = true;
        events.push({ type: "started" });
      }
      if (typeof d["id"] === "string" && s.id === undefined) s.id = d["id"];
      if (typeof d["model"] === "string" && s.model === undefined) s.model = d["model"];
      if (!s.announced && (s.id !== undefined || s.model !== undefined)) {
        s.announced = true;
        events.push({ type: "observed", observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) } });
      }

      const choice = (Array.isArray(d["choices"]) ? d["choices"][0] : undefined) as Json | undefined;
      const delta = (choice?.["delta"] ?? {}) as Json;

      const reasoningField = typeof delta["reasoning_content"] === "string" && delta["reasoning_content"] !== "" ? "reasoning_content" : typeof delta["reasoning"] === "string" && delta["reasoning"] !== "" ? "reasoning" : undefined;
      if (reasoningField !== undefined) {
        const t = delta[reasoningField] as string;
        if (s.reasoning === undefined) s.reasoning = { kind: "reasoning", index: s.next++, text: "", field: reasoningField };
        if (s.reasoning.kind === "reasoning") s.reasoning.text += t;
        events.push({ type: "reasoning.delta", index: s.reasoning.index, text: t });
      }
      const content = typeof delta["content"] === "string" && delta["content"] !== "" ? delta["content"] : typeof delta["refusal"] === "string" && delta["refusal"] !== "" ? ((s.refused = true), delta["refusal"] as string) : undefined;
      if (content !== undefined) {
        close(s.reasoning, s, events); // the model has moved on from thinking
        s.reasoning = undefined;
        if (s.text === undefined) s.text = { kind: "text", index: s.next++, text: "" };
        if (s.text.kind === "text") s.text.text += content;
        events.push({ type: "text.delta", index: s.text.index, text: content });
      }
      const calls = delta["tool_calls"];
      if (Array.isArray(calls)) {
        close(s.reasoning, s, events);
        close(s.text, s, events);
        s.reasoning = s.text = undefined;
        for (const c of calls as Json[]) {
          const k = num(c["index"]) ?? 0;
          const fn = (c["function"] ?? {}) as Json;
          let o = s.tools.get(k);
          const name = typeof fn["name"] === "string" && fn["name"] !== "" ? fn["name"] : undefined;
          if (o === undefined) {
            if (name === undefined) continue; // fragments before the name is known cannot start a call; servers send both together
            const id = typeof c["id"] === "string" && c["id"] !== "" ? c["id"] : `call_${s.id ?? "x"}_${k}`;
            o = { kind: "tool", index: s.next++, id, name, args: "" };
            s.tools.set(k, o);
            s.sawTool = true;
            events.push({ type: "tool_call.start", index: o.index, call_id: id, name });
          }
          const args = typeof fn["arguments"] === "string" ? fn["arguments"] : fn["arguments"] !== undefined && fn["arguments"] !== null ? JSON.stringify(fn["arguments"]) : "";
          if (args !== "" && o.kind === "tool") {
            o.args += args;
            events.push({ type: "tool_call.delta", index: o.index, args_delta: args });
          }
        }
      }
      if (typeof choice?.["finish_reason"] === "string") {
        s.finish = choice["finish_reason"];
        close(s.reasoning, s, events);
        close(s.text, s, events);
        for (const t of s.tools.values()) close(t, s, events);
        s.reasoning = s.text = undefined;
        s.tools.clear();
      }
      if (typeof d["usage"] === "object" && d["usage"] !== null) {
        updateUsage(s, d["usage"] as Json);
      }
      return events;
    },
    done: (s) => s.done,
    finish(s): Completed {
      const blocks = s.out.filter((b): b is Block => b !== undefined);
      const stop = s.sawTool ? "tool_use" : s.refused ? "refusal" : s.finish === undefined ? "end_turn" : (FINISH[s.finish] ?? s.finish);
      return {
        blocks,
        stop_reason: stop,
        usage: s.usage,
        observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) },
        ...(s.hasUsage ? {} : { ext: { usage_reported: false } }),
      };
    },
    classify({ status, body }) {
      try {
        const e = errorFrom(JSON.parse(body));
        return { ...(e.message === ": " ? {} : { message: `${status} ${e.message}` }), ...(e.kind === "server" && !e.retryable ? {} : { kind: e.kind, retryable: e.retryable }) };
      } catch {
        return undefined;
      }
    },
  };
}

// ---- adapter --------------------------------------------------------------------------------------------------

export interface CompatibleOptions {
  /** Where the server is, including the `/v1` its API lives under (`http://localhost:11434/v1`). */
  baseUrl: string;
  /** The API key, or a function that returns it (sent as a bearer token). Omit for local servers that need none. */
  apiKey?: string | (() => string | Promise<string>);
  /** Default `max_tokens`. */
  maxTokensParam?: RequestOptions["maxTokensParam"];
  /** Ask for the final usage chunk. Default true; turn off for a server that rejects `stream_options`. */
  includeUsage?: boolean;
  http?: HttpOptions;
}

export function openaiCompatibleAdapter(opts: CompatibleOptions): ProviderAdapter {
  const mapper = chatMapper(opts.baseUrl, { maxTokensParam: opts.maxTokensParam ?? "max_tokens", includeUsage: opts.includeUsage ?? true });
  const http: HttpOptions = {
    ...opts.http,
    auth: async (spec) => {
      const base = (await opts.http?.auth?.(spec)) ?? {};
      if (opts.apiKey === undefined) return base;
      const key = typeof opts.apiKey === "string" ? opts.apiKey : await opts.apiKey();
      return { ...base, authorization: `Bearer ${key}` };
    },
  };
  return { $tag: "openai-compatible", stream: (req) => httpStream(mapper, req, http), classify: classifyCompatible };
}

// ---- registration -----------------------------------------------------------------------------------------------

const compatibleProviderConfig = z.strictObject({
  $tag: z.literal("openai-compatible"),
  /** Where the server is, including `/v1`. Required: there is no sensible default, and guessing could send a conversation to the wrong place. */
  base_url: z.string().url(),
  /** The NAME of the environment variable holding the key. Omit for a server that needs none. */
  api_key_env: envName.optional(),
  max_tokens_param: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  /** `false` for a server that rejects `stream_options` (usage is then not reported, and costs show as unknown unless the provider is marked `pricing: {free: true}`). */
  include_usage: z.boolean().optional(),
  ...commonProviderFields,
});

export const openaiCompatibleDefinition = defineAdapter({
  $tag: "openai-compatible",
  config: compatibleProviderConfig,
  settings: compatibleSettings,
  jsonSchema: () => ({ config: z.toJSONSchema(compatibleProviderConfig, { io: "input" }), settings: z.toJSONSchema(compatibleSettings, { io: "input" }) }),
  secrets: (c) => (c.api_key_env === undefined ? [] : [c.api_key_env]),
  prices: (c) => pricesFor(undefined, c),
  models: (c) => modelsFor(undefined, c),
  create: (c, secrets) => {
    const key = c.api_key_env === undefined ? undefined : secrets.get(c.api_key_env);
    return openaiCompatibleAdapter({
      baseUrl: c.base_url,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(c.max_tokens_param === undefined ? {} : { maxTokensParam: c.max_tokens_param }),
      ...(c.include_usage === undefined ? {} : { includeUsage: c.include_usage }),
      http: httpOptionsFor(c),
    });
  },
});

/** What a setup change does. A local server's prompt cache is per model and per prompt prefix, so the same things break it. */
export function classifyCompatible(from: AgentSetup, to: AgentSetup): Change[] {
  const out: Change[] = [];
  const f = from.model;
  const t = to.model;
  if (f !== undefined && t !== undefined) {
    const fs = (f.settings ?? {}) as Json;
    const ts = (t.settings ?? {}) as Json;
    if (f.id !== t.id || (f.resolved ?? f.id) !== (t.resolved ?? t.id)) out.push({ kind: "cache_break", message: "a server's prompt cache belongs to the loaded model: the conversation is processed again" });
    else if (["reasoning_effort", "replay_reasoning"].some((k) => stable(fs[k] ?? null) !== stable(ts[k] ?? null))) out.push({ kind: "cache_break", message: "changing reasoning settings changes the prompt the server sees" });
  }
  if (from.model !== undefined && (stable(from.tools) !== stable(to.tools) || stable(from.instructions ?? null) !== stable(to.instructions ?? null) || (from.renderer ?? null) !== (to.renderer ?? null))) {
    out.push({ kind: "cache_break", message: "instructions, tools and rendering come before the conversation in the cached prefix" });
  }
  return out;
}
