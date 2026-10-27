import { z } from "zod";
import type { Issue } from "../src/errors.ts";
import type { StandardSchemaV1 } from "../src/standard-schema.ts";
import { Limiter, type HttpOptions } from "./http.ts";
import { effectiveTable, emptyTable, pricingConfig, type PriceTable } from "./pricing.ts";
import type { ProviderAdapter } from "./types.ts";

/**
 * Adapters register by `$tag`, like entry types do (docs/providers.md, P6). A provider in `harness.yml` names its
 * adapter with `$tag` (or `!tag`); the adapter's own schema validates the rest; the loader builds it after resolving
 * the secrets it names. The schemas are Standard Schema, so a third-party adapter is not tied to one library, and
 * each adapter must be able to emit JSON Schema for the editor.
 */

/**
 * How tool definitions must be written for the model to see and fill them properly (docs/tools.md, 3.7). `full`: any
 * JSON Schema in the portable subset, nested objects and lists of objects included. `flat`: the model is shown only a
 * tool's top-level properties with their types and descriptions (some servers, such as Ollama for gpt-oss, print a list as
 * `any[]` and an object as `Record<string, any>`), so a tool must have scalar properties only. Reserved, not built: `text`
 * (calls written as text for models with no native tool calling) and `raw` (one unescaped text argument).
 */
export const TOOL_CONVENTIONS = ["full", "flat"] as const;
export type ToolConvention = (typeof TOOL_CONVENTIONS)[number];

/** What is known about a model. Unknown fields are unknown; the harness only warns on what it can tell. */
export interface ModelInfo {
  context_window?: number | undefined;
  max_output_tokens?: number | undefined;
  /** Default `full`. Measured by the `tools-nesting` live check, or set in `harness.yml`. */
  tool_convention?: ToolConvention | undefined;
}

export interface AdapterDefinition<C extends { $tag: string } = { $tag: string }> {
  readonly $tag: string;
  /** The provider's keys in `harness.yml`, `$tag` included. Strict: a misspelt key is an error. */
  readonly config: StandardSchemaV1<unknown, C>;
  /** The model settings this adapter accepts (`agent_setup.model.settings`). */
  readonly settings: StandardSchemaV1;
  jsonSchema(): { config: object; settings: object };
  /** The names of the environment variables this provider needs. Each must resolve, or `open` fails naming it. */
  secrets(config: C): readonly string[];
  create(config: C, secrets: { get(name: string): string | undefined }): ProviderAdapter;
  /** The prices this provider is costed under: the bundled table with the config's overrides on top. Without it every price is unknown. */
  prices?(config: C): PriceTable;
  /** The models it knows about, with the config's overrides on top. */
  models?(config: C): Record<string, ModelInfo>;
}

export function defineAdapter<C extends { $tag: string }>(def: AdapterDefinition<C>): AdapterDefinition<C> {
  return def;
}

export class AdapterRegistry {
  readonly #defs = new Map<string, AdapterDefinition>();

