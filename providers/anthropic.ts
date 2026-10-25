import { z } from "zod";
import type { Block, ModelContext, Turn } from "../harness/context-builder.ts";
import type { ToolDefinition } from "../harness/definitions.ts";
import { servedModelId, stable, type AgentSetup, type Change } from "../harness/setup.ts";
import { defineAdapter, commonProviderFields, envName, httpOptionsFor, modelsFor, pricesFor } from "./registry.ts";
import { ANTHROPIC_MODELS, ANTHROPIC_PRICES } from "./pricing-data.ts";
import { httpStream, jsonRequest, type HttpMapper, type HttpOptions, type HttpRequestSpec } from "./http.ts";
import type { SseEvent } from "./sse.ts";
import { ProviderError, type Completed, type ErrorKind, type ProviderAdapter, type StreamEvent, type StreamRequest, type Usage } from "./types.ts";

/**
 * The Anthropic Messages API (docs/providers.md). Also what Ollama and other servers speak as their
 * "Anthropic-compatible" API; `cacheControl` and `authorization` adapt to them. Wire facts that were checked
 * against Anthropic's streaming documentation: the event flow and shapes, cumulative `message_delta` usage,
 * `signature_delta` before a thinking block's stop, tool input as concatenated `input_json_delta` parsed at the
 * block's stop, `error` events, and that thinking blocks must be replayed complete and unmodified. From memory and
 * not yet checked: the request shapes for system blocks and `cache_control`, and which breakpoints are allowed.
 */

// ---- settings -------------------------------------------------------------------------------------------------

const display = z.enum(["summarized", "omitted"]).optional();
/** What an agent's `model.settings` may hold for this provider. Unknown keys are refused: a typo here costs money. */
export const anthropicSettings = z.strictObject({
  /** Per-request cap on output, thinking included. Required: the cost limit is computed from it. */
  max_output_tokens: z.number().int().positive(),
  thinking: z
    .discriminatedUnion("type", [
      z.strictObject({ type: z.literal("adaptive"), display }),
      z.strictObject({ type: z.literal("enabled"), budget_tokens: z.number().int().positive(), display }),
      z.strictObject({ type: z.literal("disabled") }),
    ])
    .optional(),
  /** `output_config.effort`; the accepted names depend on the model. Changing it invalidates the prompt cache. */
  effort: z.string().min(1).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  stop_sequences: z.array(z.string().min(1)).optional(),
  /**
   * How long the prompt cache lives after each use: `5m` (the default, writes cost 1.25x input) or `1h` (writes cost 2x).
   * Reads cost the same either way. Use `1h` when the gaps between requests are longer than five minutes.
   */
  cache_ttl: z.enum(["5m", "1h"]).optional(),
});
export type AnthropicSettings = z.infer<typeof anthropicSettings>;

export function parseAnthropicSettings(settings: unknown): AnthropicSettings {
  const r = anthropicSettings.safeParse(settings ?? {});
  if (!r.success) throw new ProviderError({ kind: "invalid_request", message: `invalid model settings for this provider: ${r.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ")}` });
  return r.data;
}

// ---- request --------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
/** The cache marker for a lifetime: 5 minutes is the default and is left out, as the docs show. */
const cacheMark = (ttl: "5m" | "1h" | undefined): Json => (ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });

export interface RequestOptions {
  /** Mark the end of the pinned prefix and of recent exchanges as cache breakpoints. Default: only for api.anthropic.com. */
  cacheControl: boolean;
}

/** The JSON body of a Messages request for a context. Pure. */
export function buildAnthropicBody(ctx: ModelContext, setup: AgentSetup, opts: RequestOptions): Json {
  if (setup.model === undefined) throw new ProviderError({ kind: "invalid_request", message: "the agent has no model" });
  const settings = parseAnthropicSettings(setup.model.settings);
  const body: Json = { model: servedModelId(setup.model), max_tokens: settings.max_output_tokens, stream: true };

  const system: Json[] = [];
  if (ctx.system !== "") system.push({ type: "text", text: ctx.system });
  if (ctx.instructions !== undefined && ctx.instructions !== "") system.push({ type: "text", text: ctx.instructions });
  if (system.length > 0) {
    if (opts.cacheControl) (system[system.length - 1] as Json)["cache_control"] = cacheMark(settings.cache_ttl);
    body["system"] = system;
  }
  if (ctx.tools.length > 0) body["tools"] = ctx.tools.map(toTool);
  body["messages"] = toMessages(ctx.turns, ctx.cacheHints, opts.cacheControl ? cacheMark(settings.cache_ttl) : undefined);

  if (settings.thinking !== undefined) body["thinking"] = settings.thinking;
  if (settings.effort !== undefined) body["output_config"] = { effort: settings.effort };
  for (const k of ["temperature", "top_p", "top_k", "stop_sequences"] as const) if (settings[k] !== undefined) body[k] = settings[k];
  return body;
}

