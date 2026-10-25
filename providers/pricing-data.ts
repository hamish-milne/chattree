import type { PriceTable } from "./pricing.ts";

/**
 * Bundled price tables. These were read from the providers' pricing pages on 2026-10-25 through a summarising tool,
 * not copied from a machine-readable source, and only for the models whose API ids are known. They are defaults:
 * check them before relying on a spending limit, and put your own in a provider's `pricing.models` in `harness.yml`.
 * A package upgrade that changes a table is a `pricing_changed` for every agent pinned to the old one (docs/providers.md, P9).
 */

export const ANTHROPIC_PRICES: PriceTable = {
  version: 1,
  as_of: "2026-10-25",
  source: "https://platform.claude.com/docs/en/about-claude/pricing (read by a summarising tool; cache_write is the 5-minute rate)",
  currency: "USD",
  models: {
    "claude-fable-5-1": { rates: { input: 10, output: 50, cache_write: 12.5, cache_read: 0.25 } },
    "claude-opus-5-5": { rates: { input: 4, output: 20, cache_write: 5, cache_read: 0.2 } },
    "claude-sonnet-5-5": { rates: { input: 2, output: 10, cache_write: 2.5, cache_read: 0.1 } },
    "claude-haiku-5-5": {
      rates: { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
      long_context: { above_tokens: 100_000, rates: { input: 0.5, output: 2.5, cache_write: 0.625, cache_read: 0.05 } },
    },
  },
};

export const OPENAI_PRICES: PriceTable = {
  version: 1,
  as_of: "2026-10-25",
  source: "https://developers.openai.com/api/docs/pricing (read by a summarising tool; tier names matched to the page's tab order)",
  currency: "USD",
  models: {
    "gpt-6-astra": { rates: { input: 10, cache_read: 1, output: 50 }, tiers: { flex: { input: 5, cache_read: 0.5, output: 25 }, fast: { input: 20, cache_read: 2, output: 100 }, ultrafast: { input: 60, cache_read: 6, output: 300 } } },
    "gpt-6.1-sol": { rates: { input: 2, cache_read: 0.1, output: 10 }, tiers: { flex: { input: 1, cache_read: 0.05, output: 5 }, fast: { input: 4, cache_read: 0.2, output: 20 }, ultrafast: { input: 12, cache_read: 0.6, output: 60 } } },
    "gpt-6-luna": { rates: { input: 0.1, cache_read: 0.01, output: 0.5 }, tiers: { flex: { input: 0.05, cache_read: 0.005, output: 0.25 }, fast: { input: 0.2, cache_read: 0.02, output: 1 } } },
  },
};

/** What is known about each model's size (from the same pages); anything else comes from `models` in the provider config. */
export const ANTHROPIC_MODELS: Record<string, { context_window: number }> = {
  "claude-fable-5-1": { context_window: 1_000_000 },
  "claude-opus-5-5": { context_window: 1_000_000 },
  "claude-sonnet-5-5": { context_window: 1_000_000 },
};
