import { dataUrl } from "../harness/attachments.ts";
import { RESPONSES_MEDIA } from "./media-specs.ts";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import type { AttachmentPart, Block, ModelContext, Turn } from "../harness/context-builder.ts";
import type { ToolDefinition } from "../harness/definitions.ts";
import { servedModelId, stable, type AgentSetup, type Change } from "../harness/setup.ts";
import { record, safeParse, strictObject } from "../src/validate.ts";
import { defineAdapter, commonProviderFields, envName, httpOptionsFor, modelsFor, pricesFor } from "./registry.ts";
import { OPENAI_MODELS, OPENAI_PRICES } from "./pricing-data.ts";
import {
  classifyStatus,
  httpStream,
  jsonRequest,
  requestHeaders,
  type HttpMapper,
  type HttpOptions,
  type HttpRequestSpec,
} from "./http.ts";
import type { SseEvent } from "./sse.ts";
import {
  ProviderError,
  type Completed,
  type ErrorKind,
  type ModelStream,
  type ProviderAdapter,
  type StreamEvent,
  type StreamRequest,
  type Usage,
} from "./types.ts";
import { asJson, asString, jsonList, jsonOr, messageText, optString, parseJsonObject, type Json } from "./wire.ts";

/**
 * The OpenAI Responses API, and the servers that speak it (Ollama and others). Checked against
 * OpenAI's streaming-events reference: the event names and shapes, the function-call argument events, the usage
 * object on `response.completed`, `response.incomplete` and `response.failed`, and that the replayable reasoning
 * item is the one in `response.output_item.done`. From memory and not yet checked: the request item shapes for
 * assistant messages and function calls, that replayed items carry their ids, and `include` for non-reasoning
 * models. Also from memory and unverified: that `previous_response_id` plus only the new input items continues a
 * stored response, the `context_management` compaction request field, that the `compaction` output item is replayed
 * as is, and that everything before the latest compaction item may be dropped from a stateless replay.
 *
 * State: a response that the server confirms it stored (`response.store === true`) is
 * remembered by its id and by a digest of the exact input it saw plus what it produced. A later request chains
 * from it, sending only the new items, when the digest of the context's own prefix is the same; otherwise (or if
 * the server has forgotten the id) the whole context is replayed. Replay is always possible: reasoning items are
 * always requested encrypted and kept.
 */

// ---- settings -------------------------------------------------------------------------------------------------

const opt = Type.Optional;

export const openaiSettings = strictObject({
  /** Per-request cap on output, reasoning included. Required: the cost limit is computed from it. */
  max_output_tokens: Type.Integer({
    minimum: 1,
    title: "Max output tokens",
    description: "The most the model may write in one response, reasoning included.",
  }),
  /** Request reasoning (summaries, and the encrypted items that make replay possible). Set false for models that do not reason. Default true. */
  reasoning: opt(Type.Boolean({ title: "Reasoning", "x-default": true, "x-advanced": true })),
  /** `reasoning.effort`; the accepted names depend on the model. Changing it changes the cached prefix. */
  effort: opt(Type.String({ minLength: 1, title: "Effort", "x-advanced": true })),
  /** `reasoning.summary`. Default `auto`. */
  reasoning_summary: opt(
    Type.Enum(["auto", "concise", "detailed"], { title: "Reasoning summary", "x-default": "auto", "x-advanced": true }),
  ),
  temperature: opt(
    Type.Number({ minimum: 0, maximum: 2, title: "Temperature", description: "Lower is steadier, higher is more varied.", "x-default": 1 }),
  ),
  top_p: opt(
    Type.Number({
      minimum: 0,
      maximum: 1,
      title: "Top P",
      description: "Only the likeliest words that add up to this chance are considered.",
      "x-default": 1,
    }),
  ),
  service_tier: opt(Type.String({ minLength: 1, title: "Service tier", "x-advanced": true })),
  /**
   * How long the prompt cache lives (`prompt_cache_options.ttl`): `30m` (the default; writes cost 1.25x input) or
   * `12h` (2.5x). For GPT-5.6 and later; earlier models use `prompt_cache_retention`, which you can pass in `extra`.
   */
  cache_ttl: opt(Type.Enum(["30m", "12h"], { title: "Prompt cache lifetime", "x-default": "30m", "x-advanced": true })),
  /** Let the server compact the conversation once it passes this many tokens (`context_management`). The compaction item is kept and replayed. */
  compact_threshold: opt(Type.Integer({ minimum: 1, title: "Compact after tokens", "x-advanced": true })),
  /** Extra top-level request fields for servers with extensions (Ollama's `think`). Cannot override the fields the adapter owns. */
  extra: opt(record(Type.String(), Type.Unknown(), { title: "Extra request fields", "x-advanced": true })),
});
export type OpenAISettings = Static<typeof openaiSettings>;