const toTool = (t: ToolDefinition): Json => ({ name: t.name, description: t.description, input_schema: t.input_schema });

function toMessages(turns: readonly Turn[], hints: readonly number[], cache: Json | undefined): Json[] {
  const messages: { role: "user" | "assistant"; content: Json[]; turns: number[] }[] = [];
  const push = (role: "user" | "assistant", content: Json[], turn: number): void => {
    const last = messages.at(-1);
    if (last?.role === role) {
      last.content.push(...content);
      last.turns.push(turn);
    } else messages.push({ role, content, turns: [turn] });
  };
  turns.forEach((t, i) => {
    if (t.role === "user") {
      push("user", t.parts.map((p): Json => {
        if (p.type === "text") return { type: "text", text: p.text };
        throw new ProviderError({ kind: "invalid_request", message: "attachments are not supported by this adapter yet" });
      }), i);
    } else if (t.role === "tool_results") {
      push("user", t.results.map((r): Json => ({ type: "tool_result", tool_use_id: r.call_id, content: r.content, ...(r.is_error ? { is_error: true } : {}) })), i);
    } else {
      const content = t.blocks.flatMap((b): Json[] => {
        if (b.type === "text") return b.text === "" ? [] : [{ type: "text", text: b.text }];
        if (b.type === "tool_call") return [{ type: "tool_use", id: b.call_id, name: b.name, input: b.args }];
        if (b.type === "provider_compaction") return []; // another provider's opaque state: never ours to send
        const original = parseOriginal(b.payload);
        return original === undefined ? [] : [original];
      });
      if (content.length > 0) push("assistant", content, i);
    }
  });
  if (cache !== undefined) {
    // Breakpoints at the ends of the turns the context builder named, as far as the provider allows (system takes one of four).
    for (const h of hints.slice(-2)) {
      const m = messages.find((x) => x.turns.includes(h));
      const last = m?.content.at(-1);
      if (last !== undefined && last["type"] !== "thinking" && last["type"] !== "redacted_thinking") last["cache_control"] = cache;
    }
  }
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** A thinking block is stored as the provider's own block, as JSON, and replayed exactly. */
function parseOriginal(payload: string): Json | undefined {
  try {
    const v = JSON.parse(payload) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

// ---- stream ---------------------------------------------------------------------------------------------------

type Open =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string; extra: Json }
  | { kind: "redacted"; block: Json }
  | { kind: "tool"; id: string; name: string; args: string }
  | { kind: "skip" };

interface State {
  provider: string;
  id: string | undefined;
  model: string | undefined;
  usage: Usage;
  open: Map<number, Open>;
  out: Block[];
  stop: string | undefined;
  done: boolean;
  skipped: Set<string>;
}

const ERROR_TYPES: Record<string, { kind: ErrorKind; retryable: boolean }> = {
  overloaded_error: { kind: "overloaded", retryable: true },
  rate_limit_error: { kind: "rate_limit", retryable: true },
  api_error: { kind: "server", retryable: true },
  timeout_error: { kind: "server", retryable: true },
  invalid_request_error: { kind: "invalid_request", retryable: false },
  request_too_large: { kind: "invalid_request", retryable: false },
  not_found_error: { kind: "invalid_request", retryable: false },
  authentication_error: { kind: "auth", retryable: false },
  permission_error: { kind: "auth", retryable: false },
  billing_error: { kind: "auth", retryable: false },
};

const STOP_REASONS: Record<string, string> = { end_turn: "end_turn", stop_sequence: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", refusal: "refusal", pause_turn: "pause" };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function mergeUsage(into: Usage, raw: Json | undefined): void {
  if (raw === undefined) return;
  const input = num(raw["input_tokens"]);
  const out = num(raw["output_tokens"]);
  const read = num(raw["cache_read_input_tokens"]);
  const write = num(raw["cache_creation_input_tokens"]);
  const thinking = num((raw["output_tokens_details"] as Json | undefined)?.["thinking_tokens"]);
  if (input !== undefined) into.input_tokens = input;
  if (out !== undefined) into.output_tokens = Math.max(into.output_tokens, out);
  if (read !== undefined) into.cache_read_tokens = read;
  if (write !== undefined) into.cache_write_tokens = write;
  // `cache_creation` splits the writes by lifetime (from memory of the docs: ephemeral_5m_ and ephemeral_1h_input_tokens).
  const created = raw["cache_creation"] as Json | undefined;
  if (created !== undefined && typeof created === "object") {
    const by: Record<string, number> = {};
    const m5 = num(created["ephemeral_5m_input_tokens"]);
    const h1 = num(created["ephemeral_1h_input_tokens"]);
    if (m5 !== undefined) by["5"] = m5;
    if (h1 !== undefined) by["60"] = h1;
    if (Object.keys(by).length > 0) into.cache_write_by_minutes = by;
  }
  if (thinking !== undefined) into.reasoning_tokens = thinking;
  into.raw = { ...into.raw, ...raw };
}

const usageEvent = (u: Usage): StreamEvent => ({ type: "usage", usage: { ...u, ...(u.raw === undefined ? {} : { raw: { ...u.raw } }) } });

function protocol(message: string): ProviderError {
  return new ProviderError({ kind: "protocol", message });
}

export function anthropicMapper(baseUrl: string, version: string, betas: readonly string[], request: RequestOptions): HttpMapper<State> {
  return {
    request(req: StreamRequest): HttpRequestSpec {
      const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": version };
      if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
      return { url: `${baseUrl.replace(/\/$/, "")}/v1/messages`, headers, body: buildAnthropicBody(req.context, req.setup, request) };
    },
    start: (req) => ({ provider: req.setup.model?.provider ?? "anthropic", id: undefined, model: undefined, usage: { input_tokens: 0, output_tokens: 0 }, open: new Map(), out: [], stop: undefined, done: false, skipped: new Set() }),
    event(sse: SseEvent, s: State): StreamEvent[] {
      if (sse.event === "ping") return [];
      let d: Json;
      try {
        d = JSON.parse(sse.data) as Json;
      } catch {
        throw protocol(`malformed ${sse.event} event`);
      }
      const type = (d["type"] as string | undefined) ?? sse.event;
      switch (type) {
        case "message_start": {
          const m = (d["message"] ?? {}) as Json;
          s.id = m["id"] as string | undefined;
          s.model = m["model"] as string | undefined;
          mergeUsage(s.usage, m["usage"] as Json | undefined);
          // The usage in message_start is provisional (Ollama revises its input count, down, in the final message_delta),
          // so it is kept for the result but not reported as an event: reported usage never decreases.
          return [{ type: "started" }, { type: "observed", observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) } }];
        }
        case "content_block_start": {
          const i = d["index"] as number;
          const b = (d["content_block"] ?? {}) as Json;
          switch (b["type"]) {
            case "text":
              s.open.set(i, { kind: "text", text: typeof b["text"] === "string" ? b["text"] : "" });
              return [];
            case "thinking": {
              const { type: _t, thinking, signature, ...extra } = b;
              s.open.set(i, { kind: "thinking", thinking: typeof thinking === "string" ? thinking : "", signature: typeof signature === "string" ? signature : "", extra });
              return [];
            }
            case "redacted_thinking":
              s.open.set(i, { kind: "redacted", block: b });
              return [];
            case "tool_use":
              s.open.set(i, { kind: "tool", id: b["id"] as string, name: b["name"] as string, args: "" });
              return [{ type: "tool_call.start", index: i, call_id: b["id"] as string, name: b["name"] as string }];
            default:
              s.open.set(i, { kind: "skip" });
              s.skipped.add(String(b["type"]));
              return [];
          }
        }
        case "content_block_delta": {
          const i = d["index"] as number;
          const o = s.open.get(i);
          const delta = (d["delta"] ?? {}) as Json;
          if (o === undefined) throw protocol(`a delta for block ${i}, which was never started`);
          if (o.kind === "skip") return []; // a block type we do not use
          switch (delta["type"]) {
            case "text_delta":
              if (o.kind !== "text") throw protocol(`a text delta for block ${i}, which is not text`);
              o.text += delta["text"] as string;
              return [{ type: "text.delta", index: i, text: delta["text"] as string }];
            case "thinking_delta":
              if (o.kind !== "thinking") throw protocol(`a thinking delta for block ${i}, which is not thinking`);
              o.thinking += delta["thinking"] as string;
              return [{ type: "reasoning.delta", index: i, text: delta["thinking"] as string }];
            case "signature_delta":
              if (o.kind !== "thinking") throw protocol(`a signature for block ${i}, which is not thinking`);
              o.signature += delta["signature"] as string;
              return [];
            case "input_json_delta":
              if (o.kind !== "tool") throw protocol(`tool input for block ${i}, which is not a tool call`);
              o.args += delta["partial_json"] as string;
              return [{ type: "tool_call.delta", index: i, args_delta: delta["partial_json"] as string }];
            default:
              return []; // citations and whatever comes next
          }
        }
        case "content_block_stop": {
          const i = d["index"] as number;
          const o = s.open.get(i);
          if (o === undefined) throw protocol(`block ${i} stopped but never started`);
          s.open.delete(i);
          let block: Block;
          if (o.kind === "skip") return [];
          if (o.kind === "text") block = { type: "text", text: o.text };
          else if (o.kind === "thinking") block = { type: "reasoning", provider: s.provider, payload: JSON.stringify({ type: "thinking", thinking: o.thinking, signature: o.signature, ...o.extra }), visible: o.thinking };
          else if (o.kind === "redacted") block = { type: "reasoning", provider: s.provider, payload: JSON.stringify(o.block) };
          else {
            try {
              const parsed: unknown = o.args === "" ? {} : JSON.parse(o.args);
              if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
              block = { type: "tool_call", call_id: o.id, name: o.name, args: parsed as Json };
            } catch {
              block = { type: "tool_call", call_id: o.id, name: o.name, args: {}, args_raw: o.args };
            }
          }
          s.out[i] = block;
          return [{ type: "block.done", index: i, block }];
        }
        case "message_delta": {
          const delta = (d["delta"] ?? {}) as Json;
          if (typeof delta["stop_reason"] === "string") s.stop = STOP_REASONS[delta["stop_reason"]] ?? delta["stop_reason"];
          mergeUsage(s.usage, d["usage"] as Json | undefined);
          return [usageEvent(s.usage)];
        }
        case "message_stop":
          if (s.stop === undefined) throw protocol("the message ended without a stop reason");
          s.done = true;
          return [];
        case "error": {
          const e = (d["error"] ?? {}) as Json;
          const known = ERROR_TYPES[String(e["type"])] ?? { kind: "server" as const, retryable: false };
          throw new ProviderError({ ...known, message: `${String(e["type"])}: ${String(e["message"])}` });
        }
        default:
          return []; // tolerate event types we do not know
      }
    },
    done: (s) => s.done,
    finish(s): Completed {
      return {
        blocks: s.out.filter((b): b is Block => b !== undefined),
        stop_reason: s.stop as string,
        usage: s.usage,
        observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) },
        ...(s.skipped.size > 0 ? { ext: { skipped_block_types: [...s.skipped] } } : {}),
      };
    },
    classify({ status, body }) {
      try {
        const e = (JSON.parse(body) as Json)["error"] as Json | undefined;
        if (e === undefined || typeof e["type"] !== "string") return undefined;
        const known = ERROR_TYPES[e["type"]];
        return { ...(known === undefined ? {} : known), message: `${status} ${e["type"]}: ${String(e["message"] ?? "")}` };
      } catch {
        return undefined;
      }
    },
  };
}

