import type { PriceTable } from "./pricing.ts";

/**
 * Bundled price tables. These were read from the providers' pricing pages on 2026-10-25 through a summarising tool,
 * not copied from a machine-readable source, and only for the models whose API ids are known. They are defaults:
 * check them before relying on a spending limit, and put your own in a provider's `pricing.models` in `harness.yml`.
 * A package upgrade that changes a table is a `pricing_changed` for every agent pinned to the old one (docs/providers.md, P9).
 * Cache writes are keyed by the cache lifetime in minutes.
 */

export const ANTHROPIC_PRICES: PriceTable = {
  version: 1,
  as_of: "2026-10-25",
  source: "https://platform.claude.com/docs/en/about-claude/pricing (read by a summarising tool)",
  currency: "USD",
  models: {
    "claude-fable-5-1": { rates: { standard: { input: 10, output: 50, cache_write: { 5: 12.5, 60: 20 }, cache_read: 0.25 } } },
    "claude-opus-5-5": { rates: { standard: { input: 4, output: 20, cache_write: { 5: 5, 60: 8 }, cache_read: 0.2 } } },
    "claude-sonnet-5-5": { rates: { standard: { input: 2, output: 10, cache_write: { 5: 2.5, 60: 4 }, cache_read: 0.1 } } },
    "claude-haiku-5-5": {
      rates: { standard: { input: 0.1, output: 0.5, cache_write: { 5: 0.125, 60: 0.2 }, cache_read: 0.01 } },
      long_context: { above_tokens: 100_000, rates: { standard: { input: 0.5, output: 2.5, cache_write: { 5: 0.625, 60: 1 }, cache_read: 0.05 } } },
    },
  },
};

export const OPENAI_PRICES: PriceTable = {
  version: 1,
  as_of: "2026-10-25",
  source: "https://developers.openai.com/api/docs/pricing (read by a summarising tool; tier names matched to the page's tab order, which the tool could not confirm; cache writes keyed by lifetime in minutes, 30 and 720)",
  currency: "USD",
  models: {
    "gpt-6-astra": {
      rates: {
        standard: { input: 10, cache_read: 1, cache_write: { 30: 12.5, 720: 25 }, output: 50 },
        flex: { input: 5, cache_read: 0.5, cache_write: { 30: 6.25, 720: 12.5 }, output: 25 },
        fast: { input: 20, cache_read: 2, cache_write: { 30: 25, 720: 50 }, output: 100 },
        ultrafast: { input: 60, cache_read: 6, cache_write: { 30: 75, 720: 150 }, output: 300 },
      },
    },
    "gpt-6.1-sol": {
      rates: {
        standard: { input: 2, cache_read: 0.1, cache_write: { 30: 2.5, 720: 5 }, output: 10 },
        flex: { input: 1, cache_read: 0.05, cache_write: { 30: 1.25, 720: 2.5 }, output: 5 },
        fast: { input: 4, cache_read: 0.2, cache_write: { 30: 5, 720: 10 }, output: 20 },
        ultrafast: { input: 12, cache_read: 0.6, cache_write: { 30: 15, 720: 30 }, output: 60 },
      },
    },
    "gpt-6-luna": {
      rates: {
        standard: { input: 0.1, cache_read: 0.01, cache_write: { 30: 0.125, 720: 0.25 }, output: 0.5 },
        flex: { input: 0.05, cache_read: 0.005, cache_write: { 30: 0.0625, 720: 0.125 }, output: 0.25 },
        fast: { input: 0.2, cache_read: 0.02, cache_write: { 30: 0.25, 720: 0.5 }, output: 1 },
      },
    },
    // Earlier models have no separate cache-write charge: cached reads are billed at the cached-input rate.
    "gpt-5.3-codex": {
      rates: {
        standard: { input: 1.75, cache_read: 0.175, output: 14 },
        fast: { input: 3.5, cache_read: 0.35, output: 28 },
      },
    },
  },
};

/** What is known about each model's size (from the same pages); anything else comes from `models` in the provider config. */
export const ANTHROPIC_MODELS: Record<string, { context_window: number }> = {
  "claude-fable-5-1": { context_window: 1_000_000 },
  "claude-opus-5-5": { context_window: 1_000_000 },
  "claude-sonnet-5-5": { context_window: 1_000_000 },
};
