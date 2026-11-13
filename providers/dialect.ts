import { randomUUID } from "node:crypto";
import type { AttachmentPart, Block, ModelContext } from "../harness/context-builder.ts";
import type { ToolDefinition } from "../harness/definitions.ts";
import { servedModelId } from "../harness/setup.ts";
import type { HttpMapper, HttpRequestSpec } from "./http.ts";
import { ProviderError, type Completed, type StreamEvent, type StreamRequest, type Usage } from "./types.ts";
import type { SseEvent } from "./sse.ts";

/**
 * Dialects (docs/local-models.md, section 9): our own prompt rendering and output parsing for a model, in place of the server's chat
 * template. A dialect turns a folded context into one raw prompt string, and turns the raw text the model writes back into blocks.
 * The server only runs the model on the string (llama-server's `/completion`), so what the model sees and what we read back are ours.
 * Not to be confused with `harness/renderer.ts`, which renders compactions and fork results.
 */

/** What a parser says about the text it has read so far; the `Assembler` turns it into blocks and stream events. */
export type Emit =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "call.start"; name: string }
  | { kind: "call.args"; delta: string }
  /**
   * `args` when the dialect parsed them; `raw` when it only has the text (parsed as JSON here, else kept as `args_raw`); neither: the deltas so
   * far are the text. `error`: the call cannot be read without guessing; the call is kept as the model wrote it (`args_raw`) and the model is
   * answered with this text instead of a validator's message (it travels in the block's `ext.call_error`, see `ToolRegistry.check`).
   * `ext`: what the dialect needs back when it writes this call into a later prompt (kept in the block's `ext`, which providers never read).
   */
  | { kind: "call.end"; args?: Record<string, unknown>; raw?: string; error?: string; ext?: Record<string, unknown> };

export interface Parser {
  /** Text as it arrives, in whatever pieces the server sends. */
  push(text: string): Emit[];
  /** The model has stopped. Closes whatever is open; a malformed or cut-off call ends here as `raw`. Never throws. */
  end(why: "stop" | "length"): Emit[];
}

export interface RenderInput {
  context: ModelContext;
  options: Record<string, unknown>;
  /** The `reasoning_effort` setting, for dialects that tell the model. */
  effort: string | undefined;
  /** Today, `YYYY-MM-DD`, for dialects whose prompt says so. Given, not read, so that rendering is pure. */
  date: string;
  /** The provider and model name this request is for: reasoning is replayed only to the model that wrote it. */
  provider: string;
  model: string;
  /** The server's marker for one picture (`/props`' `media_marker`), when it has one: a user turn's pictures are written as this (providers/dialects/media.ts). */
  marker?: string | undefined;
}

export interface Rendered {
  prompt: string;
  /** The pictures the prompt has a marker for, in order. */
  media?: AttachmentPart[];
  /** Strings that end generation, besides the model's own end tokens. */
  stop: string[];
}

export interface Dialect {
  /** Recorded in the setup; never changes meaning once released, like a renderer's id. */
  id: string;
  render(input: RenderInput): Rendered;
  /** `tools` give the types of arguments a format writes as text; `prompt` is what was rendered, whose ending says whether the model starts inside its thinking. */
  parser(options: Record<string, unknown>, tools: readonly ToolDefinition[], prompt: string): Parser;
  /**
   * The special tokens the parser looks for, as text. A server may give a special token no text even when asked to (llama-server does for
   * a token its vocabulary marks unused, as the Mistral GGUFs do for `[TOOL_CALLS]` and `[ARGS]`), so the transport finds their ids with
   * `/tokenize` and puts the text back where a chunk carries that id and no text.
   */
  markers?: readonly string[];
}