// ---- adapter --------------------------------------------------------------------------------------------------

export interface AnthropicOptions {
  /** The API key, or a function that returns it (resolved for every request). Omit for servers that need none. */
  apiKey?: string | (() => string | Promise<string>);
  /** `x-api-key` (Anthropic) or `bearer` (some compatible servers and gateways). Default `x-api-key`. */
  authorization?: "x-api-key" | "bearer";
  /** Default https://api.anthropic.com. */
  baseUrl?: string;
  /** The `anthropic-version` header. Default 2023-06-01. */
  version?: string;
  /** `anthropic-beta` features to ask for. */
  betas?: readonly string[];
  /** Send `cache_control` markers. Default: only when talking to api.anthropic.com (compatible servers may reject or ignore them). */
  cacheControl?: boolean;
  http?: HttpOptions;
}

export function anthropicAdapter(opts: AnthropicOptions = {}): ProviderAdapter {
  const baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
  const cacheControl = opts.cacheControl ?? new URL(baseUrl).hostname === "api.anthropic.com";
  const mapper = anthropicMapper(baseUrl, opts.version ?? "2023-06-01", opts.betas ?? [], { cacheControl });
  const http: HttpOptions = {
    ...opts.http,
    auth: async (spec) => {
      const base = (await opts.http?.auth?.(spec)) ?? {};
      if (opts.apiKey === undefined) return base;
      const key = typeof opts.apiKey === "string" ? opts.apiKey : await opts.apiKey();
      return { ...base, ...(opts.authorization === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }) };
    },
  };
  const secrets = typeof opts.apiKey === "string" ? [opts.apiKey] : [];
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": opts.version ?? "2023-06-01", ...((opts.betas ?? []).length > 0 ? { "anthropic-beta": (opts.betas ?? []).join(",") } : {}) };
  return {
    $tag: "anthropic",
    stream: (req) => httpStream(mapper, req, http),
    async countTokens(req) {
      // POST /v1/messages/count_tokens takes the Messages request without the generation settings. No cache markers: they change nothing about the count.
      const full = buildAnthropicBody(req.context, req.setup, { cacheControl: false });
      const body: Json = {};
      for (const k of ["model", "system", "messages", "tools", "thinking", "output_config"]) if (full[k] !== undefined) body[k] = full[k];
      const d = await jsonRequest({ url: `${baseUrl.replace(/\/$/, "")}/v1/messages/count_tokens`, headers, body }, { ...http, secrets: [...(http.secrets ?? []), ...secrets] }, { signal: req.signal, classify: mapper.classify });
      const n = (d as Json | undefined)?.["input_tokens"];
      if (typeof n !== "number" || !Number.isFinite(n)) throw new ProviderError({ kind: "protocol", message: "the token count response has no input_tokens" });
      return n;
    },
    classify: classifyAnthropic,
  };
}

