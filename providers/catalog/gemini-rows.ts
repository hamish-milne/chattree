import type { GeminiRow } from "../gemini.ts";

/**
 * The Gemini API's chat models as of 2026-10-30. Prices are the paid Standard tier (USD per million tokens) from
 * https://ai.google.dev/gemini-api/docs/pricing, read through a summarising tool. Token limits are not on those pages: they come from
 * `GET /v1beta/models` with `npm run catalog -- gemini` (needs GEMINI_API_KEY), which fills `context` and `output`.
 * Prices that change on a date: gemini-4-argon doubles on 2026-12-01 (input 4, output 20, cache read 0.2) and the two Flash models
 * on 2027-01-01 (input 1.5, output 7.5, cache read 0.15). A key on the free tier pays nothing: set `pricing: { free: true }` on the provider.
 */
export const GEMINI_ROWS: readonly GeminiRow[] = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", tier: "high", price: { input: 2, output: 10, cache_read: 0.1 }, free_tier: false },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", tier: "medium", price: { input: 0.75, output: 3.75, cache_read: 0.075 }, free_tier: true },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", tier: "medium", price: { input: 0.75, output: 3.75, cache_read: 0.075 }, free_tier: true },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", tier: "low", price: { input: 0.3, output: 2.5, cache_read: 0.03 }, free_tier: true },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", tier: "low", price: { input: 0.25, output: 1.5, cache_read: 0.025 }, free_tier: true },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", tier: "high", price: { input: 2, output: 12, cache_read: 0.2 }, long: { above_tokens: 200_000, input: 4, output: 18, cache_read: 0.4 }, free_tier: false },
];