export class DialectRegistry {
  readonly #by = new Map<string, Dialect>();
  constructor(dialects: readonly Dialect[] = []) {
    for (const d of dialects) this.register(d);
  }
  register(d: Dialect): this {
    if (this.#by.has(d.id)) throw new Error(`dialect "${d.id}" is already registered`);
    this.#by.set(d.id, d);
    return this;
  }
  ids(): string[] {
    return [...this.#by.keys()].sort();
  }
  get(id: string): Dialect {
    const d = this.#by.get(id);
    if (d === undefined) throw new ProviderError({ kind: "invalid_request", message: `unknown dialect "${id}"; known: ${this.ids().join(", ") || "none"}` });
    return d;
  }
}

// ---- assembling blocks ------------------------------------------------------------------------------------------

type Open = { kind: "text"; index: number; text: string } | { kind: "reasoning"; index: number; text: string } | { kind: "call"; index: number; id: string; name: string; args: string };

/** Turns a parser's emissions into the stream events and blocks every adapter produces. */
export class Assembler {
  readonly blocks: Block[] = [];
  sawCall = false;
  #next = 0;
  #open: Open | undefined;
  readonly #provider: string;
  readonly #newId: () => string;

  constructor(provider: string, newId: () => string = () => `call_${randomUUID().slice(0, 12)}`) {
    this.#provider = provider;
    this.#newId = newId;
  }

  feed(emits: readonly Emit[]): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const e of emits) {
      if (e.kind === "text" || e.kind === "reasoning") {
        if (e.text === "") continue;
        if (this.#open?.kind !== e.kind) {
          this.#close(out);
          this.#open = { kind: e.kind, index: this.#next++, text: "" };
        }
        const o = this.#open as { index: number; text: string };
        o.text += e.text;
        out.push({ type: e.kind === "text" ? "text.delta" : "reasoning.delta", index: o.index, text: e.text });
      } else if (e.kind === "call.start") {
        this.#close(out);
        const id = this.#newId();
        this.#open = { kind: "call", index: this.#next++, id, name: e.name, args: "" };
        this.sawCall = true;
        out.push({ type: "tool_call.start", index: this.#open.index, call_id: id, name: e.name });
      } else if (e.kind === "call.args") {
        if (this.#open?.kind !== "call" || e.delta === "") continue;
        this.#open.args += e.delta;
        out.push({ type: "tool_call.delta", index: this.#open.index, args_delta: e.delta });
      } else if (this.#open?.kind === "call") {
        this.#close(out, e);
      }
    }
    return out;
  }

  /** The model has stopped: whatever is open is closed as it stands. */
  end(): StreamEvent[] {
    const out: StreamEvent[] = [];
    this.#close(out);
    return out;
  }

  #close(out: StreamEvent[], end?: Extract<Emit, { kind: "call.end" }>): void {
    const o = this.#open;
    if (o === undefined) return;
    this.#open = undefined;
    let block: Block;
    if (o.kind === "text") block = { type: "text", text: o.text };
    else if (o.kind === "reasoning") block = { type: "reasoning", provider: this.#provider, visible: o.text };
    else if (end?.error !== undefined) block = { type: "tool_call", call_id: o.id, name: o.name, args: {}, args_raw: end.raw ?? o.args, ext: { ...end.ext, call_error: end.error } };
    else if (end?.args !== undefined) block = { type: "tool_call", call_id: o.id, name: o.name, args: end.args, ...(end.ext === undefined ? {} : { ext: end.ext }) };
    else {
      const raw = end?.raw ?? o.args;
      try {
        const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        block = { type: "tool_call", call_id: o.id, name: o.name, args: parsed as Record<string, unknown> };
      } catch {
        block = { type: "tool_call", call_id: o.id, name: o.name, args: {}, args_raw: raw };
      }
    }
    this.blocks[o.index] = block;
    out.push({ type: "block.done", index: o.index, block });
  }
}

// ---- the /completion transport ------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const OWNED = new Set(["model", "prompt", "stream", "n_predict", "stop", "special", "return_tokens"]);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface CompletionOptions {
  /** The server's address, without a path. */
  baseUrl: string;
  dialects: DialectRegistry;
  /** Today, `YYYY-MM-DD`. */
  today: () => string;
  modelName: (setupModelId: string) => string;
  observe: (requested: string) => string | undefined;
  newId?: () => string;
  /** For `/tokenize` (default: the global fetch). */
  fetch?: typeof fetch;
}

interface State {
  /** Token ids of the dialect's markers, to put their text back where the server left it out. */
  markers: ReadonlyMap<number, string>;
  parser: Parser;
  assembler: Assembler;
  started: boolean;
  requested: string;
  observed: boolean;
  prompt: number;
  cached: number | undefined;
  completion: number;
  stopType: string | undefined;
  done: boolean;
  usage: Usage;
}

/** The setting names the dialect path reads; the rest of `settings` is the same as for the chat path. */
export interface DialectSettings {
  max_output_tokens: number;
  temperature?: number | undefined;
  top_p?: number | undefined;
  stop?: string[] | undefined;
  seed?: number | undefined;
  reasoning_effort?: string | undefined;
  extra?: Record<string, unknown> | undefined;
  dialect: string;
  dialect_options?: Record<string, unknown> | undefined;
}

const markerCache = new Map<string, Promise<Map<number, string>>>();

/**
 * The ids of the markers that are single tokens, by `/tokenize`; a marker the server cannot say is left out, and nothing here fails a request.
 * An answer is kept for the run only when every marker was answered: the router may be loading the model when the first request comes (the
 * lookup then fails or times out), and a failure kept would leave every later request without its markers.
 */
async function markerTokens(base: string, model: string, markers: readonly string[], doFetch: typeof fetch): Promise<Map<number, string>> {
  const key = `${base}\u0000${model}\u0000${markers.join("\u0000")}`;
  const known = markerCache.get(key);
  if (known !== undefined) return known;
  const found = (async () => {
    const out = new Map<number, string>();
    let failed = false;
    await Promise.all(
      markers.map(async (m) => {
        try {
          const res = await doFetch(`${base.replace(/\/$/, "")}/tokenize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, content: m, add_special: false, parse_special: true }), signal: AbortSignal.timeout(60_000) });
          if (!res.ok) {
            failed = true;
            return;
          }
          const tokens = ((await res.json()) as { tokens?: unknown }).tokens;
          if (Array.isArray(tokens) && tokens.length === 1 && typeof tokens[0] === "number") out.set(tokens[0], m);
        } catch {
          failed = true; // the marker's text is then only what the server sends
        }
      }),
    );
    if (failed) markerCache.delete(key);
    return out;
  })();
  markerCache.set(key, found);
  return found;
}

/** What a server says of itself (`GET /props`): whether it can take pictures, and what marks one in a prompt. Remembered for the run when it was answered. */
const propsCache = new Map<string, Promise<{ vision: boolean | undefined; marker: string }>>();
/** `mtmd_default_marker()` of llama.cpp, for a build that does not say its own. */
const DEFAULT_MARKER = "<__media__>";

async function serverProps(base: string, model: string, doFetch: typeof fetch): Promise<{ vision: boolean | undefined; marker: string }> {
  const key = `${base}\n${model}`;
  const known = propsCache.get(key);
  if (known !== undefined) return known;
  const found = (async () => {
    try {
      const res = await doFetch(`${base.replace(/\/$/, "")}/props?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { modalities?: { vision?: unknown }; media_marker?: unknown };
      return { vision: typeof d.modalities?.vision === "boolean" ? d.modalities.vision : undefined, marker: typeof d.media_marker === "string" && d.media_marker !== "" ? d.media_marker : DEFAULT_MARKER };
    } catch {
      propsCache.delete(key); // the model may still be loading: ask again next time
      return { vision: undefined, marker: DEFAULT_MARKER };
    }
  })();
  propsCache.set(key, found);
  return found;
}

export function completionMapper(opts: CompletionOptions, settings: (req: StreamRequest) => DialectSettings): HttpMapper<State> {
  const rendered = new WeakMap<StreamRequest, Rendered>();
  const markerIds = new WeakMap<StreamRequest, Map<number, string>>();
  const renderFor = (req: StreamRequest, s: DialectSettings, marker?: string): Rendered => {
    const served = servedModelId(req.setup.model!);
    return opts.dialects.get(s.dialect).render({ context: req.context, options: s.dialect_options ?? {}, effort: s.reasoning_effort, date: opts.today(), provider: req.setup.model!.provider, model: served, marker });
  };
  return {
    async request(req: StreamRequest): Promise<HttpRequestSpec> {
      const s = settings(req);
      if (req.setup.model === undefined) throw new ProviderError({ kind: "invalid_request", message: "the agent has no model" });
      const served = servedModelId(req.setup.model);
      let marker: string | undefined;
      if (req.context.turns.some((t) => t.role === "user" && t.parts.some((p) => p.type === "attachment"))) {
        const props = await serverProps(opts.baseUrl, opts.modelName(served), opts.fetch ?? fetch);
        if (props.vision === false) throw new ProviderError({ kind: "invalid_request", message: `${opts.modelName(served)} cannot take pictures: it has no multimodal projector (set mmproj, for instance \`mmproj: auto\`, in its local_models entry)` });
        marker = props.marker;
      }
      const r = renderFor(req, s, marker);
      rendered.set(req, r);
      const markers = opts.dialects.get(s.dialect).markers ?? [];
      if (markers.length > 0) markerIds.set(req, await markerTokens(opts.baseUrl, opts.modelName(served), markers, opts.fetch ?? fetch));
      const media = r.media ?? [];
      const sent = req.context.turns.reduce((n, t) => n + (t.role === "user" ? t.parts.filter((p) => p.type === "attachment").length : 0), 0);
      if (media.length !== sent) throw new ProviderError({ kind: "invalid_request", message: `dialect "${s.dialect}" does not write pictures into its prompt (${sent} sent, ${media.length} written)` });
      if (media.length > 0 && r.prompt.split(marker as string).length - 1 !== media.length) throw new ProviderError({ kind: "invalid_request", message: "the text of a message contains the server's picture marker, which would be taken for a picture" });
      const prompt: Json | string = media.length === 0 ? r.prompt : { prompt_string: r.prompt, multimodal_data: media.map((m) => Buffer.from(m.bytes).toString("base64")) };
      const body: Json = { model: opts.modelName(served), prompt, stream: true, cache_prompt: true, special: true, return_tokens: true, n_predict: s.max_output_tokens };
      const stop = [...(s.stop ?? []), ...r.stop];
      if (stop.length > 0) body["stop"] = stop;
      for (const k of ["temperature", "top_p", "seed"] as const) if (s[k] !== undefined) body[k] = s[k];
      // `extra` may switch the server's prompt cache off (`cache_prompt: false`) or add any sampler key; it cannot replace what the dialect owns.
      for (const [k, v] of Object.entries(s.extra ?? {})) if (!OWNED.has(k)) body[k] = v;
      return { url: `${opts.baseUrl.replace(/\/$/, "")}/completion`, headers: { "content-type": "application/json", accept: "text/event-stream" }, body };
    },
    start(req) {
      const s = settings(req);
      const served = servedModelId(req.setup.model!);
      return {
        markers: markerIds.get(req) ?? new Map(),
        parser: opts.dialects.get(s.dialect).parser(s.dialect_options ?? {}, req.context.tools, (rendered.get(req) ?? renderFor(req, s)).prompt),
        assembler: new Assembler(req.setup.model!.provider, opts.newId),
        started: false,
        requested: opts.modelName(served),
        observed: false,
        prompt: 0,
        cached: undefined,
        completion: 0,
        stopType: undefined,
        done: false,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
    event(sse: SseEvent, s: State): StreamEvent[] {
      const data = sse.data.trim();
      if (data === "") return [];
      let d: Json;
      try {
        d = JSON.parse(data) as Json;
      } catch {
        throw new ProviderError({ kind: "protocol", message: "malformed chunk" });
      }
      if (d["error"] !== undefined && d["error"] !== null) throw new ProviderError(errorOf(d));
      const events: StreamEvent[] = [];
      if (!s.started) {
        s.started = true;
        events.push({ type: "started" });
      }
      if (!s.observed) {
        s.observed = true;
        const model = opts.observe(s.requested);
        if (model !== undefined) events.push({ type: "observed", observed: { model } });
      }
      let content = typeof d["content"] === "string" ? d["content"] : "";
      const ids = d["tokens"];
      if (content === "" && Array.isArray(ids) && ids.length === 1) content = s.markers.get(ids[0] as number) ?? "";
      if (content !== "") events.push(...s.assembler.feed(s.parser.push(content)));
      if (d["stop"] === true) {
        s.done = true;
        s.stopType = typeof d["stop_type"] === "string" ? d["stop_type"] : undefined;
        s.prompt = num(d["tokens_evaluated"]) ?? 0;
        // `tokens_cached` is the whole of the slot's cache (the generated tokens too), so it says nothing of the prompt; the part of the prompt that was reused is `timings.cache_n`.
        const timings = typeof d["timings"] === "object" && d["timings"] !== null ? (d["timings"] as Json) : {};
        s.cached = num(timings["cache_n"]);
        s.completion = num(d["tokens_predicted"]) ?? 0;
        events.push(...s.assembler.feed(s.parser.end(s.stopType === "limit" ? "length" : "stop")), ...s.assembler.end());
        const cachedRead = Math.min(s.cached ?? 0, s.prompt);
        s.usage = { input_tokens: s.prompt - cachedRead, output_tokens: s.completion, ...(s.cached === undefined ? {} : { cache_read_tokens: cachedRead }), raw: pick(d) };
        events.push({ type: "usage", usage: { ...s.usage } });
      }
      return events;
    },
    done: (s) => s.done,
    finish(s): Completed {
      const model = opts.observe(s.requested);
      return {
        blocks: s.assembler.blocks.filter((b): b is Block => b !== undefined),
        stop_reason: s.assembler.sawCall ? "tool_use" : s.stopType === "limit" ? "max_tokens" : "end_turn",
        usage: s.usage,
        observed: model === undefined ? {} : { model },
      };
    },
    classify({ status, body }) {
      try {
        const e = errorOf(JSON.parse(body));
        return { message: `${status} ${e.message}`, ...(e.kind === "server" ? {} : { kind: e.kind, retryable: e.retryable }) };
      } catch {
        return undefined;
      }
    },
  };
}

const pick = (d: Json): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of ["tokens_evaluated", "tokens_predicted", "tokens_cached", "stop_type", "truncated", "timings"]) if (d[k] !== undefined) out[k] = d[k];
  return out;
};

function errorOf(d: unknown): { kind: "server" | "invalid_request" | "overloaded"; retryable: boolean; message: string } {
  const e = ((d as Json | null)?.["error"] ?? d) as Json | string;
  if (typeof e === "string") return { kind: "server", retryable: false, message: e };
  const type = typeof e["type"] === "string" ? e["type"] : "error";
  const kind = type === "exceed_context_size_error" || type === "invalid_request_error" ? "invalid_request" : type === "unavailable_error" ? "overloaded" : "server";
  return { kind, retryable: kind === "overloaded", message: `${type}: ${String(e["message"] ?? "")}` };
}
