import type { Conversation } from "./conversation.ts";
import { estimateRequest } from "./estimate.ts";
import { usageRecord } from "./ledger.ts";
import { checkLimits, LimitExceeded } from "./limits.ts";
import { servedModelId, type ModelSetup } from "./setup.ts";

export interface OneShot {
  text: string;
  /** The model that answered (as the provider reported it). */
  model: string;
  usage: { input: number; output: number };
  /** The usage as an entry stores it, for the ledger. */
  record: Record<string, number>;
}

export interface OneShotOptions {
  system?: string;
  signal?: AbortSignal;
  /** Another model of the thread's provider. Its settings are not carried over. */
  model?: string;
  /** Refuse (`LimitExceeded`) when the request would break a limit in `harness.yml`, counting what the thread has spent. Default false. */
  limits?: boolean;
}

/**
 * Ask a model one question outside the transcript (a summary of a side conversation, of a range about to be compacted). Nothing is committed here:
 * the caller records what it keeps, with `record` as the usage so the ledger counts it.
 */
export async function askModel(convo: Conversation, prompt: string, opts: OneShotOptions = {}): Promise<OneShot> {
  const setup = await convo.setup();
  if (setup.model === undefined) throw new Error("this thread has no model; set one with /model");
  const model: ModelSetup = opts.model === undefined ? setup.model : { provider: setup.model.provider, id: opts.model };
  const adapter = convo.provider(model.provider);
  const context = { system: opts.system ?? "You write short, faithful summaries.", instructions: undefined, turns: [{ role: "user" as const, parts: [{ type: "text" as const, text: prompt }] }], tools: [], cacheHints: [] };
  if (opts.limits === true) {
    const config = await convo.readConfig();
    const current = convo.priceTable(model.provider);
    const pinned = setup.pricing === undefined ? undefined : await convo.priceResolver().table(setup.pricing.table);
    const table = pinned ?? current;
    const estimate = estimateRequest(context, { id: servedModelId(model), settings: model.settings }, table, convo.modelInfo(model.provider, servedModelId(model)));
    const { violations } = checkLimits({ limits: config?.ok === true ? config.value.limits : {}, ledger: await convo.ledger(), estimate });
    if (violations.length > 0) throw new LimitExceeded(violations);
  }
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  const stream = adapter.stream({ setup: { ...setup, model }, signal: ac.signal, context });
  let text = "";
  for (;;) {
    const n = await stream.next();
    if (n.done) return { text: text.trim(), model: servedModelId(model), usage: { input: n.value.usage.input_tokens, output: n.value.usage.output_tokens }, record: usageRecord(n.value.usage) };
    if (n.value.type === "text.delta") text += n.value.text;
  }
}
