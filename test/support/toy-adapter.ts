import type { Block } from "../../harness/context-builder.ts";
import { httpStream, type HttpMapper, type HttpOptions } from "../../providers/http.ts";
import { ProviderError, type Completed, type ErrorKind, type ProviderAdapter, type StreamEvent, type Usage } from "../../providers/types.ts";

/**
 * A made-up provider protocol, just rich enough to exercise the HTTP base and the conformance checks.
 *
 *   event: start       {"model": "toy-1", "id": "r1"}
 *   event: text        {"i": 0, "t": "hello"}
 *   event: think       {"i": 1, "t": "hmm", "sig": "S"}      (sig present on the closing think event)
 *   event: tool        {"i": 2, "id": "c1", "name": "run"}   starts a tool call
 *   event: args        {"i": 2, "a": "{\"x\":"}
 *   event: end         {"i": 0}                               completes a block
 *   event: usage       {"in": 10, "out": 3}                   cumulative
 *   event: done        {"stop": "end_turn"}
 *   event: error       {"kind": "overloaded", "message": "..."}
 */
interface ToyState {
  blocks: Map<number, { type: "text" | "reasoning" | "tool_call"; text: string; sig?: string; id?: string; name?: string; args: string }>;
  out: Block[];
  usage: Usage;
  model: string | undefined;
  id: string | undefined;
  stop: string | undefined;
}

const json = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    throw new ProviderError({ kind: "protocol", message: `malformed event: ${s.slice(0, 80)}` });
  }
};

export const toyMapper = (baseUrl: string): HttpMapper<ToyState> => ({
  request: (req) => ({ url: `${baseUrl}/v1/stream`, headers: { "content-type": "application/json" }, body: { model: req.setup.model?.id ?? "toy-1", turns: req.context.turns.length } }),
  start: () => ({ blocks: new Map(), out: [], usage: { input_tokens: 0, output_tokens: 0 }, model: undefined, id: undefined, stop: undefined }),
  event(sse, s): StreamEvent[] {
    const d = json(sse.data);
    const i = d["i"] as number;
    switch (sse.event) {
      case "start":
        s.model = d["model"] as string;
        s.id = d["id"] as string;
        return [{ type: "started" }, { type: "observed", observed: { model: s.model, response_id: s.id } }];
      case "text":
      case "think": {
        const type = sse.event === "text" ? "text" : "reasoning";
        const b = s.blocks.get(i) ?? { type, text: "", args: "" };
        b.text += d["t"] as string;
        if (typeof d["sig"] === "string") b.sig = d["sig"];
        s.blocks.set(i, b);
        return [{ type: type === "text" ? "text.delta" : "reasoning.delta", index: i, text: d["t"] as string }];
      }
      case "tool":
        s.blocks.set(i, { type: "tool_call", text: "", id: d["id"] as string, name: d["name"] as string, args: "" });
        return [{ type: "tool_call.start", index: i, call_id: d["id"] as string, name: d["name"] as string }];
      case "args": {
        const b = s.blocks.get(i);
        if (b === undefined) throw new ProviderError({ kind: "protocol", message: `args for unknown block ${i}` });
        b.args += d["a"] as string;
        return [{ type: "tool_call.delta", index: i, args_delta: d["a"] as string }];
      }
      case "end": {
        const b = s.blocks.get(i);
        if (b === undefined) throw new ProviderError({ kind: "protocol", message: `end of unknown block ${i}` });
        let block: Block;
        if (b.type === "text") block = { type: "text", text: b.text };
        else if (b.type === "reasoning") block = { type: "reasoning", provider: "toy", payload: b.sig ?? "", visible: b.text };
        else {
          try {
            block = { type: "tool_call", call_id: b.id as string, name: b.name as string, args: JSON.parse(b.args || "{}") as Record<string, unknown> };
          } catch {
            block = { type: "tool_call", call_id: b.id as string, name: b.name as string, args: {}, args_raw: b.args };
          }
        }
        s.out[i] = block;
        return [{ type: "block.done", index: i, block }];
      }
      case "usage":
        s.usage = { input_tokens: d["in"] as number, output_tokens: d["out"] as number };
        return [{ type: "usage", usage: s.usage }];
      case "done":
        s.stop = d["stop"] as string;
        return [];
      case "error":
        throw new ProviderError({ kind: d["kind"] as ErrorKind, message: d["message"] as string, retryable: d["kind"] === "overloaded" });
      default:
        return []; // unknown events are tolerated
    }
  },
  done: (s) => s.stop !== undefined,
  finish: (s): Completed => ({ blocks: s.out.filter((b) => b !== undefined), stop_reason: s.stop as string, usage: s.usage, observed: { ...(s.model === undefined ? {} : { model: s.model }), ...(s.id === undefined ? {} : { response_id: s.id }) } }),
});

export const toyAdapter = (baseUrl: string, http: HttpOptions = {}): ProviderAdapter => ({
  $tag: "toy",
  stream: (req) => httpStream(toyMapper(baseUrl), req, http),
});

/** SSE text for the toy protocol. */
export const sse = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const HELLO = [
  sse("start", { model: "toy-1-2026", id: "r1" }),
  sse("usage", { in: 10, out: 0 }),
  sse("text", { i: 0, t: "Hel" }),
  ": ping\n\n",
  sse("text", { i: 0, t: "lo" }),
  sse("end", { i: 0 }),
  sse("tool", { i: 1, id: "c1", name: "run" }),
  sse("args", { i: 1, a: '{"x":' }),
  sse("args", { i: 1, a: "1}" }),
  sse("end", { i: 1 }),
  sse("usage", { in: 10, out: 7 }),
  sse("done", { stop: "tool_use" }),
];
