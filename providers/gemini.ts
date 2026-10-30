import { z } from "zod";
import { defineAdapter, commonProviderFields, envName, httpOptionsFor, modelsFor, pricesFor, type ModelInfo } from "./registry.ts";
import { compatibleSettings, openaiCompatibleAdapter } from "./openai-compatible.ts";
import type { ModelPrice, PriceTable } from "./pricing.ts";
import { GEMINI_ROWS } from "./catalog/gemini-rows.ts";

/**
 * The Gemini API through its OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai): Chat Completions with
 * streaming, tools and `reasoning_effort`. Authenticated with an API key from Google AI Studio (not a Google account sign-in: Google
 * does not allow third-party tools to use the Gemini CLI's OAuth). A key on the free tier costs nothing, and Google may use what it
 * is sent to improve its products: set `pricing: { free: true }` on the provider so the ledger shows no cost.
 *
 * What it adds to `openai-compatible`: the base URL and the catalog (names, prices, and the token limits the model list reports).
 * The compatibility layer is documented as beta; `node tools/live-check.ts --flavor openai-compatible --base-url <GEMINI_BASE> --model gemini-3.8-flash --api-key-env GEMINI_API_KEY` says whether tool calls and reasoning round-trip.
 */
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

export interface GeminiRow {
  id: string;
  name: string;
  tier: "low" | "medium" | "high";
  /** From the model list (`inputTokenLimit`, `outputTokenLimit`); absent until the catalog has been refreshed. */
  context?: number;
  output?: number;
  price: { input: number; output: number; cache_read?: number };
  long?: { above_tokens: number; input: number; output: number; cache_read?: number };
  free_tier: boolean;
}

export function geminiCatalogFrom(rows: readonly GeminiRow[], asOf: string): { models: Record<string, ModelInfo>; prices: PriceTable } {
  const models: Record<string, ModelInfo> = {};
  const prices: Record<string, ModelPrice> = {};
  for (const r of rows) {
    models[r.id] = {
      ...(r.context === undefined ? {} : { context_window: r.context }),
      ...(r.output === undefined ? {} : { max_output_tokens: r.output }),
      description: `${r.name}.${r.free_tier ? " Has a free tier." : ""}`,
      cost_tier: r.tier,
      reasoning: { low: { reasoning_effort: "low" }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" } },
    };
    const rate = (p: { input: number; output: number; cache_read?: number }) => ({ input: p.input, output: p.output, ...(p.cache_read === undefined ? {} : { cache_read: p.cache_read }) });
    prices[r.id] = { rates: { standard: rate(r.price) }, ...(r.long === undefined ? {} : { long_context: { above_tokens: r.long.above_tokens, rates: { standard: rate(r.long) } } }) };
  }
  return { models, prices: { version: 1, as_of: asOf, source: "https://ai.google.dev/gemini-api/docs/pricing (paid Standard tier, read through a summarising tool)", currency: "USD", models: prices } };
}

export const GEMINI_CATALOG = geminiCatalogFrom(GEMINI_ROWS, "2026-10-30");

const geminiConfig = z.strictObject({
  $tag: z.literal("gemini"),
  /** The NAME of the environment variable holding the Google AI Studio API key. */
  api_key_env: envName,
  /** Default `https://generativelanguage.googleapis.com/v1beta/openai`. */
  base_url: z.string().url().optional(),
  max_tokens_param: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  include_usage: z.boolean().optional(),
  ...commonProviderFields,
});

export const geminiDefinition = defineAdapter({
  $tag: "gemini",
  config: geminiConfig,
  settings: compatibleSettings,
  jsonSchema: () => ({ config: z.toJSONSchema(geminiConfig, { io: "input" }), settings: z.toJSONSchema(compatibleSettings, { io: "input" }) }),
  secrets: (c) => [c.api_key_env],
  prices: (c) => pricesFor(GEMINI_CATALOG.prices, c),
  models: (c) => modelsFor(GEMINI_CATALOG.models, c),
  create: (c, secrets) => {
    const key = secrets.get(c.api_key_env);
    const adapter = openaiCompatibleAdapter({
      baseUrl: c.base_url ?? GEMINI_BASE,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(c.max_tokens_param === undefined ? {} : { maxTokensParam: c.max_tokens_param }),
      ...(c.include_usage === undefined ? {} : { includeUsage: c.include_usage }),
      http: httpOptionsFor(c),
    });
    return { ...adapter, $tag: "gemini" };
  },
});