  register<C extends { $tag: string }>(def: AdapterDefinition<C>): this {
    if (this.#defs.has(def.$tag)) throw new Error(`an adapter for $tag ${def.$tag} is already registered`);
    if (!/^[a-z][a-z0-9-]*$/.test(def.$tag)) throw new Error(`invalid adapter $tag ${JSON.stringify(def.$tag)}`);
    this.#defs.set(def.$tag, def as unknown as AdapterDefinition);
    return this;
  }
  get(tag: string): AdapterDefinition | undefined {
    return this.#defs.get(tag);
  }
  tags(): string[] {
    return [...this.#defs.keys()].sort();
  }
}

// ---- what every HTTP provider config shares -------------------------------------------------------------------------

/** The name of an environment variable. A key pasted here by mistake is refused, never stored. */
export const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be the NAME of an environment variable (letters, digits and _), not the key itself");

export const commonProviderFields = {
  /** At most this many requests at once for the provider. */
  max_concurrent: z.number().int().positive().optional(),
  timeouts: z.strictObject({ idle_ms: z.number().int().positive().optional(), total_ms: z.number().int().positive().optional() }).optional(),
  /** Attempts per request, retries included (only before any content has arrived). */
  max_attempts: z.number().int().positive().optional(),
  /** Price overrides, or `free: true` for a local server. Without either, a model with no bundled price has an unknown price. */
  pricing: pricingConfig.optional(),
  /** What you know about models the adapter does not (context window, maximum output, how tools must be written: `tool_convention` `full` or `flat`). */
  models: z.record(z.string(), z.strictObject({ context_window: z.number().int().positive().optional(), max_output_tokens: z.number().int().positive().optional(), tool_convention: z.enum(TOOL_CONVENTIONS).optional() })).optional(),
};

export interface CommonProviderConfig {
  pricing?: z.infer<typeof pricingConfig> | undefined;
  models?: Record<string, ModelInfo> | undefined;
  max_concurrent?: number | undefined;
  timeouts?: { idle_ms?: number | undefined; total_ms?: number | undefined } | undefined;
  max_attempts?: number | undefined;
}

export function httpOptionsFor(c: CommonProviderConfig): HttpOptions {
  return {
    ...(c.max_concurrent === undefined ? {} : { limiter: new Limiter(c.max_concurrent) }),
    ...(c.timeouts === undefined ? {} : { timeouts: { ...(c.timeouts.idle_ms === undefined ? {} : { idleMs: c.timeouts.idle_ms }), ...(c.timeouts.total_ms === undefined ? {} : { totalMs: c.timeouts.total_ms }) } }),
    ...(c.max_attempts === undefined ? {} : { retry: { maxAttempts: c.max_attempts } }),
  };
}

/** For an adapter definition: the bundled table (if any) with this provider's overrides. */
export const pricesFor = (bundled: PriceTable | undefined, c: CommonProviderConfig): PriceTable => effectiveTable(bundled, c.pricing);
export const modelsFor = (bundled: Record<string, ModelInfo> | undefined, c: CommonProviderConfig): Record<string, ModelInfo> => ({ ...bundled, ...c.models });

// ---- validating and building ---------------------------------------------------------------------------------------

const where = (name: string, path: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined): string => ["providers", name, ...(path ?? []).map((p) => String(typeof p === "object" ? p.key : p))].join(".");

/** Validate every provider against its adapter's schema. The values are the parsed `providers` of the config. */
export async function validateProviders(providers: Record<string, { $tag: string }>, registry: AdapterRegistry): Promise<{ issues: Issue[]; configs: Map<string, { def: AdapterDefinition; config: { $tag: string } }> }> {
  const issues: Issue[] = [];
  const configs = new Map<string, { def: AdapterDefinition; config: { $tag: string } }>();
  for (const [name, p] of Object.entries(providers)) {
    const def = registry.get(p.$tag);
    if (def === undefined) {
      issues.push({ path: `providers.${name}.$tag`, message: `no adapter for ${JSON.stringify(p.$tag)} (known: ${registry.tags().join(", ") || "none"})` });
      continue;
    }
    const r = await def.config["~standard"].validate(p);
    if (r.issues !== undefined) for (const i of r.issues) issues.push({ path: where(name, i.path), message: i.message });
    else configs.set(name, { def, config: r.value as { $tag: string } });
  }
  return { issues, configs };
}

export class ProviderSetupError extends Error {
  override name = "ProviderSetupError";
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`provider configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.issues = issues;
  }
}

export interface BuiltProviders {
  adapters: Map<string, ProviderAdapter>;
  /** The effective price table of each provider, by provider name. */
  prices: Map<string, PriceTable>;
  models: Map<string, Record<string, ModelInfo>>;
  /** The resolved secret values (for redaction and scrubbing). Never log these. */
  secretValues: string[];
}

/**
 * Build the adapters. Everything wrong is reported at once: unknown tags, invalid keys, and every environment
 * variable that is not set (naming the provider that needs it).
 */
export async function buildProviders(providers: Record<string, { $tag: string }>, registry: AdapterRegistry, secrets: { get(name: string): Promise<string | undefined> }): Promise<BuiltProviders> {
  const { issues, configs } = await validateProviders(providers, registry);
  const values = new Map<string, string>();
  for (const [name, { def, config }] of configs) {
    for (const env of def.secrets(config as never)) {
      if (values.has(env)) continue;
      const v = await secrets.get(env);
      if (v === undefined || v === "") issues.push({ path: `providers.${name}`, message: `the environment variable ${env} is not set (and is not in the repository's secrets file)` });
      else values.set(env, v);
    }
  }
  if (issues.length > 0) throw new ProviderSetupError(issues);
  const adapters = new Map<string, ProviderAdapter>();
  const prices = new Map<string, PriceTable>();
  const models = new Map<string, Record<string, ModelInfo>>();
  for (const [name, { def, config }] of configs) {
    adapters.set(name, def.create(config as never, { get: (n) => values.get(n) }));
    prices.set(name, def.prices?.(config as never) ?? emptyTable());
    models.set(name, def.models?.(config as never) ?? {});
  }
  return { adapters, prices, models, secretValues: [...values.values()] };
}
