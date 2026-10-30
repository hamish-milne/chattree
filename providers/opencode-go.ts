import { z } from "zod";
import { defineAdapter, commonProviderFields, envName, httpOptionsFor, modelsFor, pricesFor, type ModelInfo } from "./registry.ts";
import { compatibleSettings, openaiCompatibleAdapter } from "./openai-compatible.ts";
import type { ModelPrice, PriceTable } from "./pricing.ts";
import { OPENCODE_GO_ROWS } from "./catalog/opencode-go-rows.ts";

/**
 * OpenCode Go (https://opencode.ai/docs/en/go/): a flat monthly plan whose gateway serves many models. It speaks Chat Completions,
 * Responses, Messages and generate-content, and translates any text model to the others, so this provider uses Chat Completions for
 * every model: one request shape, one settings schema. A model's own style is in the catalog (`GoRow.api`); to use `messages` for a
 * Claude model, point an `anthropic` provider at `<base>/anthropic` (docs/providers.md).
 *
 * What it adds to `openai-compatible`: the gateway's base URL, the `x-opencode-session` header (a stable id per thread, which the
 * gateway uses for caching: without it the allowance is spent faster), and the catalog: context windows, output limits, reasoning
 * levels and prices of its models. The service's terms are the user's to follow (docs/providers.md).
 */
export const OPENCODE_GO_BASE = "https://opencode.ai/inference/go";
export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

export type GoApi = "chat-completions" | "responses" | "messages" | "generate-content";

/** One model of the gateway's list, as kept in the snapshot (`catalog/opencode-go-rows.ts`). Prices are per million tokens. */
export interface GoRow {
  id: string;
  name: string;
  api: GoApi;
  context: number;
  output: number;
  input_limit?: number;
  price: { input: number; output: number; cache_read?: number; cache_write?: number };
  long?: { above_tokens: number; input: number; output: number; cache_read?: number; cache_write?: number };
  efforts: string[];
  images: boolean;
  open_weights: boolean;
}

const costTier = (input: number): "low" | "medium" | "high" => (input <= 0.5 ? "low" : input <= 2.5 ? "medium" : "high");

/** The catalog, the price table and each model's native API, from rows. */
export function catalogFrom(rows: readonly GoRow[], asOf: string): { models: Record<string, ModelInfo>; prices: PriceTable; api: Record<string, GoApi> } {
  const models: Record<string, ModelInfo> = {};
  const prices: Record<string, ModelPrice> = {};
  const api: Record<string, GoApi> = {};
  for (const r of rows) {
    api[r.id] = r.api;
    const reasoning = Object.fromEntries(r.efforts.map((e) => [e === "none" ? "off" : e, { reasoning_effort: e }]));
    models[r.id] = {
      context_window: r.context,
      max_output_tokens: r.output,
      description: `${r.name}${r.open_weights ? " (open weights)" : ""}.`,
      cost_tier: costTier(r.price.input),
      ...(r.efforts.length > 0 ? { reasoning } : {}),
    };
    prices[r.id] =
      r.price.input === 0 && r.price.output === 0
        ? { free: true }
        : {
            rates: { standard: { input: r.price.input, output: r.price.output, ...(r.price.cache_read === undefined ? {} : { cache_read: r.price.cache_read }), ...(r.price.cache_write === undefined ? {} : { cache_write: r.price.cache_write }) } },
            ...(r.long === undefined ? {} : { long_context: { above_tokens: r.long.above_tokens, rates: { standard: { input: r.long.input, output: r.long.output, ...(r.long.cache_read === undefined ? {} : { cache_read: r.long.cache_read }), ...(r.long.cache_write === undefined ? {} : { cache_write: r.long.cache_write }) } } } }),
          };
  }
  return { models, prices: { version: 1, as_of: asOf, source: `${OPENCODE_GO_BASE}/v1/models (read through a summarising tool; the unit is assumed to be USD per million tokens)`, currency: "USD", models: prices }, api };
}

export const OPENCODE_GO_CATALOG = catalogFrom(OPENCODE_GO_ROWS, "2026-10-30");

const opencodeGoConfig = z.strictObject({
  $tag: z.literal("opencode-go"),
  /** The NAME of the environment variable holding the key from the OpenCode console. */
  api_key_env: envName,
  /** Default `https://opencode.ai/inference/go/openai/v1`. */
  base_url: z.string().url().optional(),
  max_tokens_param: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  include_usage: z.boolean().optional(),
  ...commonProviderFields,
});

export const opencodeGoDefinition = defineAdapter({
  $tag: "opencode-go",
  config: opencodeGoConfig,
  settings: compatibleSettings,
  jsonSchema: () => ({ config: z.toJSONSchema(opencodeGoConfig, { io: "input" }), settings: z.toJSONSchema(compatibleSettings, { io: "input" }) }),
  secrets: (c) => [c.api_key_env],
  prices: (c) => pricesFor(OPENCODE_GO_CATALOG.prices, c),
  models: (c) => modelsFor(OPENCODE_GO_CATALOG.models, c),
  create: (c, secrets) => {
    const key = secrets.get(c.api_key_env);
    const adapter = openaiCompatibleAdapter({
      baseUrl: c.base_url ?? `${OPENCODE_GO_BASE}/openai/v1`,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(c.max_tokens_param === undefined ? {} : { maxTokensParam: c.max_tokens_param }),
      ...(c.include_usage === undefined ? {} : { includeUsage: c.include_usage }),
      http: httpOptionsFor({ ...c, session_header: c.session_header ?? OPENCODE_GO_SESSION_HEADER }),
    });
    return { ...adapter, $tag: "opencode-go" };
  },
});
