import type { Conversation } from "../harness/conversation.ts";
import { servedModelId } from "../harness/setup.ts";

export interface OneShot {
  text: string;
  model: string;
  usage: { input: number; output: number };
}

/**
 * Ask the thread's model one question outside the transcript (a summary of a side conversation, of a range about to be
 * compacted). Nothing is committed and it is not in the ledger: the caller shows the usage and records what it decides to keep.
 */
export async function askModel(convo: Conversation, prompt: string, opts: { system?: string; signal?: AbortSignal } = {}): Promise<OneShot> {
  const setup = await convo.setup();
  if (setup.model === undefined) throw new Error("this thread has no model; set one with /model");
  const adapter = convo.provider(setup.model.provider);
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  const stream = adapter.stream({
    setup,
    signal: ac.signal,
    context: { system: opts.system ?? "You write short, faithful summaries.", instructions: undefined, turns: [{ role: "user", parts: [{ type: "text", text: prompt }] }], tools: [], cacheHints: [] },
  });
  let text = "";
  for (;;) {
    const n = await stream.next();
    if (n.done) return { text: text.trim(), model: servedModelId(setup.model), usage: { input: n.value.usage.input_tokens, output: n.value.usage.output_tokens } };
    if (n.value.type === "text.delta") text += n.value.text;
  }
}
