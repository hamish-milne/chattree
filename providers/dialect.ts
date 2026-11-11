import { randomUUID } from "node:crypto";
import type { Block, ModelContext } from "../harness/context-builder.ts";
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
  /** `args` when the dialect parsed them; `raw` when it only has the text (parsed as JSON here, else kept as `args_raw`); neither: the deltas so far are the text. */
  | { kind: "call.end"; args?: Record<string, unknown>; raw?: string };

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
}

export interface Rendered {
  prompt: string;
  /** Strings that end generation, besides the model's own end tokens. */
  stop: string[];
}

export interface Dialect {
  /** Recorded in the setup; never changes meaning once released, like a renderer's id. */
  id: string;
  render(input: RenderInput): Rendered;
  /** `tools` give the types of arguments a format writes as text; `prompt` is what was rendered, whose ending says whether the model starts inside its thinking. */
  parser(options: Record<string, unknown>, tools: readonly ToolDefinition[], prompt: string): Parser;
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
    else if (end?.args !== undefined) block = { type: "tool_call", call_id: o.id, name: o.name, args: end.args };
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
const OWNED = new Set(["model", "prompt", "stream", "n_predict", "stop", "cache_prompt", "special"]);
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
}

interface State {
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

export function completionMapper(opts: CompletionOptions, settings: (req: StreamRequest) => DialectSettings): HttpMapper<State> {
  const rendered = new WeakMap<StreamRequest, Rendered>();
  const renderFor = (req: StreamRequest, s: DialectSettings): Rendered => {
    const served = servedModelId(req.setup.model!);
    return opts.dialects.get(s.dialect).render({ context: req.context, options: s.dialect_options ?? {}, effort: s.reasoning_effort, date: opts.today(), provider: req.setup.model!.provider, model: served });
  };
  return {
    request(req: StreamRequest): HttpRequestSpec {
      const s = settings(req);
      if (req.setup.model === undefined) throw new ProviderError({ kind: "invalid_request", message: "the agent has no model" });
      for (const t of req.context.turns) {
        if (t.role === "user" && t.parts.some((p) => p.type === "attachment")) throw new ProviderError({ kind: "invalid_request", message: `dialect "${s.dialect}" takes text only: attachments cannot be sent` });
      }
      const served = servedModelId(req.setup.model);
      const r = renderFor(req, s);
      rendered.set(req, r);
      const body: Json = { model: opts.modelName(served), prompt: r.prompt, stream: true, cache_prompt: true, special: true, n_predict: s.max_output_tokens };
      const stop = [...(s.stop ?? []), ...r.stop];
      if (stop.length > 0) body["stop"] = stop;
      for (const k of ["temperature", "top_p", "seed"] as const) if (s[k] !== undefined) body[k] = s[k];
      for (const [k, v] of Object.entries(s.extra ?? {})) if (!OWNED.has(k)) body[k] = v;
      return { url: `${opts.baseUrl.replace(/\/$/, "")}/completion`, headers: { "content-type": "application/json", accept: "text/event-stream" }, body };
    },
    start(req) {
      const s = settings(req);
      const served = servedModelId(req.setup.model!);
      return {
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
      if (typeof d["content"] === "string" && d["content"] !== "") events.push(...s.assembler.feed(s.parser.push(d["content"])));
      if (d["stop"] === true) {
        s.done = true;
        s.stopType = typeof d["stop_type"] === "string" ? d["stop_type"] : undefined;
        s.prompt = num(d["tokens_evaluated"]) ?? 0;
        s.cached = num(d["tokens_cached"]);
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
  for (const k of ["tokens_evaluated", "tokens_predicted", "tokens_cached", "stop_type", "truncated"]) if (d[k] !== undefined) out[k] = d[k];
  return out;
};

function errorOf(d: unknown): { kind: "server" | "invalid_request" | "overloaded"; retryable: boolean; message: string } {
  const e = ((d as Json | null)?.["error"] ?? d) as Json | string;
  if (typeof e === "string") return { kind: "server", retryable: false, message: e };
  const type = typeof e["type"] === "string" ? e["type"] : "error";
  const kind = type === "exceed_context_size_error" || type === "invalid_request_error" ? "invalid_request" : type === "unavailable_error" ? "overloaded" : "server";
  return { kind, retryable: kind === "overloaded", message: `${type}: ${String(e["message"] ?? "")}` };
}