export function parseOpenAISettings(settings: unknown): OpenAISettings {
  const r = safeParse(openaiSettings, settings ?? {});
  if (!r.ok)
    throw new ProviderError({
      kind: "invalid_request",
      message: `invalid model settings for this provider: ${r.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`).join("; ")}`,
    });
  return r.value;
}

// ---- request --------------------------------------------------------------------------------------------------

// Request fields the adapter sets itself; the `extra` setting skips these, so it cannot change what is chained, stored or cached.
const OWNED = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "stream",
  "store",
  "include",
  "max_output_tokens",
  "reasoning",
  "previous_response_id",
  "context_management",
  "prompt_cache_options",
]);

export interface RequestOptions {
  /** Let the provider keep the response (30 days at OpenAI): needed for retrieval and provider-side features. Default true. */
  store: boolean;
  /** Put the ids of earlier output items on replayed items. Default true. */
  replayItemIds: boolean;
  /** Continue stored responses with `previous_response_id` when the prefix is provably the same. Default true; needs `store`. */
  chain: boolean;
  /** Drop what came before the latest compaction item when replaying. Default true. */
  pruneAtCompaction: boolean;
}

export interface ChainPlan {
  previous_response_id: string;
  /** Only the items after the response. */
  input: Json[];
}

const sha = (x: unknown): string => createHash("sha256").update(stable(x)).digest("hex");
/** With pruning on, the items before the latest compaction item are dropped: that item stands in for them. */
const prune = (items: Json[], opts: RequestOptions): Json[] => {
  if (!opts.pruneAtCompaction) return items;
  const at = items.findLastIndex((i) => i["type"] === "compaction");
  return at > 0 ? items.slice(at) : items;
};

/** What a request that continues the latest stored response would send, or `undefined` when it must replay everything. */
export function planChain(ctx: ModelContext, setup: AgentSetup, opts: RequestOptions): ChainPlan | undefined {
  if (!opts.chain || !opts.store || setup.model === undefined) return undefined;
  const model = servedModelId(setup.model);
  for (let i = ctx.turns.length - 1; i >= 0; i--) {
    const t = ctx.turns[i];
    if (t === undefined || t.role !== "assistant") continue;
    // The latest assistant turn decides: an earlier response is not the end of the history.
    const ext = t.ext;
    if (
      t.provider !== setup.model.provider ||
      typeof ext?.["response_id"] !== "string" ||
      ext["store"] !== true ||
      typeof ext["prefix_digest"] !== "string"
    )
      return undefined;
    // The stored response can be continued only if what this request would replay up to that turn is exactly what it saw.
    if (sha({ model, items: prune(toItems(ctx.turns.slice(0, i + 1), opts).flat(), opts) }) !== ext["prefix_digest"]) return undefined;
    const input = toItems(ctx.turns.slice(i + 1), opts).flat();
    return input.length === 0 ? undefined : { previous_response_id: ext["response_id"], input };
  }
  return undefined;
}

/** The JSON body of a Responses request for a context. Pure. */
export function buildResponsesBody(ctx: ModelContext, setup: AgentSetup, opts: RequestOptions, chain?: ChainPlan): Json {
  if (setup.model === undefined) throw new ProviderError({ kind: "invalid_request", message: "the agent has no model" });
  const s = parseOpenAISettings(setup.model.settings);
  const body: Json = { model: servedModelId(setup.model), stream: true, store: opts.store, max_output_tokens: s.max_output_tokens };
  // Instructions are not carried from one response to the next, so they are sent every time: the pinned prompt, then the global instructions.
  const instructions = [ctx.system, ctx.instructions ?? ""].filter((x) => x !== "").join("\n\n");
  if (instructions !== "") body["instructions"] = instructions;
  if (chain === undefined) body["input"] = prune(toItems(ctx.turns, opts).flat(), opts);
  else {
    body["previous_response_id"] = chain.previous_response_id;
    body["input"] = chain.input;
  }
  if (ctx.tools.length > 0) body["tools"] = ctx.tools.map(toTool);
  if (s.reasoning !== false) {
    body["reasoning"] = { summary: s.reasoning_summary ?? "auto", ...(s.effort === undefined ? {} : { effort: s.effort }) };
    body["include"] = ["reasoning.encrypted_content"]; // always replayable, whether or not the provider also keeps the response
  } else if (s.effort !== undefined) body["reasoning"] = { effort: s.effort };
  if (s.cache_ttl !== undefined) body["prompt_cache_options"] = { ttl: s.cache_ttl };
  if (s.compact_threshold !== undefined) body["context_management"] = [{ type: "compaction", compact_threshold: s.compact_threshold }];
  for (const k of ["temperature", "top_p", "service_tier"] as const) if (s[k] !== undefined) body[k] = s[k];
  for (const [k, v] of Object.entries(s.extra ?? {})) if (!OWNED.has(k)) body[k] = v;
  return body;
}

const toTool = (t: ToolDefinition): Json => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
  strict: false,
});

/** A picture or a document as an input part, in a user turn or in a tool result; this adapter sends no audio. */
function mediaPart(p: AttachmentPart): Json {
  if (p.kind === "audio")
    throw new ProviderError({
      kind: "invalid_request",
      message: `${p.name ?? "sound"} cannot be sent: the Responses API takes no audio input here`,
    });
  if (p.kind === "image") return { type: "input_image", image_url: dataUrl(p.mime, p.bytes) };
  return { type: "input_file", filename: p.name ?? "document.pdf", file_data: dataUrl(p.mime, p.bytes) };
}

/** The input items for each turn, in order (kept per turn so a prefix can be cut at a turn boundary). */
function toItems(turns: readonly Turn[], opts: RequestOptions): Json[][] {
  return turns.map((t): Json[] => {
    if (t.role === "user") {
      return [
        {
          role: "user",
          content: t.parts.map((p): Json => {
            if (p.type === "text") return { type: "input_text", text: p.text };
            return mediaPart(p);
          }),
        },
      ];
    }
    if (t.role === "tool_results")
      return t.results.map((r): Json => ({
        type: "function_call_output",
        call_id: r.call_id,
        output: r.media === undefined ? r.content : [{ type: "input_text", text: r.content }, ...r.media.map(mediaPart)],
      }));
    return assistantItems(t.blocks, opts);
  });
}

/** Compaction items go back as the provider sent them; an unreadable payload cannot be replayed. */
function opaqueItem(payload: string): Json | undefined {
  try {
    return asJson(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

function assistantItems(blocks: readonly Block[], opts: RequestOptions): Json[] {
  const items: Json[] = [];
  for (const b of blocks) {
    const id = opts.replayItemIds && typeof b.ext?.["item_id"] === "string" ? { id: b.ext["item_id"] } : {};
    if (b.type === "reasoning") {
      if (b.payload !== undefined) items.push(b.payload);
    } else if (b.type === "provider_compaction") {
      const item = opaqueItem(b.payload);
      if (item !== undefined) items.push(item);
    } else if (b.type === "text") {
      if (b.text !== "")
        items.push({
          type: "message",
          ...id,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: b.text, annotations: [] }],
        });
    } else
      items.push({
        type: "function_call",
        ...id,
        call_id: b.call_id,
        name: b.name,
        arguments: b.args_raw ?? JSON.stringify(b.args),
        status: "completed",
      });
  }
  return items;
}

// ---- stream ---------------------------------------------------------------------------------------------------

type Open =
  | { kind: "message"; item_id: string; text: string }
  | { kind: "call"; item_id: string; call_id: string; name: string; args: string }
  | { kind: "reasoning"; item: Json; summary: string }
  | { kind: "compaction"; item: Json }
  | { kind: "skip" };

interface State {
  provider: string;
  id: string | undefined;
  model: string | undefined;
  usage: Usage;
  open: Map<number, Open>;
  out: Block[];
  stop: string | undefined;
  refused: boolean;
  done: boolean;
  /** The server said it kept the response. */
  stored: boolean;
  /** The request's own input, flattened: the start of what this response saw. */
  input: Json[];
  chained: boolean;
  /** The model id the request named (what the digest is keyed on). */
  served: string;
}

const ERROR_CODES: Record<string, { kind: ErrorKind; retryable: boolean }> = {
  rate_limit_exceeded: { kind: "rate_limit", retryable: true },
  insufficient_quota: { kind: "rate_limit", retryable: false },
  server_error: { kind: "server", retryable: true },
  overloaded: { kind: "overloaded", retryable: true },
  invalid_api_key: { kind: "auth", retryable: false },
  invalid_prompt: { kind: "invalid_request", retryable: false },
  context_length_exceeded: { kind: "invalid_request", retryable: false },
  invalid_request_error: { kind: "invalid_request", retryable: false },
  model_not_found: { kind: "invalid_request", retryable: false },
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const protocol = (message: string): ProviderError => new ProviderError({ kind: "protocol", message });

function normaliseUsage(raw: Json): Usage {
  const total = num(raw["input_tokens"]) ?? 0;
  const details = jsonOr(raw["input_tokens_details"]);
  const cached = num(details["cached_tokens"]) ?? 0;
  const written = num(details["cache_write_tokens"]) ?? 0;
  // On models with `prompt_cache_options` the writes are split by lifetime.
  const split = jsonOr(details["cache_write_tokens_details"]);
  const by: Record<string, number> = {};
  const t30 = num(split["ttl_30m_tokens"]);
  const t12 = num(split["ttl_12h_tokens"]);
  if (t30 !== undefined) by["30"] = t30;
  if (t12 !== undefined) by["720"] = t12;
  const reasoning = num(jsonOr(raw["output_tokens_details"])["reasoning_tokens"]);
  return {
    input_tokens: Math.max(0, total - cached - written),
    output_tokens: num(raw["output_tokens"]) ?? 0,
    ...(details["cached_tokens"] === undefined ? {} : { cache_read_tokens: cached }),
    ...(details["cache_write_tokens"] === undefined ? {} : { cache_write_tokens: written }),
    ...(Object.keys(by).length > 0 ? { cache_write_by_minutes: by } : {}),
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
    raw,
  };
}

function toolBlock(call_id: string, name: string, args: string, item_id: string): Block {
  const ext = { item_id };
  try {
    const parsed = args === "" ? {} : parseJsonObject(args, "the tool arguments");
    return { type: "tool_call", call_id, name, args: parsed, ext };
  } catch {
    return { type: "tool_call", call_id, name, args: {}, args_raw: args, ext };
  }
}

/** The text of a reasoning summary: its parts, joined by blank lines. */
function summaryText(summary: unknown[]): string {
  return jsonList(summary)
    .map((x) => (typeof x["text"] === "string" ? x["text"] : ""))
    .join("\n\n");
}

function partsText(content: unknown): { text: string; refused: boolean } {
  let text = "";
  let refused = false;
  for (const p of jsonList(content)) {
    if (p["type"] === "output_text" && typeof p["text"] === "string") text += p["text"];
    else if (p["type"] === "refusal" && typeof p["refusal"] === "string") {
      text += p["refusal"];
      refused = true;
    }
  }
  return { text, refused };
}

/** Close one open output item into its block. The completed item, when the server sent it, is authoritative over what streamed. */
function finishBlock(s: State, i: number, o: Open, item?: Json): StreamEvent[] {
  let block: Block;
  if (o.kind === "skip") return [];
  if (o.kind === "message") {
    const final = item === undefined ? { text: o.text, refused: false } : partsText(item["content"]);
    if (final.refused) s.refused = true;
    block = { type: "text", text: item === undefined ? o.text : final.text, ext: { item_id: o.item_id } };
  } else if (o.kind === "compaction") {
    block = { type: "provider_compaction", provider: s.provider, payload: JSON.stringify(item ?? o.item) };
  } else if (o.kind === "call") {
    const args = typeof item?.["arguments"] === "string" ? item["arguments"] : o.args;
    block = toolBlock(o.call_id, o.name, args, o.item_id);
  } else {
    const original = item ?? {
      ...o.item,
      summary: o.summary === "" ? (o.item["summary"] ?? []) : [{ type: "summary_text", text: o.summary }],
    };
    const visible = Array.isArray(original["summary"]) ? summaryText(original["summary"]) : o.summary;
    block = { type: "reasoning", provider: s.provider, payload: original, ...(visible === "" ? {} : { visible }) };
  }
  s.open.delete(i);
  s.out[i] = block;
  return [{ type: "block.done", index: i, block }];
}

/** Normalised stop reason. A refusal or the output limit outranks a tool call; otherwise a call means `tool_use`. */
function stopReason(r: Json, blocks: readonly (Block | undefined)[], refused: boolean): string {
  const reason = jsonOr(r["incomplete_details"])["reason"];
  if (refused || reason === "content_filter") return "refusal";
  if (reason === "max_output_tokens" || reason === "max_tokens") return "max_tokens";
  if (blocks.some((b) => b?.type === "tool_call")) return "tool_use";
  return typeof reason === "string" ? reason : "end_turn";
}

/** The blocks of a finished response's `output` (used for retrieval; the stream builds the same blocks as it goes). */
function outputBlocks(output: unknown, provider: string): { blocks: Block[]; refused: boolean } {
  const blocks: Block[] = [];
  let refused = false;
  for (const item of jsonList(output)) {
    if (item["type"] === "message") {
      const p = partsText(item["content"]);
      refused ||= p.refused;
      blocks.push({ type: "text", text: p.text, ext: { item_id: optString(item["id"], "item.id") } });
    } else if (item["type"] === "function_call")
      blocks.push(
        toolBlock(
          optString(item["call_id"] ?? item["id"], "item.call_id"),
          optString(item["name"], "item.name"),
          optString(item["arguments"], "item.arguments"),
          optString(item["id"], "item.id"),
        ),
      );
    else if (item["type"] === "reasoning") {
      const visible = Array.isArray(item["summary"]) ? summaryText(item["summary"]) : "";
      blocks.push({ type: "reasoning", provider, payload: item, ...(visible === "" ? {} : { visible }) });
    } else if (item["type"] === "compaction") blocks.push({ type: "provider_compaction", provider, payload: JSON.stringify(item) });
  }
  return { blocks, refused };
}

/**
 * The HTTP mapper for Responses. Each attempt keeps its own state; `finish` records the digest of what the response saw,
 * which is what lets a later request continue it with `previous_response_id`.
 */
export function openaiResponsesMapper(baseUrl: string, request: RequestOptions): HttpMapper<State> {
  return {
    request(req: StreamRequest): HttpRequestSpec {
      return {
        url: `${baseUrl.replace(/\/$/, "")}/responses`,
        headers: { "content-type": "application/json" },
        body: buildResponsesBody(req.context, req.setup, request, planChain(req.context, req.setup, request)),
      };
    },
    start: (req) => ({
      provider: req.setup.model?.provider ?? "openai",
      id: undefined,
      model: undefined,
      usage: { input_tokens: 0, output_tokens: 0 },
      open: new Map(),
      out: [],
      stop: undefined,
      refused: false,
      done: false,
      stored: false,
      input: toItems(req.context.turns, request).flat(),
      chained: planChain(req.context, req.setup, request) !== undefined,
      served: req.setup.model === undefined ? "" : servedModelId(req.setup.model),
    }),
    event(sse: SseEvent, s: State): StreamEvent[] {
      let d: Json;
      try {
        d = parseJsonObject(sse.data, `the ${sse.event} event`);
      } catch {
        if (sse.data === "[DONE]") return [];
        throw protocol(`malformed ${sse.event} event`);
      }
      const type = asString(d["type"]) ?? sse.event;
      const index = num(d["output_index"]) ?? 0;
      switch (type) {
        case "response.created": {
          const r = jsonOr(d["response"]);
          s.id = asString(r["id"]);
          s.model = asString(r["model"]);
          if (r["store"] === true) s.stored = true;
          return [
            { type: "started" },
            {
              type: "observed",
              observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) },
            },
          ];
        }
        case "response.output_item.added": {
          const item = jsonOr(d["item"]);
          if (item["type"] === "message") s.open.set(index, { kind: "message", item_id: optString(item["id"], "item.id"), text: "" });
          else if (item["type"] === "function_call") {
            const o: Open = {
              kind: "call",
              item_id: optString(item["id"], "item.id"),
              call_id: optString(item["call_id"] ?? item["id"], "item.call_id"),
              name: optString(item["name"], "item.name"),
              args: "",
            };
            s.open.set(index, o);
            return [{ type: "tool_call.start", index, call_id: o.call_id, name: o.name }];
          } else if (item["type"] === "reasoning") s.open.set(index, { kind: "reasoning", item, summary: "" });
          else if (item["type"] === "compaction") s.open.set(index, { kind: "compaction", item });
          else s.open.set(index, { kind: "skip" });
          return [];
        }
        case "response.output_text.delta":
        case "response.refusal.delta": {
          const o = s.open.get(index);
          if (o === undefined || o.kind === "skip") return [];
          if (o.kind !== "message") throw protocol(`text for output ${index}, which is not a message`);
          const text = optString(d["delta"], "d.delta");
          o.text += text;
          if (type === "response.refusal.delta") s.refused = true;
          return [{ type: "text.delta", index, text }];
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const o = s.open.get(index);
          if (o === undefined || o.kind !== "reasoning") return [];
          const text = optString(d["delta"], "d.delta");
          o.summary += text;
          return [{ type: "reasoning.delta", index, text }];
        }
        case "response.reasoning_summary_part.added":
        case "response.reasoning_summary_text.done": {
          const o = s.open.get(index);
          // Summary parts are separated by blank lines, the same way `summaryText` joins them when the item is complete.
          if (o?.kind === "reasoning" && type === "response.reasoning_summary_part.added" && o.summary !== "") o.summary += "\n\n";
          return [];
        }
        case "response.function_call_arguments.delta": {
          const o = s.open.get(index);
          if (o === undefined || o.kind === "skip") return [];
          if (o.kind !== "call") throw protocol(`arguments for output ${index}, which is not a function call`);
          const delta = optString(d["delta"], "d.delta");
          o.args += delta;
          return [{ type: "tool_call.delta", index, args_delta: delta }];
        }
        case "response.function_call_arguments.done": {
          const o = s.open.get(index);
          if (o?.kind === "call" && typeof d["arguments"] === "string") o.args = d["arguments"];
          return [];
        }
        case "response.output_item.done": {
          const o = s.open.get(index);
          if (o === undefined) return [];
          return finishBlock(s, index, o, jsonOr(d["item"]));
        }
        case "response.completed":
        case "response.incomplete": {
          const r = jsonOr(d["response"]);
          if (typeof r["model"] === "string") s.model = r["model"];
          if (r["store"] !== undefined) s.stored = r["store"] === true;
          if (r["usage"] !== undefined && r["usage"] !== null) s.usage = normaliseUsage(jsonOr(r["usage"]));
          const events: StreamEvent[] = [];
          // Servers that do not send `output_item.done` leave blocks open: close them from what streamed.
          for (const [i, o] of [...s.open].sort((a, b) => a[0] - b[0])) events.push(...finishBlock(s, i, o));
          s.stop = stopReason(r, s.out, s.refused);
          if (typeof r["id"] === "string") s.id = r["id"];
          s.done = true;
          events.push({ type: "usage", usage: s.usage });
          return events;
        }
        case "response.failed": {
          const e = jsonOr(jsonOr(d["response"])["error"]);
          throw errorFrom(e["code"], e["message"]);
        }
        case "error":
          throw errorFrom(d["code"], d["message"]);
        default:
          return []; // tolerate event types we do not know
      }
    },
    done: (s) => s.done,
    finish(s): Completed {
      if (s.stop === undefined) throw protocol("the response ended without a stop reason");
      const observed = { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) };
      const blocks = s.out.filter((b): b is Block => b !== undefined);
      // Only what the server confirmed it kept can be continued; the digest says exactly what that response saw and produced.
      const digest =
        s.stored && s.id !== undefined
          ? { prefix_digest: sha({ model: s.served, items: prune([...s.input, ...assistantItems(blocks, request)], request) }) }
          : {};
      return {
        blocks,
        stop_reason: s.stop,
        usage: s.usage,
        observed,
        ext: { ...(s.id === undefined ? {} : { response_id: s.id }), store: s.stored, ...digest, ...(s.chained ? { chained: true } : {}) },
      };
    },
    classify({ status, body }) {
      try {
        const e = asJson(parseJsonObject(body, "the error body")["error"]);
        if (e === undefined) return undefined;
        const code = typeof e["code"] === "string" ? e["code"] : typeof e["type"] === "string" ? e["type"] : undefined;
        const known = code === undefined ? undefined : ERROR_CODES[code];
        return { ...(known === undefined ? {} : known), message: `${status} ${code ?? "error"}: ${messageText(e["message"])}` };
      } catch {
        return undefined;
      }
    },
  };
}

function errorFrom(code: unknown, message: unknown): ProviderError {
  const known = typeof code === "string" ? ERROR_CODES[code] : undefined;
  return new ProviderError({
    ...(known ?? { kind: "server" as const, retryable: false }),
    message: `${typeof code === "string" ? code : "error"}: ${messageText(message)}`,
  });
}

// ---- adapter --------------------------------------------------------------------------------------------------

export interface OpenAIResponsesOptions {
  /** The API key, or a function that returns it. Omit for servers that need none. */
  apiKey?: string | (() => string | Promise<string>);
  /** Default https://api.openai.com/v1. */
  baseUrl?: string;
  /** Opt out of server-side storage of responses (`store: false`). Default: stored, as OpenAI's API does. */
  store?: boolean;
  /** Default true. */
  replayItemIds?: boolean;
  /** Continue stored responses instead of replaying the whole context when that is provably the same. Default true. Needs `store`. */
  chain?: boolean;
  /** Drop what came before the latest compaction item when replaying. Default true. */
  pruneAtCompaction?: boolean;
  http?: HttpOptions;
}

/**
 * An adapter for the Responses API. A request continues the stored response when that is provably safe (see `planChain`);
 * if the server rejects the chained request (its error names `previous_response`) before anything has reached the caller,
 * the same request is sent again with the whole context.
 */
export function openaiResponsesAdapter(opts: OpenAIResponsesOptions = {}): ProviderAdapter {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const request: RequestOptions = {
    store: opts.store ?? true,
    replayItemIds: opts.replayItemIds ?? true,
    chain: opts.chain ?? true,
    pruneAtCompaction: opts.pruneAtCompaction ?? true,
  };
  const mapper = openaiResponsesMapper(baseUrl, request);
  const replayOnly = openaiResponsesMapper(baseUrl, { ...request, chain: false });
  const auth = async (spec: HttpRequestSpec): Promise<Record<string, string>> => {
    const base = (await opts.http?.auth?.(spec)) ?? {};
    if (opts.apiKey === undefined) return base;
    const key = typeof opts.apiKey === "string" ? opts.apiKey : await opts.apiKey();
    return { ...base, authorization: `Bearer ${key}` };
  };
  const http: HttpOptions = {
    ...opts.http,
    auth,
    secrets: [...(opts.http?.secrets ?? []), ...(typeof opts.apiKey === "string" ? [opts.apiKey] : [])],
  };

  /** Continue from the stored response when that is safe; if the server no longer has it, replay everything instead. */
  async function* stream(req: StreamRequest): ModelStream {
    if (planChain(req.context, req.setup, request) === undefined) return yield* httpStream(mapper, req, http);
    const first = httpStream(mapper, req, http);
    let yielded = 0;
    try {
      for (;;) {
        const r = await first.next();
        if (r.done === true) return r.value;
        yielded++;
        yield r.value;
      }
    } catch (e) {
      // Nothing has reached the caller yet, so the request can be made again without the chain.
      if (
        yielded === 0 &&
        e instanceof ProviderError &&
        e.kind === "invalid_request" &&
        /previous_response/i.test(e.message) &&
        !req.signal.aborted
      )
        return yield* httpStream(replayOnly, req, http);
      throw e;
    } finally {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `return` wants the stream's result, and a stream stopped from outside has none
      await first.return(undefined as never);
    }
  }

  async function retrieve(r: { responseId: string; setup: AgentSetup; signal: AbortSignal }): Promise<Completed | undefined> {
    const spec: HttpRequestSpec = {
      url: `${baseUrl.replace(/\/$/, "")}/responses/${encodeURIComponent(r.responseId)}`,
      method: "GET",
      headers: {},
    };
    const signal = AbortSignal.any([r.signal, AbortSignal.timeout(opts.http?.timeouts?.totalMs ?? 60_000)]);
    const scrub = (t: string): string => (http.secrets ?? []).reduce((acc, k) => (k === "" ? acc : acc.split(k).join("[redacted]")), t);
    let res: Response;
    try {
      res = await (opts.http?.fetch ?? fetch)(spec.url, {
        method: "GET",
        headers: { ...requestHeaders(spec.headers, opts.http ?? {}), ...(await auth(spec)) },
        signal,
      });
    } catch (e) {
      throw new ProviderError({
        kind: r.signal.aborted ? "aborted" : "network",
        message: scrub(`retrieving ${r.responseId}: ${e instanceof Error ? e.message : String(e)}`),
        retryable: !r.signal.aborted,
        cause: e,
      });
    }
    const body = await res.text();
    if (res.status === 404) return undefined;
    if (!res.ok) {
      const c = mapper.classify?.({ status: res.status, headers: res.headers, body });
      throw new ProviderError({
        ...classifyStatus(res.status),
        ...c,
        message: scrub(c?.message ?? `HTTP ${res.status}: ${body.slice(0, 500)}`),
        status: res.status,
      });
    }
    let d: Json;
    try {
      d = parseJsonObject(body, "the retrieved response");
    } catch {
      throw protocol("the retrieved response is not JSON");
    }
    const status = d["status"];
    if (status === "failed") {
      const e = jsonOr(d["error"]);
      throw errorFrom(e["code"], e["message"]);
    }
    if (status === "cancelled") return undefined;
    if (status !== "completed" && status !== "incomplete")
      throw new ProviderError({ kind: "server", message: `response ${r.responseId} is still ${String(status)}`, retryable: true });
    const provider = r.setup.model?.provider ?? "openai";
    const { blocks, refused } = outputBlocks(d["output"], provider);
    const usage =
      d["usage"] === undefined || d["usage"] === null ? { input_tokens: 0, output_tokens: 0 } : normaliseUsage(jsonOr(d["usage"]));
    const model = typeof d["model"] === "string" ? d["model"] : undefined;
    return {
      blocks,
      stop_reason: stopReason(d, blocks, refused),
      usage,
      observed: { ...(model === undefined ? {} : { model }), response_id: r.responseId },
      ext: { response_id: r.responseId, store: d["store"] === true, retrieved: true },
    };
  }

  async function countTokens(r: { context: ModelContext; setup: AgentSetup; signal: AbortSignal }): Promise<number> {
    // POST /responses/input_tokens takes the Responses request's input fields; always the full context (no chaining).
    const full = buildResponsesBody(r.context, r.setup, request);
    const body: Json = {};
    for (const k of ["model", "input", "instructions", "tools"]) if (full[k] !== undefined) body[k] = full[k];
    const d = await jsonRequest(
      { url: `${baseUrl.replace(/\/$/, "")}/responses/input_tokens`, headers: { "content-type": "application/json" }, body },
      http,
      { signal: r.signal, classify: mapper.classify },
    );
    const n = asJson(d)?.["input_tokens"];
    if (typeof n !== "number" || !Number.isFinite(n)) throw protocol("the token count response has no input_tokens");
    return n;
  }

  return { $tag: "openai", toolSchema: "full", mediaSpec: () => RESPONSES_MEDIA, stream, retrieve, countTokens, classify: classifyOpenAI };
}

// ---- registration -----------------------------------------------------------------------------------------------

const openaiProviderConfig = strictObject({
  $tag: Type.Literal("openai"),
  /** The NAME of the environment variable holding the key. Omit for a server that needs none. */
  api_key_env: opt(envName),
  base_url: opt(Type.String({ format: "url" })),
  /** `false` opts out of server-side storage of responses (no chaining, no retrieval). */
  store: opt(Type.Boolean()),
  chain: opt(Type.Boolean()),
  replay_item_ids: opt(Type.Boolean()),
  prune_at_compaction: opt(Type.Boolean()),
  ...commonProviderFields,
});

export const openaiDefinition = defineAdapter({
  $tag: "openai",
  config: openaiProviderConfig,
  settings: openaiSettings,
  secrets: (c) => (c.api_key_env === undefined ? [] : [c.api_key_env]),
  prices: (c) => pricesFor(OPENAI_PRICES, c),
  models: (c) => modelsFor(OPENAI_MODELS, c),
  create: (c, secrets) => {
    const key = c.api_key_env === undefined ? undefined : secrets.get(c.api_key_env);
    return openaiResponsesAdapter({
      ...(key === undefined ? {} : { apiKey: key }),
      ...(c.base_url === undefined ? {} : { baseUrl: c.base_url }),
      ...(c.store === undefined ? {} : { store: c.store }),
      ...(c.chain === undefined ? {} : { chain: c.chain }),
      ...(c.replay_item_ids === undefined ? {} : { replayItemIds: c.replay_item_ids }),
      ...(c.prune_at_compaction === undefined ? {} : { pruneAtCompaction: c.prune_at_compaction }),
      http: httpOptionsFor(c),
    });
  },
});

/** What a setup change does to the cached prefix. */
export function classifyOpenAI(from: AgentSetup, to: AgentSetup): Change[] {
  const out: Change[] = [];
  const f = from.model;
  const t = to.model;
  if (f !== undefined && t !== undefined) {
    const fs = (f.settings ?? {}) as Json;
    const ts = (t.settings ?? {}) as Json;
    if (f.id !== t.id || (f.resolved ?? f.id) !== (t.resolved ?? t.id))
      out.push({ kind: "cache_break", message: "the prompt cache is per model: the conversation is read again at the full input price" });
    else if (["effort", "reasoning", "reasoning_summary"].some((k) => stable(fs[k] ?? null) !== stable(ts[k] ?? null)))
      out.push({ kind: "cache_break", message: "changing reasoning settings changes the cached prefix" });
  }
  if (
    from.model !== undefined &&
    (stable(from.tools) !== stable(to.tools) ||
      stable(from.instructions ?? null) !== stable(to.instructions ?? null) ||
      (from.renderer ?? null) !== (to.renderer ?? null))
  ) {
    out.push({ kind: "cache_break", message: "instructions, tools and rendering come before the conversation in the cached prefix" });
  }
  return out;
}