/** What a setup change does to the prompt cache and the request, beyond what the harness can tell. */
// ---- registration -----------------------------------------------------------------------------------------------

const anthropicProviderConfig = z.strictObject({
  $tag: z.literal("anthropic"),
  /** The NAME of the environment variable holding the key. Omit for a server that needs none. */
  api_key_env: envName.optional(),
  base_url: z.string().url().optional(),
  authorization: z.enum(["x-api-key", "bearer"]).optional(),
  version: z.string().min(1).optional(),
  betas: z.array(z.string().min(1)).optional(),
  cache_control: z.boolean().optional(),
  ...commonProviderFields,
});

export const anthropicDefinition = defineAdapter({
  $tag: "anthropic",
  config: anthropicProviderConfig,
  settings: anthropicSettings,
  jsonSchema: () => ({ config: z.toJSONSchema(anthropicProviderConfig, { io: "input" }), settings: z.toJSONSchema(anthropicSettings, { io: "input" }) }),
  secrets: (c) => (c.api_key_env === undefined ? [] : [c.api_key_env]),
  prices: (c) => pricesFor(ANTHROPIC_PRICES, c),
  models: (c) => modelsFor(ANTHROPIC_MODELS, c),
  create: (c, secrets) => {
    const key = c.api_key_env === undefined ? undefined : secrets.get(c.api_key_env);
    return anthropicAdapter({
      ...(key === undefined ? {} : { apiKey: key }),
      ...(c.base_url === undefined ? {} : { baseUrl: c.base_url }),
      ...(c.authorization === undefined ? {} : { authorization: c.authorization }),
      ...(c.version === undefined ? {} : { version: c.version }),
      ...(c.betas === undefined ? {} : { betas: c.betas }),
      ...(c.cache_control === undefined ? {} : { cacheControl: c.cache_control }),
      http: httpOptionsFor(c),
    });
  },
});

export function classifyAnthropic(from: AgentSetup, to: AgentSetup): Change[] {
  const out: Change[] = [];
  const f = from.model;
  const t = to.model;
  if (f !== undefined && t !== undefined) {
    const fs = (f.settings ?? {}) as Json;
    const ts = (t.settings ?? {}) as Json;
    if (f.id !== t.id || (f.resolved ?? f.id) !== (t.resolved ?? t.id)) out.push({ kind: "cache_break", message: "the prompt cache is per model: the whole conversation is read again at the full input price" });
    else if (stable(fs["thinking"] ?? null) !== stable(ts["thinking"] ?? null) || stable(fs["effort"] ?? null) !== stable(ts["effort"] ?? null)) {
      out.push({ kind: "cache_break", message: "changing thinking or effort invalidates the prompt cache" });
    }
  }
  if (from.model !== undefined && (stable(from.tools) !== stable(to.tools) || stable(from.instructions ?? null) !== stable(to.instructions ?? null) || (from.renderer ?? null) !== (to.renderer ?? null))) {
    out.push({ kind: "cache_break", message: "tools, instructions and rendering come before the conversation in the cached prefix" });
  }
  return out;
}
